"""Tests for Copilot tool-type filtering."""

from copy import deepcopy

import pytest

from router_maestro.providers import CopilotProvider
from router_maestro.providers.base import ProviderFailureKind, RequestOptionError, ResponsesRequest


class TestFilterUnsupportedTools:
    def setup_method(self):
        self.provider = CopilotProvider()

    def test_returns_none_for_empty(self):
        assert self.provider._filter_unsupported_tools(None) is None
        assert self.provider._filter_unsupported_tools([]) is None

    def test_keeps_function_tools(self):
        tools = [
            {"type": "function", "name": "foo", "parameters": {}},
            {"type": "function", "name": "bar", "parameters": {}},
        ]
        assert self.provider._filter_unsupported_tools(tools) == tools

    @pytest.mark.parametrize("inner_tools", [None, []], ids=["missing-tools", "empty-tools"])
    def test_rejects_empty_namespace_tools(self, inner_tools):
        tools = [
            {"type": "function", "name": "foo"},
            {
                "type": "namespace",
                "name": "mcp__chrome_devtools__",
                "description": "Tools in the mcp__chrome_devtools__ namespace.",
                **({"tools": inner_tools} if inner_tools is not None else {}),
            },
            {"type": "function", "name": "bar"},
        ]

        with pytest.raises(RequestOptionError) as caught:
            self.provider._build_responses_payload(
                ResponsesRequest(model="gpt-5.4", input="hi", tools=tools)
            )

        assert caught.value.kind is ProviderFailureKind.CLIENT_REQUEST
        assert caught.value.parameter == "tools"
        assert caught.value.model == "gpt-5.4"

    def test_keeps_namespace_with_inner_tools(self):
        # Codex's MCP registry shape — namespace wraps the actual function
        # tools. Dropping the wrapper means Copilot can't resolve
        # ``execute_query`` and 400s with ``Missing namespace for
        # function_call 'execute_query'`` (v0.3.8 → v0.3.9 bug).
        kusto_namespace = {
            "type": "namespace",
            "name": "mcp__kusto_mcp__",
            "description": "Tools in the mcp__kusto_mcp__ namespace.",
            "tools": [
                {
                    "type": "function",
                    "name": "execute_query",
                    "description": "Execute a KQL query",
                    "parameters": {"type": "object", "properties": {}},
                },
            ],
        }
        tools = [
            {"type": "function", "name": "shell"},
            kusto_namespace,
        ]
        result = self.provider._filter_unsupported_tools(tools)
        assert result is not None
        assert len(result) == 2
        assert result[1] == kusto_namespace

    @pytest.mark.parametrize(
        "tool_type",
        ["web_search", "web_search_preview", "code_interpreter"],
    )
    def test_drops_unsupported_tool_types(self, tool_type):
        # Dropped rather than 400-ing the whole request (Codex injects these
        # unconditionally). With no other tools the payload carries none.
        payload = self.provider._build_responses_payload(
            ResponsesRequest(
                model="gpt-5.4",
                input="hi",
                tools=[{"type": tool_type}],
            )
        )
        assert "tools" not in payload

    @pytest.mark.parametrize("tool_type", ["web_search", "web_search_preview"])
    def test_dropping_a_tool_is_logged(self, tool_type, caplog):
        """The drop is invisible to the caller, so it must be visible in logs.

        Without this the model simply answers from stale knowledge and nothing
        anywhere records that a search the client asked for never happened.
        """
        with caplog.at_level("WARNING"):
            self.provider._build_responses_payload(
                ResponsesRequest(model="gpt-5.4", input="hi", tools=[{"type": tool_type}])
            )
        assert tool_type in caplog.text
        assert "Dropping unsupported tool type" in caplog.text

    def test_mixed_supported_and_unsupported_tools_drops_only_unsupported(self):
        tools = [
            {"type": "function", "name": "lookup", "parameters": {}},
            {"type": "web_search"},
        ]

        payload = self.provider._build_responses_payload(
            ResponsesRequest(model="gpt-5.4", input="hi", tools=tools)
        )

        assert payload["tools"] == [{"type": "function", "name": "lookup", "parameters": {}}]

    def test_keeps_unknown_non_function_types(self):
        # denylist semantics: anything not in UNSUPPORTED_TOOL_TYPES passes through
        tools = [{"type": "local_shell", "name": "shell"}]
        result = self.provider._filter_unsupported_tools(tools)
        assert result == tools

    def test_normal_responses_fills_required_additional_namespace_description(self):
        input_items = [
            {
                "type": "additional_tools",
                "role": "developer",
                "tools": [
                    {
                        "type": "namespace",
                        "name": "functions",
                        "description": "",
                        "tools": [
                            {
                                "type": "function",
                                "name": "wait",
                                "description": "Wait for work",
                            },
                            {
                                "type": "function",
                                "name": "poll",
                                "description": "",
                            },
                        ],
                    }
                ],
            }
        ]
        original = deepcopy(input_items)

        payload = self.provider._build_responses_payload(
            ResponsesRequest(model="gpt-5.6-sol", input=input_items)
        )

        namespace = payload["input"][0]["tools"][0]
        assert namespace["description"] == "Tools in the functions namespace."
        assert namespace["tools"][0]["description"] == "Wait for work"
        assert namespace["tools"][1]["description"] == ""
        assert input_items == original


