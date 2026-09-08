"""Native Codex rollout usage; never infer identity from newest files in a cwd.

Only numeric/accounting metadata is retained. Cumulative totals are snapshots,
cached input is a subset of input, and reasoning is a subset of output.
"""
from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger("cockpit.codex_usage")


def _subscription_limits(snapshots):
    """Native observed windows, not a live account query or token estimate."""
    limits, expired = [], False
    now = datetime.now(timezone.utc).timestamp()
    observed = None
    for identifier, snapshot in snapshots.items():
        timestamp = snapshot.get("observed_at")
        if isinstance(timestamp, str) and (observed is None or timestamp > observed):
            observed = timestamp
        name = snapshot.get("limit_name") or ("Codex" if identifier == "codex" else identifier)
        for kind in ("primary", "secondary"):
            window = snapshot.get(kind)
            if not isinstance(window, dict):
                continue
            percent = window.get("used_percent")
            minutes = window.get("window_minutes")
            if (not isinstance(percent, (int, float)) or isinstance(percent, bool)
                    or not math.isfinite(percent) or not 0 <= percent <= 100
                    or _integer(minutes) is None or minutes <= 0):
                continue
            reset = window.get("resets_at")
            reset_iso = None
            if isinstance(reset, (int, float)) and not isinstance(reset, bool) and math.isfinite(reset):
                if reset <= now:
                    expired = True
                    continue
                try:
                    reset_iso = datetime.fromtimestamp(reset, timezone.utc).isoformat()
                except (ValueError, OverflowError, OSError):
                    continue
            if minutes % 1440 == 0:
                amount, unit = minutes // 1440, "day"
            elif minutes % 60 == 0:
                amount, unit = minutes // 60, "hour"
            else:
                amount, unit = minutes, "minute"
            limits.append({"kind": f"{identifier}:{kind}",
                           "label": f"{name} · {amount} {unit}{'s' if amount != 1 else ''}",
                           "percent": percent, "resets_at": reset_iso,
                           "severity": "critical" if percent >= 90 else "warning" if percent >= 75 else "normal"})
    detail = "Observed in this Codex session; may lag account usage."
    if expired:
        detail = "Expired observations are omitted; waiting for updated Codex limits."
    elif not limits:
        detail = "No subscription limits have been observed in this Codex session."
    return {"available": bool(limits), "limits": limits, "detail": detail, "observed_at": observed}


