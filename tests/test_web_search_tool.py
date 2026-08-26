"""Tests for the Router-Maestro-local web_search tool."""

import json
from unittest.mock import patch

import httpx
import pytest

from router_maestro.config.priorities import PrioritiesConfig, WebSearchConfig
from router_maestro.providers import ChatRequest, ChatResponse, Message
from router_maestro.server.routes.anthropic import _run_web_search_loop
from router_maestro.server.schemas.anthropic import AnthropicMessagesRequest
from router_maestro.server.web_search_runtime import (
    WebSearchSession,
    execute_web_search_calls,
    extend_request,
    merge_usage,
    pending_web_search_calls,
    prepare_web_search,
    strip_local_tool_calls,
)
from router_maestro.tools.web_search import (
    GitHubMCPBackend,
    GoogleSearchBackend,
    SearchCitation,
    SearchOutcome,
    SearchResult,
    WebSearchError,
    build_backend,
    format_results,
    is_active,
    is_server_web_search_tool,
    local_tool_definition,
    parse_query,
    resolve_github_token,
    resolve_google_credentials,
    run_search,
)

HOSTED_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}


def _config(**overrides) -> WebSearchConfig:
    """Google-backend config (the github_mcp backend is covered separately)."""
    return WebSearchConfig(**{"enabled": True, "backend": "google", **overrides})


def _environ(**overrides) -> dict[str, str]:
    base = {"GOOGLE_SEARCH_API_KEY": "test-key", "GOOGLE_SEARCH_CSE_ID": "test-cse"}
    base.update(overrides)
    return base


# --- tool detection --------------------------------------------------------


def test_hosted_server_tool_is_detected() -> None:
    assert is_server_web_search_tool(HOSTED_TOOL) is True
    assert is_server_web_search_tool({"type": "web_search", "name": "web_search"}) is True


def test_client_function_tool_is_not_a_server_tool() -> None:
    """A tool carrying its own input_schema is client-executed; leave it alone."""
    client_tool = {
        "name": "web_search",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}},
    }
    assert is_server_web_search_tool(client_tool) is False


def test_unrelated_tool_is_not_a_server_tool() -> None:
    assert is_server_web_search_tool({"name": "read_file", "input_schema": {}}) is False
    assert is_server_web_search_tool({"type": "code_interpreter"}) is False


def test_local_tool_definition_declares_a_query_schema() -> None:
    """The upstream model needs a real schema or it emits an empty tool_use."""
    definition = local_tool_definition()
    assert definition["name"] == "web_search"
    assert definition["input_schema"]["required"] == ["query"]
    assert "query" in definition["input_schema"]["properties"]


# --- credentials and activation -------------------------------------------


def test_resolve_credentials_reads_configured_env_names() -> None:
    resolved = resolve_google_credentials(_config(), environ=_environ())
    assert resolved == ("test-key", "test-cse")


def test_resolve_credentials_honors_custom_env_names() -> None:
    config = _config(api_key_env="MY_KEY", cse_id_env="MY_CSE")
    resolved = resolve_google_credentials(config, environ={"MY_KEY": "k", "MY_CSE": "c"})
    assert resolved == ("k", "c")


def test_missing_credentials_disable_the_feature() -> None:
    assert resolve_google_credentials(_config(), environ={}) is None
    assert is_active(_config(), environ={}) is False
    assert build_backend(_config(), environ={}) is None


def test_disabled_config_is_inactive_even_with_credentials() -> None:
    assert is_active(_config(enabled=False), environ=_environ()) is False


def test_missing_credentials_do_not_log_secret_values(caplog) -> None:
    """A misconfiguration warning must name env vars, never values."""
    with caplog.at_level("WARNING"):
        is_active(_config(), environ={"GOOGLE_SEARCH_API_KEY": "super-secret-value"})
    assert "GOOGLE_SEARCH_API_KEY" in caplog.text
    assert "super-secret-value" not in caplog.text


# --- argument parsing ------------------------------------------------------


def test_parse_query_extracts_the_query() -> None:
    assert parse_query('{"query": "  python 3.14  "}') == "python 3.14"


