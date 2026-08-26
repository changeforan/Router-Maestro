"""Model priority configuration."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class FallbackStrategy(StrEnum):
    """Fallback strategy options."""

    PRIORITY = "priority"  # Fallback to next model in priorities list
    SAME_MODEL = "same-model"  # Only fallback to providers with the same model
    NONE = "none"  # Disable fallback, fail immediately


class FallbackConfig(BaseModel):
    """Fallback configuration."""

    strategy: FallbackStrategy = Field(
        default=FallbackStrategy.PRIORITY,
        description="Fallback strategy",
    )
    maxRetries: int = Field(  # noqa: N815
        default=2,
        ge=0,
        le=10,
        description="Maximum number of fallback retries",
    )


class ModelOverride(BaseModel):
    """Per-model token limit overrides."""

    max_prompt_tokens: int | None = None
    max_output_tokens: int | None = None
    max_context_window_tokens: int | None = None


class ThinkingBudgetConfig(BaseModel):
    """Server-side thinking budget defaults."""

    default_budget: int = Field(default=16000, ge=1024, le=128000)
    auto_enable: bool = Field(
        default=False,
        description="Auto-enable thinking for capable models when client doesn't request it",
    )
    model_budgets: dict[str, int] = Field(
        default_factory=dict,
        description="Per-model budget overrides keyed by model name",
    )


class LeakGuardConfig(BaseModel):
    """Leak guard configuration."""

    enabled: bool = Field(default=True, description="Enable response leak detection")


class RunawayGuardConfig(BaseModel):
    """Runaway guard configuration."""

    enabled: bool = Field(default=True, description="Enable runaway generation detection")
    max_bytes: int = Field(
        default=10_000_000,
        ge=100_000,
        description="Abort if total streamed bytes exceed this",
    )
    max_deltas: int = Field(
        default=50_000,
        ge=1000,
        description="Delta count threshold for tiny-fragment detection",
    )


class GuardsConfig(BaseModel):
    """Stream guards configuration."""

    leak_guard: LeakGuardConfig = Field(default_factory=LeakGuardConfig)
    runaway_guard: RunawayGuardConfig = Field(default_factory=RunawayGuardConfig)


class AuditConfig(BaseModel):
    """Per-request audit tracing configuration."""

    enabled: bool = Field(default=False, description="Enable per-request audit tracing")
    trace_dir: str | None = Field(
        default=None,
        description="Directory for trace files (default: ~/.local/share/router-maestro/traces/)",
    )


class WebSearchConfig(BaseModel):
    """Router-Maestro-local ``web_search`` tool configuration.

    When enabled, Router-Maestro executes web searches server-side on behalf of
    models whose upstream cannot run Anthropic's hosted ``web_search`` server
    tool (notably Claude via GitHub Copilot).

    The default ``github_mcp`` backend calls the same Bing-backed ``web_search``
    tool the GitHub Copilot CLI uses, reusing the stored GitHub Copilot OAuth
    credential — no extra API key or quota. The ``google`` backend needs its own
    credentials; only environment variable *names* are stored here, never the
    values themselves.
    """

    enabled: bool = Field(
        default=False,
        description="Enable the Router-Maestro-local web_search tool",
    )
    backend: Literal["github_mcp", "google"] = Field(
        default="github_mcp",
        description=(
            "Search backend: 'github_mcp' reuses the GitHub Copilot credential; "
            "'google' uses the Custom Search JSON API"
        ),
    )
    api_key_env: str = Field(
        default="GOOGLE_SEARCH_API_KEY",
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
        description="Environment variable supplying the google backend API key",
    )
    cse_id_env: str = Field(
        default="GOOGLE_SEARCH_CSE_ID",
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
        description="Environment variable supplying the Google Programmable Search engine ID",
    )
    max_uses: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum web_search invocations executed per client request",
    )
    max_results: int = Field(
        default=5,
        ge=1,
        le=10,
        description="Maximum results returned per search (google backend)",
    )
    timeout_seconds: float = Field(
        default=60.0,
        gt=0,
        le=120,
        description="Timeout for a single upstream search API call",
    )
    emit_native_blocks: bool = Field(
        default=True,
        description=(
            "Emit Anthropic-native server_tool_use and web_search_tool_result blocks "
            "so clients can render sources. Disable for a text-only response."
        ),
    )


class PrioritiesConfig(BaseModel):
    """Configuration for model priorities and fallback."""

    priorities: list[str] = Field(
        default_factory=list,
        description="Model priorities in format 'provider/model', highest to lowest",
    )
    fallback: FallbackConfig = Field(default_factory=FallbackConfig)
    model_overrides: dict[str, ModelOverride] = Field(
        default_factory=dict,
        description="Per-model token limit overrides keyed by 'provider/model' or 'model'",
    )
    thinking: ThinkingBudgetConfig = Field(default_factory=ThinkingBudgetConfig)
    guards: GuardsConfig = Field(default_factory=GuardsConfig)
    beta_strip: list[str] = Field(
        default_factory=list,
        description="anthropic-beta tokens to strip (supports trailing * wildcard)",
    )
    audit: AuditConfig = Field(default_factory=AuditConfig)
    web_search: WebSearchConfig = Field(default_factory=WebSearchConfig)

    @classmethod
    def get_default(cls) -> PrioritiesConfig:
        """Get default empty priorities configuration."""
        return cls(priorities=[])

    def get_priority(self, provider: str, model: str) -> int:
        """Get priority for a model.

        Args:
            provider: Provider name
            model: Model ID

        Returns:
            Priority index (lower = higher priority), or 999999 if not in list
        """
        key = f"{provider}/{model}"
        try:
            return self.priorities.index(key)
        except ValueError:
            return 999999

    def add_priority(self, provider: str, model: str, position: int | None = None) -> None:
        """Add a model to priorities.

        Args:
            provider: Provider name
            model: Model ID
            position: Position to insert (None = append to end)
        """
        key = f"{provider}/{model}"
        # Remove if already exists
        if key in self.priorities:
            self.priorities.remove(key)
        # Insert at position
        if position is None:
            self.priorities.append(key)
        else:
            self.priorities.insert(position, key)

    def remove_priority(self, provider: str, model: str) -> bool:
        """Remove a model from priorities.

        Args:
            provider: Provider name
            model: Model ID

        Returns:
            True if removed, False if not found
        """
        key = f"{provider}/{model}"
        if key in self.priorities:
            self.priorities.remove(key)
            return True
        return False
