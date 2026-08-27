"""Router-Maestro-local ``web_search`` tool.

Anthropic's hosted ``web_search`` server tool is not executable by every
upstream — GitHub Copilot's model endpoints reject it outright ("The use of the
web search tool is not supported."). This module lets Router-Maestro run the
search itself:

    client --(tools=[web_search_20250305])--> Router-Maestro
    Router-Maestro --(function tool "web_search")--> upstream model
    upstream model --(tool_use)--> Router-Maestro
    Router-Maestro --(search backend)--> results
    Router-Maestro --(tool_result)--> upstream model --> final answer

The loop runs entirely server-side; the client never sees the tool traffic.

Searches run against the ``web_search`` tool on GitHub's remote MCP server
(``https://api.githubcopilot.com/mcp/``) — the same Bing-backed tool the GitHub
Copilot CLI uses. It reuses the GitHub Copilot OAuth credential Router-Maestro
already stores, so it needs no extra API key and no extra quota. Note the tool
lives outside the server's default toolset, so the ``X-MCP-Toolsets: all``
header is required.

Credentials are never logged, persisted here, or echoed to clients.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from router_maestro.config.priorities import WebSearchConfig

logger = logging.getLogger(__name__)

# Name exposed to the upstream model. Anthropic clients declare the hosted tool
# as {"type": "web_search_20250305", "name": "web_search"}; we keep the same
# name so prompts and system reminders referencing it stay coherent.
WEB_SEARCH_TOOL_NAME = "web_search"

GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/"
MCP_PROTOCOL_VERSION = "2025-06-18"
# web_search is not part of the MCP server's default toolset; without this
# header the server advertises 47 GitHub-only tools and web_search is absent.
GITHUB_MCP_TOOLSETS = "all"

COPILOT_PROVIDER_NAME = "github-copilot"

# Anthropic hosted server-tool type prefix, e.g. "web_search_20250305".
_SERVER_TOOL_TYPE_PREFIX = "web_search"

WEB_SEARCH_TOOL_DESCRIPTION = (
    "Search the public web for current information. Use this when the answer "
    "depends on recent events, releases, prices, documentation, or anything "
    "that may have changed after your knowledge cutoff. Returns an answer "
    "summarising current sources, with citation URLs."
)

WEB_SEARCH_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": (
                "A clear, specific, standalone question that requires up-to-date "
                "information from the web. Focus on a single topic; call the tool "
                "again for additional questions."
            ),
        }
    },
    "required": ["query"],
}


class WebSearchError(Exception):
    """Raised when a search cannot be executed.

    Carries only a client-safe message; never includes credentials.
    """


@dataclass(frozen=True)
class SearchCitation:
    """One source backing a search answer."""

    title: str
    url: str


@dataclass(frozen=True)
class SearchOutcome:
    """A completed search: text for the model, plus structured sources.

    ``text`` is what goes back to the model as a ``tool_result``. ``citations``
    additionally feed the native ``web_search_tool_result`` blocks emitted to the
    client, so they must stay structured rather than being folded into the text.
    """

    text: str
    citations: list[SearchCitation] = field(default_factory=list)


class SearchBackend(Protocol):
    """A search implementation returning text plus structured sources."""

    async def search(self, query: str) -> SearchOutcome: ...


def is_server_web_search_tool(tool: Any) -> bool:
    """Return True if ``tool`` declares Anthropic's hosted web_search server tool.

    Matches any dated variant (``web_search_20250305`` and successors) as well
    as a bare ``web_search`` type. Tools carrying an ``input_schema`` are treated
    as ordinary client-side function tools and are left alone.
    """
    tool_type = _tool_field(tool, "type")
    if not isinstance(tool_type, str) or not tool_type.startswith(_SERVER_TOOL_TYPE_PREFIX):
        return False
    # A client-side function tool defines its own schema; a server tool does not.
    return _tool_field(tool, "input_schema") is None


def _tool_field(tool: Any, field: str) -> Any:
    """Read a field from a dict-or-model tool declaration."""
    if isinstance(tool, dict):
        return tool.get(field)
    return getattr(tool, field, None)


def local_tool_definition() -> dict[str, Any]:
    """Anthropic-shaped tool definition advertised to the upstream model."""
    return {
        "name": WEB_SEARCH_TOOL_NAME,
        "description": WEB_SEARCH_TOOL_DESCRIPTION,
        "input_schema": WEB_SEARCH_INPUT_SCHEMA,
    }


# --- credential resolution -------------------------------------------------


def resolve_github_token(*, credential_repository: Any | None = None) -> str | None:
    """Read the GitHub OAuth token from the stored Copilot credential.

    This is the same credential minted by ``router-maestro auth login
    github-copilot``; the MCP server accepts it directly, so enabling web
    search needs no additional secret.
    """
    try:
        if credential_repository is None:
            from router_maestro.auth.repository import CredentialRepository

            credential_repository = CredentialRepository()
        credential = credential_repository.get_provider(COPILOT_PROVIDER_NAME)
    except Exception:  # noqa: BLE001 - a missing/unreadable store just disables the feature
        logger.warning("Could not read the GitHub Copilot credential for web_search")
        return None
    # OAuth credentials keep the long-lived GitHub user token in ``refresh``;
    # ``access`` holds the short-lived Copilot API token, which the MCP server
    # does not accept.
    token = getattr(credential, "refresh", None)
    return token if isinstance(token, str) and token else None


def is_active(
    config: WebSearchConfig,
    *,
    credential_repository: Any | None = None,
) -> bool:
    """Return True when the local web_search tool is enabled and usable."""
    if not config.enabled:
        return False
    if resolve_github_token(credential_repository=credential_repository) is None:
        logger.warning(
            "web_search is enabled but no GitHub Copilot credential is available; "
            "run 'router-maestro auth login github-copilot'"
        )
        return False
    return True


def build_backend(
    config: WebSearchConfig,
    *,
    credential_repository: Any | None = None,
) -> SearchBackend | None:
    """Construct the search backend, or None when no credential is available."""
    token = resolve_github_token(credential_repository=credential_repository)
    if token is None:
        return None
    return GitHubMCPBackend(config, token=token)


# --- GitHub MCP backend ----------------------------------------------------


class GitHubMCPBackend:
    """``web_search`` on GitHub's remote MCP server (Bing-backed, with citations).

    Reuses the stored GitHub Copilot OAuth credential, so no extra API key or
    quota is required. Each search opens a short-lived MCP session; the server
    is stateless enough for this and it keeps the code scale-to-zero friendly.
    """

    def __init__(self, config: WebSearchConfig, *, token: str) -> None:
        self._config = config
        self._token = token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            "X-MCP-Toolsets": GITHUB_MCP_TOOLSETS,
        }

    async def search(self, query: str) -> SearchOutcome:
        """Run one search, returning model text plus structured sources."""
        try:
            async with httpx.AsyncClient(timeout=self._config.timeout_seconds) as client:
                headers = self._headers()
                init = await client.post(
                    GITHUB_MCP_ENDPOINT,
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": MCP_PROTOCOL_VERSION,
                            "capabilities": {},
                            "clientInfo": {"name": "router-maestro", "version": "1"},
                        },
                    },
                )
                if init.status_code != 200:
                    logger.warning("MCP initialize failed with status %s", init.status_code)
                    raise WebSearchError(
                        f"Web search session failed with status {init.status_code}."
                    )
                session_id = init.headers.get("Mcp-Session-Id")
                if session_id:
                    headers["Mcp-Session-Id"] = session_id

                await client.post(
                    GITHUB_MCP_ENDPOINT,
                    headers=headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                )

                call = await client.post(
                    GITHUB_MCP_ENDPOINT,
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": WEB_SEARCH_TOOL_NAME,
                            "arguments": {"query": query},
                        },
                    },
                )
        except httpx.TimeoutException as exc:
            raise WebSearchError("Web search timed out.") from exc
        except httpx.HTTPError as exc:
            # Never interpolate the exception: its repr can carry request detail.
            raise WebSearchError("Web search transport error.") from exc

        if call.status_code != 200:
            logger.warning("MCP tools/call returned status %s", call.status_code)
            raise WebSearchError(f"Web search failed with status {call.status_code}.")

        return _parse_mcp_result(_decode_jsonrpc(call.text))


def _decode_jsonrpc(text: str) -> Any:
    """Decode a JSON or SSE-framed JSON-RPC response body."""
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            return json.loads(stripped)
        except ValueError as exc:
            raise WebSearchError("Web search returned a malformed response.") from exc
    payloads = []
    for line in text.splitlines():
        if line.startswith("data: "):
            try:
                payloads.append(json.loads(line[6:]))
            except ValueError:
                continue
    if not payloads:
        raise WebSearchError("Web search returned a malformed response.")
    return payloads[-1]


def _parse_mcp_result(payload: Any) -> SearchOutcome:
    """Extract answer text and citations from an MCP tools/call result."""
    if not isinstance(payload, dict):
        raise WebSearchError("Web search returned a malformed response.")
    if "error" in payload:
        error = payload["error"]
        code = error.get("code") if isinstance(error, dict) else None
        raise WebSearchError(f"Web search rejected the request (code {code}).")

    result = payload.get("result")
    if not isinstance(result, dict):
        raise WebSearchError("Web search returned no result.")
    if result.get("isError"):
        raise WebSearchError("Web search reported an error.")

    blocks = result.get("content")
    if not isinstance(blocks, list) or not blocks:
        return SearchOutcome("No results found.")

    texts: list[str] = []
    citations: list[SearchCitation] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        raw = block.get("text")
        if not isinstance(raw, str):
            continue
        value, block_citations = _unwrap_output_text(raw)
        if value:
            texts.append(value)
        citations.extend(block_citations)

    if not texts:
        return SearchOutcome("No results found.")

    unique: list[SearchCitation] = list(dict.fromkeys(citations))
    rendered = "\n\n".join(texts)
    if unique:
        rendered += "\n\nSources:\n" + "\n".join(
            f"- {c.title} - {c.url}" if c.title else f"- {c.url}" for c in unique
        )
    return SearchOutcome(rendered, unique)


def _unwrap_output_text(raw: str) -> tuple[str, list[SearchCitation]]:
    """Unwrap the nested ``output_text`` envelope the tool returns.

    The MCP text block contains a JSON document shaped like
    ``{"type": "output_text", "text": {"value": ..., "annotations": [...]}}``.
    Plain text is returned unchanged so a future format change degrades to
    "hand the model whatever we got" rather than failing.
    """
    try:
        document = json.loads(raw)
    except ValueError:
        return raw.strip(), []
    if not isinstance(document, dict):
        return raw.strip(), []

    body = document.get("text")
    if isinstance(body, str):
        return body.strip(), []
    if not isinstance(body, dict):
        return raw.strip(), []

    value = body.get("value")
    value = value.strip() if isinstance(value, str) else ""

    citations: list[SearchCitation] = []
    annotations = body.get("annotations") or document.get("annotations") or []
    if isinstance(annotations, list):
        for annotation in annotations:
            if not isinstance(annotation, dict):
                continue
            citation = annotation.get("url_citation")
            if not isinstance(citation, dict):
                continue
            url = citation.get("url")
            if not isinstance(url, str) or not url:
                continue
            title = citation.get("title")
            label = title if isinstance(title, str) and title else ""
            citations.append(SearchCitation(title=label, url=url))
    return value, citations


# --- shared execution ------------------------------------------------------


def parse_query(arguments_json: str | None) -> str:
    """Extract the ``query`` argument from a model-produced tool call.

    Raises WebSearchError when the payload is unusable so the caller can hand a
    corrective message back to the model rather than failing the request.
    """
    if not arguments_json:
        raise WebSearchError("web_search called without arguments.")
    try:
        arguments = json.loads(arguments_json)
    except (TypeError, ValueError) as exc:
        raise WebSearchError("web_search arguments were not valid JSON.") from exc
    if not isinstance(arguments, dict):
        raise WebSearchError("web_search arguments must be a JSON object.")
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise WebSearchError("web_search requires a non-empty 'query' string.")
    return query.strip()


async def run_search(backend: SearchBackend, arguments_json: str | None) -> SearchOutcome:
    """Execute one tool call end to end, returning tool_result text.

    Errors are converted into text for the model instead of propagating, so a
    flaky search never fails the whole client request.
    """
    try:
        query = parse_query(arguments_json)
    except WebSearchError as exc:
        return SearchOutcome(f"Search error: {exc}")

    logger.info("Executing local web_search (query_len=%d)", len(query))
    try:
        outcome = await backend.search(query)
    except WebSearchError as exc:
        return SearchOutcome(f"Search error: {exc}")
    except Exception:  # noqa: BLE001 - never let a backend bug fail the request
        logger.exception("Unexpected web_search backend failure")
        return SearchOutcome("Search error: the search backend failed unexpectedly.")

    logger.info(
        "Local web_search returned %d characters, %d source(s)",
        len(outcome.text),
        len(outcome.citations),
    )
    return outcome