@pytest.mark.parametrize(
    "arguments",
    [None, "", "not json", '["a"]', "{}", '{"query": ""}', '{"query": 5}'],
)
def test_parse_query_rejects_unusable_arguments(arguments) -> None:
    with pytest.raises(WebSearchError):
        parse_query(arguments)


# --- Google backend --------------------------------------------------------


def _backend(handler, **config_overrides) -> GoogleSearchBackend:
    backend = build_backend(_config(**config_overrides), environ=_environ())
    assert backend is not None
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    patcher = patch("router_maestro.tools.web_search.httpx.AsyncClient", return_value=client)
    patcher.start()
    return backend


async def test_google_backend_parses_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["q"] == "python release"
        assert request.url.params["cx"] == "test-cse"
        return httpx.Response(
            200,
            json={
                "items": [
                    {"title": "Python", "link": "https://python.org", "snippet": "3.14.3"},
                    {"title": "Docs", "link": "https://docs.python.org", "snippet": "notes"},
                ]
            },
        )

    backend = _backend(handler)
    try:
        results = await backend.search_results("python release")
    finally:
        patch.stopall()

    assert results == [
        SearchResult("Python", "https://python.org", "3.14.3"),
        SearchResult("Docs", "https://docs.python.org", "notes"),
    ]


async def test_google_backend_respects_max_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["num"] == "2"
        return httpx.Response(200, json={"items": [{"title": str(i)} for i in range(5)]})

    backend = _backend(handler, max_results=2)
    try:
        results = await backend.search_results("q")
    finally:
        patch.stopall()
    assert len(results) == 2


async def test_google_backend_error_status_raises_without_leaking_key() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"message": "key test-key is invalid"}})

    backend = _backend(handler)
    try:
        with pytest.raises(WebSearchError) as excinfo:
            await backend.search_results("q")
    finally:
        patch.stopall()
    assert "test-key" not in str(excinfo.value)
    assert "403" in str(excinfo.value)


