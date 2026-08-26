"""Streaming tests for the Router-Maestro-local web_search loop.

When Router-Maestro serves ``web_search`` itself, the tool round-trips must be
invisible downstream: the client sees exactly one Anthropic message (one
``message_start`` … one ``message_stop``), with no ``tool_use`` block for the
locally-executed tool and no interleaved terminal events.
"""

import json
from collections.abc import AsyncGenerator

import pytest

from router_maestro.providers import ChatRequest, Message
from router_maestro.providers.base import ChatStreamChunk
from router_maestro.server.routes.anthropic import stream_response
from router_maestro.server.web_search_runtime import WebSearchSession
from router_maestro.tools.web_search import SearchCitation, SearchOutcome


def _web_search_tool() -> dict:
    return {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
        },
    }


def _tool_call_chunk() -> ChatStreamChunk:
    return ChatStreamChunk(
        content="",
        tool_calls=[
            {
                "index": 0,
                "id": "call_ws_1",
                "type": "function",
                "function": {"name": "web_search", "arguments": '{"query": "python 3.14"}'},
            }
        ],
    )


def _parse_events(frames: list[str]) -> list[dict]:
    events = []
    for frame in frames:
        for line in frame.split("\n"):
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[len("data: ") :]))
                except json.JSONDecodeError:
                    pass
    return events


class _RecordingBackend:
    """Search backend stub that records the queries it was asked to run."""

    def __init__(self) -> None:
        self.queries: list[str] = []

    async def search(self, query: str) -> SearchOutcome:
        self.queries.append(query)
        return SearchOutcome(
            "Python 3.14.3 is the latest stable release.",
            [SearchCitation("Python.org", "https://python.org")],
        )


class _TurnRouter:
    """Serves a scripted list of upstream turns, one per chat_completion_stream call."""

    def __init__(self, turns: list[list[ChatStreamChunk]]) -> None:
        self._turns = turns
        self.requests: list[ChatRequest] = []

    async def chat_completion_stream(self, request, prepared_plan=None):
        self.requests.append(request)
        chunks = self._turns[len(self.requests) - 1]

        async def gen() -> AsyncGenerator[ChatStreamChunk]:
            for chunk in chunks:
                yield chunk

        return gen(), "github-copilot"


async def _run(turns, *, session, tools=None) -> tuple[list[dict], _TurnRouter]:
    request = ChatRequest(
        model="claude-haiku-4.5",
        messages=[Message(role="user", content="latest python?")],
        stream=True,
        tools=tools or [_web_search_tool()],
    )
    router = _TurnRouter(turns)
    frames = [
        frame
        async for frame in stream_response(
            router,
            request,
            "claude-haiku-4.5",
            web_search_session=session,
        )
    ]
    return _parse_events(frames), router