class ReferencePricing:
    def __init__(self):
        try:
            self.data = json.loads(Path(__file__).with_name("codex_pricing.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Codex reference pricing unavailable", exc_info=True)
            self.data = {}

    def price_for(self, model, timestamp):
        row = self.data.get("models", {}).get(model)
        if row is None:
            return None
        return {**row, "long_context_threshold": self.data["long_context_threshold"],
                "source": self.data["source"]}


def reference_pricing():
    return ReferencePricing()


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _usage(value):
    if not isinstance(value, dict):
        return None
    keys = ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens")
    result = {key: _integer(value.get(key)) for key in keys}
    result["cache_write_input_tokens"] = _integer(value.get("cache_write_input_tokens", 0))
    if any(value is None for value in result.values()):
        return None
    if result["cached_input_tokens"] + result["cache_write_input_tokens"] > result["input_tokens"]:
        return None
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        return None
    return result


def _same_directory(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def discover_rollout(pid: int, cwd: str, claimed_paths=(), sessions_root=None, expected_session_id=None):
    """Return the sole root CLI rollout held open by the owned process tree.

    Access failures or multiple plausible roots leave identity unknown. Never
    search by recency: concurrent sessions commonly share a working directory.
    """
    import psutil

    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    root = Path(sessions_root or Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions").resolve()
    claimed = {os.path.normcase(str(Path(path).resolve())) for path in claimed_paths}
    try:
        process = psutil.Process(pid)
        processes = [process] + process.children(recursive=True)
    except (psutil.Error, OSError, ValueError):
        return None
    candidates = set()
    for process in processes:
        try:
            files = process.open_files()
        except (psutil.Error, OSError):
            continue
        for item in files:
            path = Path(item.path).resolve()
            if path.suffix != ".jsonl" or not path.name.startswith("rollout-"):
                continue
            if not path.is_relative_to(root) or os.path.normcase(str(path)) in claimed:
                continue
            try:
                with path.open("rb") as stream:
                    entry = json.loads(stream.readline(2 * 1024 * 1024))
                meta = entry.get("payload") or {}
                if (entry.get("type") == "session_meta" and meta.get("source") == "cli"
                        and meta.get("thread_source", "user") == "user"
                        and isinstance(meta.get("cwd"), str) and _same_directory(meta["cwd"], cwd)
                        and (expected_session_id is None or (meta.get("id") or meta.get("session_id")) == expected_session_id)
                        and (meta.get("id") or meta.get("session_id"))):
                    candidates.add(path)
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    return next(iter(candidates)) if len(candidates) == 1 else None


def _estimate(usage, rate):
    if not isinstance(rate, dict):
        return None
    values = [rate.get(key) for key in ("input_per_mtok", "output_per_mtok", "cache_read_per_mtok")]
    if any(not isinstance(value, (int, float)) or isinstance(value, bool)
           or not math.isfinite(value) or value < 0 for value in values):
        return None
    inp, out, cached = values
    writes = usage.get("cache_write_input_tokens", 0)
    write_rate = rate.get("cache_write_per_mtok", 0 if not writes else None)
    if not isinstance(write_rate, (int, float)) or not math.isfinite(write_rate) or write_rate < 0:
        return None
    if rate.get("long_context_threshold") and usage["input_tokens"] > rate["long_context_threshold"]:
        inp, cached, write_rate, out = inp * 2, cached * 2, write_rate * 2, out * 1.5
    return ((usage["input_tokens"] - usage["cached_input_tokens"] - writes) * inp
            + usage["cached_input_tokens"] * cached + writes * write_rate + usage["output_tokens"] * out) / 1_000_000


class CodexUsageReader:
    """Incrementally read complete lines. ``pricing`` implements price_for(model, timestamp).

    Unknown rates yield None, never Claude fallback prices or a fake zero bill.
    Cost is API-equivalent estimation, not the ChatGPT subscription charge.
    """
    def __init__(self):
        self._files = {}

    @staticmethod
    def _new():
        return {"offset": 0, "session_id": None, "model": None, "totals": None,
                "last": None, "context_window": None, "cost": 0.0, "priced": True,
                "last_event_ts": None, "events": [], "epoch": 0,
                "record_totals": None, "responses": set(), "expects_records": False,
                "subscription_snapshots": {}}

    def forget(self, path):
        self._files.pop(str(Path(path).resolve()), None)

    def take_events(self, path):
        state = self._files.get(str(Path(path).resolve()))
        if state is None:
            return []
        events, state["events"] = state["events"], []
        return events

    def restore_events(self, path, events):
        """Put a failed database batch back before newly observed events."""
        state = self._files.get(str(Path(path).resolve()))
        if state is not None:
            state["events"] = list(events) + state["events"]

    def read(self, path, pricing=None):
        path = Path(path).resolve()
        key = str(path)
        state = self._files.setdefault(key, self._new())
        try:
            if path.stat().st_size < state["offset"]:
                state = self._files[key] = self._new()
            with path.open("rb") as stream:
                stream.seek(state["offset"])
                while True:
                    line = stream.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    state["offset"] = stream.tell()
                    try:
                        entry = json.loads(line)
                        self._consume(state, entry, pricing)
                    except (ValueError, TypeError, AttributeError):
                        continue
        except OSError:
            logger.debug("Codex rollout unavailable: %s", path.name, exc_info=True)
        totals = state["record_totals"] if state["record_totals"] is not None else (state["totals"] or {})
        last = state["last"] or {}
        window = state["context_window"]
        context_tokens = last.get("total_tokens")
        return {"session_id": state["session_id"], "model": state["model"],
                **{key: totals.get(key) for key in ("total_tokens", "input_tokens", "cached_input_tokens", "output_tokens")},
                "context_tokens": context_tokens, "context_window": window,
                "context_percent": (min(100, round(context_tokens * 100 / window))
                                    if window and context_tokens is not None else None),
                "estimated_cost_usd": state["cost"] if state["priced"] and totals else None,
                "price_source": "configured" if state["priced"] and totals else "unpriced",
                "usage_available": bool(totals), "last_event_ts": state["last_event_ts"],
                "subscription_limits": _subscription_limits(state["subscription_snapshots"])}

    @staticmethod
    def _consume(state, entry, pricing):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            return
        if entry.get("type") == "session_meta":
            state["session_id"] = payload.get("id") or payload.get("session_id")
            version = payload.get("cli_version", "")
            try:
                state["expects_records"] = tuple(int(part) for part in version.split(".")[:3]) >= (0, 153, 0)
            except (ValueError, AttributeError):
                state["expects_records"] = False
        elif entry.get("type") == "compacted":
            state["last"] = None
        elif entry.get("type") == "turn_context":
            model = payload.get("model")
            if isinstance(model, str):
                state["model"] = model
        elif entry.get("type") == "token_usage_record":
            response = payload.get("response_id")
            values = _usage(payload.get("usage"))
            if not isinstance(response, str) or not response or values is None:
                return
            if payload.get("thread_id") and payload["thread_id"] != state["session_id"]:
                return
            if response in state["responses"]:
                return
            if state["record_totals"] is None:
                # Per-response accounting is authoritative when available;
                # token_count snapshots can reset after resume/compaction.
                state["record_totals"] = dict.fromkeys(values, 0)
                state["cost"], state["priced"], state["events"] = 0.0, True, []
            state["responses"].add(response)
            for key, value in values.items():
                state["record_totals"][key] += value
            rate = pricing.price_for(state["model"], entry.get("timestamp")) if pricing else None
            estimate = _estimate(values, rate)
            if estimate is None:
                state["priced"] = False
            else:
                state["cost"] += estimate
            state["last_event_ts"] = entry.get("timestamp")
            if state["session_id"] and state["model"] and isinstance(entry.get("timestamp"), str):
                state["events"].append({
                    "session_id": state["session_id"], "uuid": f'codex:{state["session_id"]}:response:{response}',
                    "timestamp": entry["timestamp"], "model": state["model"],
                    "input_tokens": values["input_tokens"] - values["cached_input_tokens"] - values["cache_write_input_tokens"],
                    "cache_read_tokens": values["cached_input_tokens"],
                    "cache_creation_tokens": values["cache_write_input_tokens"],
                    "output_tokens": values["output_tokens"], "estimated_cost_usd": estimate,
                })
        elif entry.get("type") == "event_msg" and payload.get("type") == "token_count":
            limits = payload.get("rate_limits")
            if isinstance(limits, dict):
                identifier = limits.get("limit_id") or "codex"
                if isinstance(identifier, str):
                    # Only accounting fields; never retain arbitrary payload data.
                    state["subscription_snapshots"][identifier] = {
                        "limit_name": limits.get("limit_name") if isinstance(limits.get("limit_name"), str) else None,
                        **{kind: {key: limits[kind].get(key) for key in ("used_percent", "window_minutes", "resets_at")}
                           if isinstance(limits.get(kind), dict) else None for kind in ("primary", "secondary")},
                        "observed_at": entry.get("timestamp"),
                    }
            info = payload.get("info")
            if not isinstance(info, dict):
                return
            window = _integer(info.get("model_context_window"))
            state["context_window"] = window if window else None
            state["last"] = _usage(info.get("last_token_usage"))
            if state["record_totals"] is not None:
                return
            totals = _usage(info.get("total_token_usage"))
            if totals is None:
                return
            prior = state["totals"] or dict.fromkeys(totals, 0)
            delta = {key: totals[key] - prior[key] for key in totals}
            if (any(value < 0 for value in delta.values())
                    or delta["cached_input_tokens"] + delta["cache_write_input_tokens"] > delta["input_tokens"]):
                state["priced"] = False
                state["epoch"] += 1
            elif delta["total_tokens"]:
                rate = pricing.price_for(state["model"], entry.get("timestamp")) if pricing else None
                estimate = _estimate(delta, rate)
                if estimate is None:
                    state["priced"] = False
                else:
                    state["cost"] += estimate
                if (not state["expects_records"] and state["session_id"] and state["model"]
                        and isinstance(entry.get("timestamp"), str)):
                    state["events"].append({
                        "session_id": state["session_id"],
                        "uuid": (f'codex:{state["session_id"]}:{state["epoch"]}:'
                                 f'{totals["input_tokens"]}:{totals["output_tokens"]}'),
                        "timestamp": entry["timestamp"], "model": state["model"],
                        "input_tokens": delta["input_tokens"] - delta["cached_input_tokens"] - delta["cache_write_input_tokens"],
                        "cache_read_tokens": delta["cached_input_tokens"],
                        "cache_creation_tokens": delta["cache_write_input_tokens"],
                        "output_tokens": delta["output_tokens"], "estimated_cost_usd": estimate,
                    })
            state["totals"] = totals
            state["last_event_ts"] = entry.get("timestamp")