async def test_run_search_converts_errors_into_model_readable_text() -> None:
    """A failing search must not fail the whole client request."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    backend = _backend(handler)
    try:
        outcome = await run_search(backend, '{"query": "q"}')
    finally:
        patch.stopall()
    assert outcome.text.startswith("Search error:")


async def test_run_search_reports_bad_arguments_to_the_model() -> None:
    backend = build_backend(_config(), environ=_environ())
    assert backend is not None
    outcome = await run_search(backend, "not json")
    assert outcome.text.startswith("Search error:")


def test_format_results_renders_titles_urls_and_snippets() -> None:
    rendered = format_results([SearchResult("T", "https://u", "S")])
    assert "T" in rendered and "https://u" in rendered and "S" in rendered


def test_format_results_handles_no_hits() -> None:
    assert format_results([]) == "No results found."


# --- request preparation ---------------------------------------------------


def _messages_request(tools) -> AnthropicMessagesRequest:
    return AnthropicMessagesRequest(
        model="github-copilot/claude-haiku-4.5",
        max_tokens=100,
        messages=[{"role": "user", "content": "hi"}],
        tools=tools,
    )


def _enabled_priorities() -> PrioritiesConfig:
    return PrioritiesConfig(web_search=_config())


def test_prepare_swaps_hosted_tool_for_a_local_function_tool() -> None:
    request = _messages_request([HOSTED_TOOL])
    with (
        patch(
            "router_maestro.config.load_priorities_config",
            return_value=_enabled_priorities(),
        ),
        patch("router_maestro.tools.web_search.os.environ", _environ()),
    ):
        session = prepare_web_search(request)

    assert session is not None
    assert session.max_uses == 5
    assert len(request.tools) == 1
    swapped = request.tools[0]
    assert swapped.name == "web_search"
    assert swapped.input_schema["required"] == ["query"]


def test_prepare_is_a_noop_without_a_hosted_tool() -> None:
    request = _messages_request([{"name": "read_file", "input_schema": {}}])
    assert prepare_web_search(request) is None


def test_prepare_is_a_noop_without_tools() -> None:
    assert prepare_web_search(_messages_request(None)) is None


def test_prepare_defers_to_a_client_supplied_web_search_tool() -> None:
    """If the client can run web_search itself, do not intercept."""
    request = _messages_request(
        [HOSTED_TOOL, {"name": "web_search", "input_schema": {"type": "object"}}]
    )
    assert prepare_web_search(request) is None


def test_prepare_is_a_noop_when_disabled() -> None:
    request = _messages_request([HOSTED_TOOL])
    with patch(
        "router_maestro.config.load_priorities_config",
        return_value=PrioritiesConfig(),
    ):
        assert prepare_web_search(request) is None
    # The hosted tool is left untouched for the existing code path to handle.
    assert request.tools[0].type == "web_search_20250305"
    assert request.tools[0].input_schema is None


# --- loop mechanics --------------------------------------------------------


def _tool_call(call_id: str = "call_1", query: str = "q") -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": "web_search", "arguments": f'{{"query": "{query}"}}'},
    }


def _response(tool_calls=None, content=None, finish_reason="tool_calls") -> ChatResponse:
    return ChatResponse(
        content=content,
        model="claude-haiku-4.5",
        finish_reason=finish_reason,
        tool_calls=tool_calls,
    )


def test_pending_calls_finds_local_web_search_calls() -> None:
    assert pending_web_search_calls(_response([_tool_call()])) == [_tool_call()]


def test_pending_calls_ignores_other_tools() -> None:
    other = {"id": "c", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}
    assert pending_web_search_calls(_response([other])) == []


def test_pending_calls_empty_without_tool_calls() -> None:
    assert pending_web_search_calls(_response(None, content="done", finish_reason="stop")) == []


class _StubBackend:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def search(self, query: str) -> SearchOutcome:
        self.queries.append(query)
        return SearchOutcome("[1] T\nURL: https://u\nS", [SearchCitation("T", "https://u")])


async def test_execute_calls_produces_tool_messages() -> None:
    backend = _StubBackend()
    session = WebSearchSession(backend=backend, max_uses=3)

    messages = await execute_web_search_calls(session, [_tool_call(query="python")])

    assert backend.queries == ["python"]
    assert session.used == 1
    assert len(messages) == 1
    assert messages[0].role == "tool"
    assert messages[0].tool_call_id == "call_1"
    assert "https://u" in messages[0].content


async def test_execute_calls_enforces_the_budget() -> None:
    backend = _StubBackend()
    session = WebSearchSession(backend=backend, max_uses=1)

    await execute_web_search_calls(session, [_tool_call("a")])
    messages = await execute_web_search_calls(session, [_tool_call("b")])

    assert session.used == 1
    assert backend.queries == ["q"]
    assert "budget" in messages[0].content


def test_extend_request_appends_assistant_and_tool_turns() -> None:
    base = ChatRequest(model="m", messages=[Message(role="user", content="hi")])
    calls = [_tool_call()]
    extended = extend_request(
        base,
        assistant_content=None,
        tool_calls=calls,
        tool_messages=[Message(role="tool", content="results", tool_call_id="call_1")],
    )

    assert len(base.messages) == 1, "the original request must not be mutated"
    assert [m.role for m in extended.messages] == ["user", "assistant", "tool"]
    assert extended.messages[1].tool_calls == calls
    assert extended.messages[2].tool_call_id == "call_1"


def test_merge_usage_accumulates_across_turns() -> None:
    merged = merge_usage(
        {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
    )
    assert merged == {"prompt_tokens": 30, "completion_tokens": 7, "total_tokens": 37}


def test_merge_usage_handles_missing_sides() -> None:
    assert merge_usage(None, {"prompt_tokens": 1}) == {"prompt_tokens": 1}
    assert merge_usage({"prompt_tokens": 1}, None) == {"prompt_tokens": 1}


# --- GitHub MCP backend ----------------------------------------------------


def _mcp_config(**overrides) -> WebSearchConfig:
    return WebSearchConfig(**{"enabled": True, "backend": "github_mcp", **overrides})


class _StubCredentialRepository:
    """Stands in for the on-disk Copilot credential store."""

    def __init__(self, credential) -> None:
        self._credential = credential

    def get_provider(self, name: str):
        assert name == "github-copilot"
        return self._credential


class _OAuthCredential:
    def __init__(self, refresh: str = "ghu_token", access: str = "tid=copilot") -> None:
        self.refresh = refresh
        self.access = access


def _mcp_payload(value: str, annotations: list[dict] | None = None) -> dict:
    inner = {"type": "output_text", "text": {"value": value, "annotations": annotations or []}}
    return {
        "jsonrpc": "2.0",
        "id": 2,
        "result": {"content": [{"type": "text", "text": json.dumps(inner)}]},
    }


def _mcp_backend(handler, **config_overrides) -> GitHubMCPBackend:
    backend = build_backend(
        _mcp_config(**config_overrides),
        credential_repository=_StubCredentialRepository(_OAuthCredential()),
    )
    assert isinstance(backend, GitHubMCPBackend)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    patch("router_maestro.tools.web_search.httpx.AsyncClient", return_value=client).start()
    return backend


def test_github_token_comes_from_the_stored_copilot_credential() -> None:
    """The long-lived ghu_ token is in `refresh`; `access` is the Copilot API token."""
    repository = _StubCredentialRepository(_OAuthCredential())
    assert resolve_github_token(credential_repository=repository) == "ghu_token"


def test_missing_copilot_credential_disables_the_mcp_backend() -> None:
    repository = _StubCredentialRepository(None)
    assert resolve_github_token(credential_repository=repository) is None
    assert is_active(_mcp_config(), credential_repository=repository) is False
    assert build_backend(_mcp_config(), credential_repository=repository) is None


def test_mcp_backend_is_active_without_any_env_vars() -> None:
    """The github_mcp backend needs no extra secret beyond the Copilot login."""
    repository = _StubCredentialRepository(_OAuthCredential())
    assert is_active(_mcp_config(), environ={}, credential_repository=repository) is True


def test_mcp_backend_is_the_default() -> None:
    assert WebSearchConfig().backend == "github_mcp"


async def test_mcp_backend_returns_answer_with_sources() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        method = body.get("method")
        seen.setdefault("toolsets", request.headers.get("X-MCP-Toolsets"))
        seen.setdefault("auth", request.headers.get("Authorization"))
        if method == "initialize":
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {}}},
                headers={"Mcp-Session-Id": "sess-1"},
            )
        if method == "notifications/initialized":
            return httpx.Response(202)
        seen["tool"] = body["params"]["name"]
        seen["query"] = body["params"]["arguments"]["query"]
        seen["session"] = request.headers.get("Mcp-Session-Id")
        return httpx.Response(
            200,
            json=_mcp_payload(
                "Python 3.14.7 is current.",
                [{"url_citation": {"title": "Python.org", "url": "https://python.org"}}],
            ),
        )

    backend = _mcp_backend(handler)
    try:
        outcome = await backend.search("latest python")
        rendered = outcome.text
    finally:
        patch.stopall()

    # web_search lives outside the MCP server's default toolset.
    assert seen["toolsets"] == "all"
    assert seen["auth"] == "Bearer ghu_token"
    assert seen["tool"] == "web_search"
    assert seen["query"] == "latest python"
    assert seen["session"] == "sess-1"
    assert "Python 3.14.7 is current." in rendered
    assert "https://python.org" in rendered


async def test_mcp_backend_parses_sse_framed_responses() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if body.get("method") == "notifications/initialized":
            return httpx.Response(202)
        frame = f"event: message\ndata: {json.dumps(_mcp_payload('answer'))}\n\n"
        return httpx.Response(200, content=frame, headers={"content-type": "text/event-stream"})

    backend = _mcp_backend(handler)
    try:
        rendered = (await backend.search("q")).text
    finally:
        patch.stopall()
    assert "answer" in rendered


async def test_mcp_backend_surfaces_jsonrpc_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if body.get("method") == "notifications/initialized":
            return httpx.Response(202)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": 2, "error": {"code": -32602, "message": "bad"}},
        )

    backend = _mcp_backend(handler)
    try:
        with pytest.raises(WebSearchError):
            await backend.search("q")
    finally:
        patch.stopall()


async def test_mcp_backend_reports_failed_session_without_leaking_token() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad credentials ghu_token")

    backend = _mcp_backend(handler)
    try:
        with pytest.raises(WebSearchError) as excinfo:
            await backend.search("q")
    finally:
        patch.stopall()
    assert "ghu_token" not in str(excinfo.value)
    assert "401" in str(excinfo.value)


async def test_mcp_backend_tolerates_plain_text_blocks() -> None:
    """A format change must degrade to passing text through, not crash."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if body.get("method") == "notifications/initialized":
            return httpx.Response(202)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": 2, "result": {"content": [{"text": "plain answer"}]}},
        )

    backend = _mcp_backend(handler)
    try:
        rendered = (await backend.search("q")).text
    finally:
        patch.stopall()
    assert rendered == "plain answer"