@pytest.mark.asyncio
async def test_local_web_search_is_invisible_to_the_client() -> None:
    """The client must see one message, no tool_use block, and the final text."""
    backend = _RecordingBackend()
    session = WebSearchSession(backend=backend, max_uses=3)

    turns = [
        # Turn 1: the model asks for a search.
        [
            ChatStreamChunk(content="Let me look that up. "),
            _tool_call_chunk(),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
        # Turn 2: with the results in hand, it answers.
        [
            ChatStreamChunk(content="Python 3.14.3 is the latest stable release."),
            ChatStreamChunk("", finish_reason="stop"),
        ],
    ]

    events, router = await _run(turns, session=session)
    types = [event.get("type") for event in events]

    # The search actually ran.
    assert backend.queries == ["python 3.14"]
    assert session.used == 1

    # Exactly one downstream message.
    assert types.count("message_start") == 1
    assert types.count("message_stop") == 1
    assert types.count("message_delta") == 1

    # No tool_use block ever reached the client.
    tool_blocks = [
        event
        for event in events
        if event.get("type") == "content_block_start"
        and event.get("content_block", {}).get("type") == "tool_use"
    ]
    assert tool_blocks == []

    # The client saw both the pre-search prose and the final answer.
    text = "".join(
        event.get("delta", {}).get("text", "")
        for event in events
        if event.get("type") == "content_block_delta"
    )
    assert "Let me look that up." in text
    assert "Python 3.14.3 is the latest stable release." in text

    # The message ends normally, not with tool_use.
    stop_reason = next(
        event["delta"]["stop_reason"] for event in events if event.get("type") == "message_delta"
    )
    assert stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_search_results_are_appended_to_the_followup_request() -> None:
    """Turn 2 must carry the assistant tool_call turn plus the tool result."""
    backend = _RecordingBackend()
    session = WebSearchSession(backend=backend, max_uses=3)

    turns = [
        [_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        [ChatStreamChunk(content="done"), ChatStreamChunk("", finish_reason="stop")],
    ]

    _events, router = await _run(turns, session=session)

    assert len(router.requests) == 2
    followup = router.requests[1]
    roles = [message.role for message in followup.messages]
    assert roles == ["user", "assistant", "tool"]
    assert followup.messages[1].tool_calls[0]["id"] == "call_ws_1"
    assert followup.messages[2].tool_call_id == "call_ws_1"
    assert "Python 3.14.3" in followup.messages[2].content


@pytest.mark.asyncio
async def test_content_block_indices_stay_monotonic_across_turns() -> None:
    """Continuing one message across turns must not reuse block indices."""
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)

    turns = [
        [
            ChatStreamChunk(content="searching"),
            _tool_call_chunk(),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
        [ChatStreamChunk(content="answer"), ChatStreamChunk("", finish_reason="stop")],
    ]

    events, _router = await _run(turns, session=session)

    starts = [e["index"] for e in events if e.get("type") == "content_block_start"]
    assert starts == sorted(starts)
    assert len(starts) == len(set(starts)), "block indices must never repeat"


@pytest.mark.asyncio
async def test_budget_exhaustion_stops_the_loop() -> None:
    """Once the budget is spent the tool is withdrawn and the answer is returned."""
    backend = _RecordingBackend()
    session = WebSearchSession(backend=backend, max_uses=1)

    turns = [
        [_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        [ChatStreamChunk(content="partial answer"), ChatStreamChunk("", finish_reason="stop")],
    ]

    events, router = await _run(turns, session=session)

    assert session.used == 1
    assert len(router.requests) == 2
    # The tool is no longer advertised on the follow-up request.
    assert router.requests[1].tools is None
    types = [event.get("type") for event in events]
    assert types.count("message_stop") == 1


@pytest.mark.asyncio
async def test_non_local_tool_calls_still_reach_the_client() -> None:
    """Ordinary client-side tools must be unaffected by the loop."""
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)
    bash_tool = {
        "type": "function",
        "function": {"name": "Bash", "parameters": {"type": "object"}},
    }

    turns = [
        [
            ChatStreamChunk(
                "",
                tool_calls=[
                    {
                        "index": 0,
                        "id": "call_bash",
                        "type": "function",
                        "function": {"name": "Bash", "arguments": '{"command": "ls"}'},
                    }
                ],
            ),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
    ]

    events, router = await _run(turns, session=session, tools=[bash_tool, _web_search_tool()])

    assert len(router.requests) == 1, "a client-side tool must not trigger another turn"
    tool_blocks = [
        event
        for event in events
        if event.get("type") == "content_block_start"
        and event.get("content_block", {}).get("type") == "tool_use"
    ]
    assert len(tool_blocks) == 1
    assert tool_blocks[0]["content_block"]["name"] == "Bash"
    stop_reason = next(
        event["delta"]["stop_reason"] for event in events if event.get("type") == "message_delta"
    )
    assert stop_reason == "tool_use"


@pytest.mark.asyncio
async def test_loop_is_skipped_without_a_session() -> None:
    """Without a session the web_search tool_use is forwarded as usual."""
    turns = [[_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")]]

    events, router = await _run(turns, session=None)

    assert len(router.requests) == 1
    tool_blocks = [
        event
        for event in events
        if event.get("type") == "content_block_start"
        and event.get("content_block", {}).get("type") == "tool_use"
    ]
    assert len(tool_blocks) == 1
    assert tool_blocks[0]["content_block"]["name"] == "web_search"


# --- mixed local + client tool calls in one turn ----------------------------


def _mixed_tool_call_chunk() -> ChatStreamChunk:
    """A turn where the model calls web_search AND a client-side tool."""
    return ChatStreamChunk(
        "",
        tool_calls=[
            {
                "index": 0,
                "id": "call_ws_1",
                "type": "function",
                "function": {"name": "web_search", "arguments": '{"query": "python 3.14"}'},
            },
            {
                "index": 1,
                "id": "call_bash_1",
                "type": "function",
                "function": {"name": "Bash", "arguments": '{"command": "ls"}'},
            },
        ],
    )


def _bash_tool() -> dict:
    return {
        "type": "function",
        "function": {"name": "Bash", "parameters": {"type": "object"}},
    }


@pytest.mark.asyncio
async def test_mixed_turn_never_leaks_web_search_to_the_client() -> None:
    """Regression: a turn mixing web_search with a client tool must still suspend.

    Claude issues parallel tool calls freely. The client declared web_search as a
    hosted server tool and cannot execute it, so emitting it downstream stalls the
    conversation.
    """
    backend = _RecordingBackend()
    session = WebSearchSession(backend=backend, max_uses=3)

    turns = [
        # Turn 1: web_search + Bash together.
        [_mixed_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        # Turn 2: with results in hand the model re-issues just the client tool.
        [
            ChatStreamChunk(
                "",
                tool_calls=[
                    {
                        "index": 0,
                        "id": "call_bash_2",
                        "type": "function",
                        "function": {"name": "Bash", "arguments": '{"command": "ls"}'},
                    }
                ],
            ),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
    ]

    events, router = await _run(turns, session=session, tools=[_bash_tool(), _web_search_tool()])

    # The search ran despite the turn being mixed.
    assert backend.queries == ["python 3.14"]
    assert len(router.requests) == 2

    blocks = [
        e["content_block"]
        for e in events
        if e.get("type") == "content_block_start" and e["content_block"]["type"] == "tool_use"
    ]
    names = [b["name"] for b in blocks]
    assert "web_search" not in names, "web_search must never reach the client"
    assert names == ["Bash"], "the client tool is still delivered"
    assert [e.get("type") for e in events].count("message_stop") == 1


@pytest.mark.asyncio
async def test_mixed_turn_sends_only_local_calls_upstream() -> None:
    """The follow-up must not carry a client tool_call with no matching result.

    OpenAI-compatible upstreams reject an assistant tool_calls message unless every
    tool_call_id has a result, so the Bash call must be dropped rather than sent.
    """
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)

    turns = [
        [_mixed_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        [ChatStreamChunk(content="done"), ChatStreamChunk("", finish_reason="stop")],
    ]

    _events, router = await _run(turns, session=session, tools=[_bash_tool(), _web_search_tool()])

    followup = router.requests[1]
    assistant = followup.messages[1]
    sent_ids = [c["id"] for c in assistant.tool_calls]
    result_ids = [m.tool_call_id for m in followup.messages[2:]]

    assert sent_ids == ["call_ws_1"], "only the locally-executed call goes upstream"
    assert result_ids == ["call_ws_1"]
    assert set(sent_ids) == set(result_ids), "every tool_call_id must have a result"


@pytest.mark.asyncio
async def test_assistant_preamble_is_carried_into_the_followup() -> None:
    """Text streamed before the tool call must reach turn 2 or it gets repeated."""
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)

    turns = [
        [
            ChatStreamChunk(content="Let me look that up. "),
            _tool_call_chunk(),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
        [ChatStreamChunk(content="answer"), ChatStreamChunk("", finish_reason="stop")],
    ]

    _events, router = await _run(turns, session=session)

    assert router.requests[1].messages[1].content == "Let me look that up. "


# --- native (faithful) blocks ----------------------------------------------


@pytest.mark.asyncio
async def test_native_blocks_are_emitted_in_anthropic_order() -> None:
    """Default mode replays the search as server_tool_use + web_search_tool_result."""
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)

    turns = [
        [
            ChatStreamChunk(content="Let me check. "),
            _tool_call_chunk(),
            ChatStreamChunk("", finish_reason="tool_calls"),
        ],
        [ChatStreamChunk(content="Python 3.14.3."), ChatStreamChunk("", finish_reason="stop")],
    ]

    events, _router = await _run(turns, session=session)
    blocks = [
        (e["index"], e["content_block"]["type"])
        for e in events
        if e.get("type") == "content_block_start"
    ]
    types = [t for _i, t in blocks]

    assert types == ["text", "server_tool_use", "web_search_tool_result", "text"], (
        "native ordering is preamble, tool exchange, then answer"
    )
    indices = [i for i, _t in blocks]
    assert indices == sorted(indices) and len(indices) == len(set(indices))

    result_block = next(
        e["content_block"]
        for e in events
        if e.get("type") == "content_block_start"
        and e["content_block"]["type"] == "web_search_tool_result"
    )
    assert result_block["tool_use_id"] == "call_ws_1"
    assert result_block["content"] == [
        {"type": "web_search_result", "title": "Python.org", "url": "https://python.org"}
    ]

    use_block = next(
        e["content_block"]
        for e in events
        if e.get("type") == "content_block_start"
        and e["content_block"]["type"] == "server_tool_use"
    )
    assert use_block["name"] == "web_search"
    assert use_block["id"] == "call_ws_1"


@pytest.mark.asyncio
async def test_native_blocks_report_search_count_in_usage() -> None:
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3)
    turns = [
        [_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        [ChatStreamChunk(content="done"), ChatStreamChunk("", finish_reason="stop")],
    ]

    events, _router = await _run(turns, session=session)
    delta = next(e for e in events if e.get("type") == "message_delta")
    assert delta["usage"]["server_tool_use"] == {"web_search_requests": 1}


@pytest.mark.asyncio
async def test_native_blocks_can_be_disabled() -> None:
    """emit_native_blocks=False restores the text-only (transparent) response."""
    session = WebSearchSession(backend=_RecordingBackend(), max_uses=3, emit_native_blocks=False)
    turns = [
        [_tool_call_chunk(), ChatStreamChunk("", finish_reason="tool_calls")],
        [ChatStreamChunk(content="done"), ChatStreamChunk("", finish_reason="stop")],
    ]

    events, _router = await _run(turns, session=session)
    types = [e["content_block"]["type"] for e in events if e.get("type") == "content_block_start"]
    assert types == ["text"]
    # Usage stays truthful even when the blocks are hidden.
    delta = next(e for e in events if e.get("type") == "message_delta")
    assert delta["usage"]["server_tool_use"] == {"web_search_requests": 1}