class TestResponsesUnsupportedToolConstants:
    """The two denylists are duplicated; keep them from drifting apart."""

    def test_both_denylists_agree(self):
        from router_maestro.providers.copilot import CopilotOutboundContract, CopilotProvider

        assert set(CopilotOutboundContract._RESPONSES_UNSUPPORTED_TOOL_TYPES) == set(
            CopilotProvider.UNSUPPORTED_TOOL_TYPES
        )

    def test_web_search_is_denied_pending_multi_reasoning_support(self):
        """Not an upstream limitation — see TestHostedWebSearchOutputLimitation.

        /responses runs web_search server-side, but its response carries one
        reasoning item per search round and the codec models only one. Until
        that is lifted, forwarding the tool turns a stale answer into a 502.
        """
        from router_maestro.providers.copilot import CopilotOutboundContract

        assert "web_search" in CopilotOutboundContract._RESPONSES_UNSUPPORTED_TOOL_TYPES


class TestHostedWebSearchOutputLimitation:
    """Forwarding the tool is not enough: the output shape is not yet supported.

    Copilot's /responses runs web_search server-side and returns one reasoning
    item per tool round, e.g.
    ``[reasoning, web_search_call, reasoning, web_search_call, reasoning, message]``.
    The Responses codec only models a single atomic reasoning item, because the
    encrypted blob must round-trip paired with its own upstream id.

    These tests pin the current behaviour so the gap is visible and a future
    fix has a concrete target.
    """

    def test_web_search_call_item_alone_is_tolerated(self):
        from router_maestro.providers.copilot_support.responses_codec import (
            CopilotResponsesCodec,
        )

        data = {
            "output": [
                {"type": "reasoning", "summary": [], "id": "rs_1", "encrypted_content": "b"},
                {"type": "web_search_call", "id": "ws_1", "status": "completed"},
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]},
            ]
        }
        # The hosted-tool item itself is ignored rather than rejected.
        assert CopilotResponsesCodec.validate_output(data) is True

    def test_multiple_reasoning_items_are_still_rejected(self):
        """The real blocker for hosted web_search on /responses."""
        from router_maestro.providers.copilot_support.responses_codec import (
            CopilotResponsesCodec,
        )

        data = {
            "output": [
                {"type": "reasoning", "summary": [], "id": "rs_1", "encrypted_content": "b1"},
                {"type": "web_search_call", "id": "ws_1", "status": "completed"},
                {"type": "reasoning", "summary": [], "id": "rs_2", "encrypted_content": "b2"},
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]},
            ]
        }
        with pytest.raises(TypeError, match="multiple atomic reasoning items"):
            CopilotResponsesCodec.validate_output(data)