# --- non-streaming loop: mixed calls and budget exhaustion -----------------


class _LoopRouter:
    """Serves scripted ChatResponses, one per chat_completion call."""

    def __init__(self, responses: list[ChatResponse]) -> None:
        self._responses = responses
        self.requests: list = []

    async def chat_completion(self, request, prepared_plan=None):
        self.requests.append(request)
        index = min(len(self.requests) - 1, len(self._responses) - 1)
        return self._responses[index], "github-copilot"


def _bash_call(call_id: str = "call_bash") -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": "Bash", "arguments": '{"command": "ls"}'},
    }


def _chat_request_with_tools() -> ChatRequest:
    return ChatRequest(
        model="claude-haiku-4.5",
        messages=[Message(role="user", content="hi")],
        tools=[
            {"type": "function", "function": {"name": "web_search", "parameters": {}}},
            {"type": "function", "function": {"name": "Bash", "parameters": {}}},
        ],
    )


def test_strip_local_tool_calls_removes_web_search_and_fixes_finish_reason() -> None:
    response = _response([_tool_call()], finish_reason="tool_calls")
    stripped = strip_local_tool_calls(response)
    assert stripped.tool_calls is None
    assert stripped.finish_reason == "stop"


def test_strip_local_tool_calls_keeps_client_tools() -> None:
    response = _response([_tool_call(), _bash_call()], finish_reason="tool_calls")
    stripped = strip_local_tool_calls(response)
    assert [c["id"] for c in stripped.tool_calls] == ["call_bash"]
    assert stripped.finish_reason == "tool_calls"


