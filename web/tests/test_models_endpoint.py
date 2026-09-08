"""Tests for GET /api/models — the live model catalog that drives the picker.

The Anthropic API is never contacted: server._fetch_models_blocking (which does
the real urllib call) is monkeypatched. Also covers the drift-proof model-id
validator in pty_manager so live-picker ids actually spawn.
"""
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server as server_module  # noqa: E402
from server import app  # noqa: E402
import pty_manager as pty_module  # noqa: E402


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture(autouse=True)
def _clear_cache():
    # Each test starts with an empty catalog cache so results are deterministic.
    server_module._MODELS_CACHE["data"] = None
    server_module._MODELS_CACHE["ts"] = 0.0
    yield


@pytest.mark.asyncio
async def test_models_live_passthrough(client, monkeypatch):
    live = [
        {"id": "claude-opus-5", "display_name": "Claude Opus 5"},
        {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"},
    ]
    monkeypatch.setattr(server_module, "_fetch_models_blocking", lambda: live)
    res = await client.get("/api/models")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "live"
    assert body["models"] == live


@pytest.mark.asyncio
async def test_models_fallback_when_fetch_fails(client, monkeypatch):
    monkeypatch.setattr(server_module, "_fetch_models_blocking", lambda: None)
    res = await client.get("/api/models")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "fallback"
    ids = [m["id"] for m in body["models"]]
    assert "claude-opus-5" in ids  # static list is never empty


@pytest.mark.asyncio
async def test_models_serves_stale_cache_after_failure(client, monkeypatch):
    # A zero timestamp is still fresh on a runner booted less than one TTL ago.
    # Replace the server's clock reference, not the shared time module used by asyncio.
    clock = Mock(wraps=server_module._time)
    clock.monotonic.return_value = 1.0
    monkeypatch.setattr(server_module, "_time", clock)
    good = [{"id": "claude-opus-5", "display_name": "Claude Opus 5"}]
    monkeypatch.setattr(server_module, "_fetch_models_blocking", lambda: good)
    first = await client.get("/api/models")
    assert first.json()["source"] == "live"

    # Force TTL expiry, then make the refresh fail — we should get the old cache.
    clock.monotonic.return_value += server_module._MODELS_TTL
    monkeypatch.setattr(server_module, "_fetch_models_blocking", lambda: None)
    stale = await client.get("/api/models")
    assert stale.json()["source"] == "stale"
    assert stale.json()["models"] == good


@pytest.mark.asyncio
@pytest.mark.parametrize("ttl_offset,expected_source,refreshes", [
    (-0.001, "live", 0),
    (0.0, "stale", 1),
    (0.001, "stale", 1),
])
async def test_models_cache_expiry_boundary(client, monkeypatch, ttl_offset, expected_source, refreshes):
    good = [{"id": "claude-opus-5", "display_name": "Claude Opus 5"}]
    server_module._MODELS_CACHE.update(data=good, ts=1.0)
    clock = Mock(wraps=server_module._time)
    clock.monotonic.return_value = 1.0 + server_module._MODELS_TTL + ttl_offset
    monkeypatch.setattr(server_module, "_time", clock)
    fetch = Mock(return_value=None)
    monkeypatch.setattr(server_module, "_fetch_models_blocking", fetch)

    response = await client.get("/api/models")

    assert response.status_code == 200
    assert response.json() == {"models": good, "source": expected_source}
    assert fetch.call_count == refreshes


def test_read_oauth_token_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(server_module, "_CREDENTIALS_PATH", tmp_path / "nope.json")
    assert server_module._read_oauth_token() is None


def test_read_oauth_token_parses(monkeypatch, tmp_path):
    cred = tmp_path / "creds.json"
    cred.write_text('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc"}}', encoding="utf-8")
    monkeypatch.setattr(server_module, "_CREDENTIALS_PATH", cred)
    assert server_module._read_oauth_token() == "sk-ant-oat01-abc"


@pytest.mark.parametrize(
    "model_id",
    [
        "claude-opus-5",
        "claude-opus-5[1m]",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-6[1m]",
        "sonnet",  # alias still accepted
    ],
)
def test_model_regex_accepts_valid_ids(model_id):
    assert (
        model_id in pty_module._ALLOWED_MODELS
        or pty_module._ANTHROPIC_MODEL_RE.match(model_id)
    )


@pytest.mark.parametrize(
    "bad",
    [
        "sonnet --dangerously-skip-permissions",
        "--model",
        "-rf /",
        "opus; rm -rf /",
        "opus`whoami`",
        "opus$(id)",
        'opus"x',
    ],
)
def test_model_regex_rejects_injection(bad):
    assert bad not in pty_module._ALLOWED_MODELS
    assert not pty_module._ANTHROPIC_MODEL_RE.match(bad)
