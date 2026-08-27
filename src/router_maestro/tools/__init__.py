"""Router-Maestro-local tools executed server-side on behalf of models."""

from router_maestro.tools.web_search import (
    WEB_SEARCH_TOOL_NAME,
    GitHubMCPBackend,
    SearchBackend,
    SearchCitation,
    SearchOutcome,
    WebSearchError,
    build_backend,
    is_active,
    is_server_web_search_tool,
    local_tool_definition,
    parse_query,
    resolve_github_token,
    run_search,
)

__all__ = [
    "WEB_SEARCH_TOOL_NAME",
    "GitHubMCPBackend",
    "SearchBackend",
    "SearchCitation",
    "SearchOutcome",
    "WebSearchError",
    "build_backend",
    "is_active",
    "is_server_web_search_tool",
    "local_tool_definition",
    "parse_query",
    "resolve_github_token",
    "run_search",
]