def test_strip_local_tool_calls_is_a_noop_without_local_calls() -> None:
    response = _response([_bash_call()], finish_reason="tool_calls")
    assert strip_local_tool_calls(response) is response


async def test_nonstreaming_mixed_turn_sends_only_local_calls_upstream() -> None:
    """Regression: sending a client tool_call with no matching result 400s upstream."""
    session = WebSearchSession(backend=_StubBackend(), max_uses=3)
    router = _LoopRouter([_response(None, content="final", finish_reason="stop")])

    await _run_web_search_loop(
        router,
        _chat_request_with_tools(),
        _response([_tool_call(), _bash_call()], finish_reason="tool_calls"),
        "github-copilot",
        session,
    )

    followup = router.requests[0]
    assistant = followup.messages[1]
    sent_ids = [c["id"] for c in assistant.tool_calls]
    result_ids = [m.tool_call_id for m in followup.messages[2:]]
    assert sent_ids == ["call_1"], "the Bash call must not be sent without a result"
    assert set(sent_ids) == set(result_ids)


async def test_nonstreaming_budget_exhaustion_withdraws_the_tool() -> None:
    """Regression: the loop used to return a web_search tool_use to the client."""
    session = WebSearchSession(backend=_StubBackend(), max_uses=1)
    # The model keeps asking to search; only the tool being withdrawn stops it.
    router = _LoopRouter([_response([_tool_call("call_2")], finish_reason="tool_calls")])

    response, _provider = await _run_web_search_loop(
        router,
        _chat_request_with_tools(),
        _response([_tool_call()], finish_reason="tool_calls"),
        "github-copilot",
        session,
    )

    assert session.used == 1
    # The tool was withdrawn from the follow-up request.
    followup_tools = router.requests[0].tools
    names = [(t.get("function") or {}).get("name") for t in (followup_tools or [])]
    assert "web_search" not in names
    assert "Bash" in names, "client tools must survive the withdrawal"
    # And nothing web_search-shaped reaches the client.
    assert not pending_web_search_calls(response)


