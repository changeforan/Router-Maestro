"""Server-side execution loop for the Router-Maestro-local ``web_search`` tool.

Router-Maestro advertises ``web_search`` to the upstream model as an ordinary
function tool, intercepts the resulting ``tool_use``, runs the search itself,
feeds the result back, and repeats until the model answers. The client sees
only the final answer — the tool round-trips never leave this process.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from router_maestro.config.priorities import WebSearchConfig
from router_maestro.providers import ChatRequest, ChatResponse, Message
from router_maestro.tools.web_search import (
    WEB_SEARCH_TOOL_NAME,
    SearchBackend,
    SearchCitation,
    WebSearchError,
    build_backend,
    is_active,
    is_server_web_search_tool,
    local_tool_definition,
    parse_query,
    run_search,
)

if TYPE_CHECKING:
    from router_maestro.server.schemas.anthropic import AnthropicMessagesRequest

logger = logging.getLogger(__name__)


def _web_search_config() -> WebSearchConfig:
    """Read the effective web_search config for the current request."""
    from router_maestro.runtime import get_current_request_context

    context = get_current_request_context()
    if context is not None:
        priorities = context.config
    else:
        from router_maestro.config import load_priorities_config

        priorities = load_priorities_config()
    return priorities.web_search


def is_local_web_search_active() -> bool:
    """True when the Router-Maestro-local web_search tool is enabled and usable."""
    return is_active(_web_search_config())


@dataclass(frozen=True)
class WebSearchRecord:
    """One executed search, replayable as native Anthropic content blocks."""

    tool_id: str
    query: str
    citations: list[SearchCitation] = field(default_factory=list)


@dataclass
class WebSearchSession:
    """Per-request budget and backend for local web_search execution."""

    backend: SearchBackend
    max_uses: int
    used: int = 0
    emit_native_blocks: bool = True
    # Ordered log of the searches run for this request. Consumed by the protocol
    # layer to emit server_tool_use / web_search_tool_result blocks.
    records: list[WebSearchRecord] = field(default_factory=list)

    @property
    def exhausted(self) -> bool:
        """True once the per-request search budget is spent."""
        return self.used >= self.max_uses


def prepare_web_search(request: AnthropicMessagesRequest) -> WebSearchSession | None:
    """Swap a hosted ``web_search`` tool for a locally-executed function tool.

    Mutates ``request.tools`` in place when the client declared Anthropic's
    hosted server tool and the feature is enabled. Returns the session used to
    run the loop, or ``None`` when the request should proceed untouched.
    """
    tools = request.tools
    if not tools:
        return None

    server_tool_indexes = [
        index for index, tool in enumerate(tools) if is_server_web_search_tool(tool)
    ]
    if not server_tool_indexes:
        return None

    # If the client also ships its own executable web_search function tool, it
    # intends to run the searches itself; do not intercept.
    for index, tool in enumerate(tools):
        if index in server_tool_indexes:
            continue
        if getattr(tool, "name", None) == WEB_SEARCH_TOOL_NAME:
            return None

    config = _web_search_config()
    if not is_active(config):
        return None

    backend = build_backend(config)
    if backend is None:
        return None

    from router_maestro.server.schemas.anthropic import AnthropicTool

    local_tool = AnthropicTool(**local_tool_definition())
    replacement: list[Any] = []
    swapped = False
    for index, tool in enumerate(tools):
        if index not in server_tool_indexes:
            replacement.append(tool)
        elif not swapped:
            replacement.append(local_tool)
            swapped = True
        # Additional duplicate server-tool declarations are dropped.
    request.tools = replacement

    logger.info(
        "Intercepting hosted web_search tool; serving it locally (max_uses=%d)",
        config.max_uses,
    )
    return WebSearchSession(
        backend=backend,
        max_uses=config.max_uses,
        emit_native_blocks=config.emit_native_blocks,
    )


def pending_web_search_calls(response: ChatResponse) -> list[dict]:
    """Return the local web_search tool calls in ``response``, if any."""
    if not response.tool_calls:
        return []
    if response.finish_reason not in ("tool_calls", "stop", None):
        return []
    return [call for call in response.tool_calls if _call_name(call) == WEB_SEARCH_TOOL_NAME]


def strip_local_tool_calls(response: ChatResponse) -> ChatResponse:
    """Remove locally-served tool calls from a response bound for the client.

    The client declared ``web_search`` as a hosted server tool and has no local
    implementation, so a leaked ``tool_use`` block would stall the conversation.
    When stripping empties the list, the finish reason is corrected so the client
    is not told to expect a tool call that is not there.
    """
    if not response.tool_calls:
        return response
    remaining = [call for call in response.tool_calls if _call_name(call) != WEB_SEARCH_TOOL_NAME]
    if len(remaining) == len(response.tool_calls):
        return response
    finish_reason = response.finish_reason
    if not remaining and finish_reason == "tool_calls":
        finish_reason = "stop"
    return replace(response, tool_calls=remaining or None, finish_reason=finish_reason)


def _call_name(call: Any) -> str | None:
    """Extract the function name from an OpenAI-shaped tool call."""
    if not isinstance(call, dict):
        return None
    function = call.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        return name if isinstance(name, str) else None
    return None


def _call_arguments(call: dict) -> str | None:
    """Extract the raw JSON arguments string from an OpenAI-shaped tool call."""
    function = call.get("function")
    if isinstance(function, dict):
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            return arguments
    return None


async def execute_web_search_calls(
    session: WebSearchSession,
    calls: list[dict],
) -> list[Message]:
    """Run each pending call and build the ``tool`` messages to send upstream.

    Each executed search is also appended to ``session.records`` so the protocol
    layer can replay it as native ``server_tool_use`` /
    ``web_search_tool_result`` blocks.
    """
    messages: list[Message] = []
    for call in calls:
        call_id = call.get("id") or ""
        arguments = _call_arguments(call)
        if session.exhausted:
            content = (
                "Search error: the web search budget for this request is exhausted. "
                "Answer using what you already know."
            )
            session.records.append(
                WebSearchRecord(
                    tool_id=call_id,
                    query=_safe_query(arguments),
                    citations=[],
                )
            )
        else:
            session.used += 1
            outcome = await run_search(session.backend, arguments)
            content = outcome.text
            session.records.append(
                WebSearchRecord(
                    tool_id=call_id,
                    query=_safe_query(arguments),
                    citations=list(outcome.citations),
                )
            )
        messages.append(Message(role="tool", content=content, tool_call_id=call_id))
    return messages


def _safe_query(arguments_json: str | None) -> str:
    """Best-effort query extraction for the replayed block; never raises."""
    try:
        return parse_query(arguments_json)
    except WebSearchError:
        return ""


def extend_request(
    chat_request: ChatRequest,
    *,
    assistant_content: str | None,
    tool_calls: list[dict] | None,
    tool_messages: list[Message],
) -> ChatRequest:
    """Append the assistant tool_call turn plus tool results to the request."""
    assistant = Message(
        role="assistant",
        content=assistant_content or "",
        tool_calls=tool_calls,
    )
    return replace(
        chat_request,
        messages=[*chat_request.messages, assistant, *tool_messages],
    )


def merge_usage(total: dict | None, addition: dict | None) -> dict | None:
    """Accumulate token usage across the internal turns of one client request."""
    if addition is None:
        return total
    if total is None:
        return dict(addition)
    merged = dict(total)
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        left = merged.get(key)
        right = addition.get(key)
        if isinstance(left, int) and isinstance(right, int):
            merged[key] = left + right
        elif isinstance(right, int):
            merged[key] = right
    return merged
