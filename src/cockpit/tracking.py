"""Token usage tracking and cost calculation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime


# Pricing per million tokens (Claude Opus 4)
PRICING = {
    "claude-opus-4-6": {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00},
}

DEFAULT_MODEL = "claude-sonnet-4-6"


@dataclass
class UsageSnapshot:
    """Single interaction's token usage."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float = 0.0
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class SessionUsage:
    """Cumulative usage for a session."""

    snapshots: list[UsageSnapshot] = field(default_factory=list)

    @property
    def total_input(self) -> int:
        return sum(s.input_tokens for s in self.snapshots)

    @property
    def total_output(self) -> int:
        return sum(s.output_tokens for s in self.snapshots)

    @property
    def total_cost(self) -> float:
        return sum(s.cost_usd for s in self.snapshots)

    @property
    def total_tokens(self) -> int:
        return self.total_input + self.total_output

    def add(self, snapshot: UsageSnapshot) -> None:
        self.snapshots.append(snapshot)


@dataclass
class GlobalUsage:
    """Aggregate usage across all sessions."""

    sessions: dict[str, SessionUsage] = field(default_factory=dict)

    def get_or_create(self, session_id: str) -> SessionUsage:
        if session_id not in self.sessions:
            self.sessions[session_id] = SessionUsage()
        return self.sessions[session_id]

    @property
    def total_cost(self) -> float:
        return sum(s.total_cost for s in self.sessions.values())

    @property
    def total_tokens(self) -> int:
        return sum(s.total_tokens for s in self.sessions.values())

    @property
    def total_input(self) -> int:
        return sum(s.total_input for s in self.sessions.values())

    @property
    def total_output(self) -> int:
        return sum(s.total_output for s in self.sessions.values())


def parse_usage_from_result(data: dict) -> UsageSnapshot | None:
    """Parse a 'result' type JSON line from claude --output-format stream-json."""
    if data.get("type") != "result":
        return None

    usage = data.get("usage", {})
    cost = data.get("cost_usd", 0.0)

    return UsageSnapshot(
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
        cache_read_tokens=usage.get("cache_creation_input_tokens", 0),
        cache_write_tokens=usage.get("cache_read_input_tokens", 0),
        cost_usd=cost if cost else 0.0,
    )


def format_tokens(n: int) -> str:
    """Format token count for display."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def format_cost(usd: float) -> str:
    """Format cost for display."""
    if usd < 0.01:
        return f"${usd:.4f}"
    return f"${usd:.2f}"