async def test_nonstreaming_loop_terminates_on_a_relentless_model() -> None:
    """The turn cap must stop a model that keeps calling a withdrawn tool."""
    session = WebSearchSession(backend=_StubBackend(), max_uses=2)
    router = _LoopRouter([_response([_tool_call("x")], finish_reason="tool_calls")])

    response, _provider = await _run_web_search_loop(
        router,
        _chat_request_with_tools(),
        _response([_tool_call()], finish_reason="tool_calls"),
        "github-copilot",
        session,
    )

    assert len(router.requests) <= session.max_uses + 2
    assert not pending_web_search_calls(response), "no web_search call may reach the client"


# --- native blocks: non-streaming + client round-trip ----------------------


def test_nonstreaming_response_includes_native_blocks() -> None:
    from router_maestro.server.protocols.anthropic_reducer import (
        build_anthropic_response,
        server_tool_parts,
    )
    from router_maestro.server.web_search_runtime import WebSearchRecord

    records = [
        WebSearchRecord(
            tool_id="srv_1",
            query="latest python",
            citations=[SearchCitation("Python.org", "https://python.org")],
        )
    ]
    built = build_anthropic_response(
        _response(None, content="Python 3.14.7.", finish_reason="stop"),
        response_id="msg_x",
        model="github-copilot/claude-haiku-4.5",
        server_tool_parts_=server_tool_parts(records),
        server_tool_requests=1,
    )
    dumped = built.model_dump(exclude_none=True)
    types = [b["type"] for b in dumped["content"]]

    assert types == ["server_tool_use", "web_search_tool_result", "text"]
    assert dumped["content"][0]["input"] == {"query": "latest python"}
    assert dumped["content"][1]["content"] == [
        {"type": "web_search_result", "title": "Python.org", "url": "https://python.org"}
    ]
    assert dumped["usage"]["server_tool_use"] == {"web_search_requests": 1}


def test_client_can_replay_native_blocks_without_error() -> None:
    """The blocks we emit must survive being sent back in a follow-up request.

    Clients echo prior assistant content verbatim. If the inbound schema or the
    OpenAI translation choked on these block types the next turn would 422 or
    lose context, so this is the round-trip that matters.
    """
    from router_maestro.server.schemas.anthropic import AnthropicMessagesRequest
    from router_maestro.server.translation import translate_anthropic_to_openai

    replayed = AnthropicMessagesRequest(
        model="github-copilot/claude-haiku-4.5",
        max_tokens=100,
        messages=[
            {"role": "user", "content": "latest python?"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "server_tool_use",
                        "id": "srv_1",
                        "name": "web_search",
                        "input": {"query": "latest python"},
                    },
                    {
                        "type": "web_search_tool_result",
                        "tool_use_id": "srv_1",
                        "content": [
                            {
                                "type": "web_search_result",
                                "title": "Python.org",
                                "url": "https://python.org",
                            }
                        ],
                    },
                    {"type": "text", "text": "Python 3.14.7."},
                ],
            },
            {"role": "user", "content": "are you sure?"},
        ],
    )

    translated = translate_anthropic_to_openai(replayed)

    roles = [m.role for m in translated.messages]
    assert roles == ["user", "assistant", "user"]
    # The answer text survives; the server-tool blocks are dropped, which is
    # correct: the upstream history is rebuilt by the local search loop.
    assert translated.messages[1].content == "Python 3.14.7."
    assert translated.messages[1].tool_calls is None
