"""Tests for the local-lane broker proxy routes.

Covers:
  1. GET /api/local/queue proxies the broker JSON verbatim.
  2. GET /api/local/queue returns 503 {reachable: false} when the broker is down.
  3. GET /api/local/metrics proxies the broker JSON and forwards the window.
  4. GET /api/local/metrics rejects an invalid window with 400 (never forwarded).
  5. GET /api/local/metrics defaults to window=lifetime.
  6. POST /api/local/spill returns 501 (broker control endpoint not wired yet).

The broker itself is never contacted — server._broker_get is monkeypatched.
Uses httpx AsyncClient + ASGITransport, matching the existing test pattern.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_queue_proxies_broker_json(client, monkeypatch):
    payload = {
        "in_flight": {"id": "abc123", "class": "workhorse"},
        "queued": [{"id": "def456", "class": "mundane"}],
        "estimated_clear_seconds": 42,
        "spill": 0,
    }

    def fake_get(path, query=""):
        assert path == "/queue"
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/queue")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_queue_offline_returns_503(client, monkeypatch):
    def fake_get(path, query=""):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/queue")
    assert res.status_code == 503
    assert res.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_metrics_proxies_and_forwards_window(client, monkeypatch):
    seen = {}

    def fake_get(path, query=""):
        seen["path"] = path
        seen["query"] = query
        return {"runs_total": 10, "prompts_total": 8, "window": "24h"}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics?window=24h")
    assert res.status_code == 200
    assert res.json()["runs_total"] == 10
    assert seen["path"] == "/metrics"
    assert seen["query"] == "window=24h"


@pytest.mark.asyncio
async def test_metrics_invalid_window_400_not_forwarded(client, monkeypatch):
    called = {"n": 0}

    def fake_get(path, query=""):
        called["n"] += 1
        return {}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics?window=../etc/passwd")
    assert res.status_code == 400
    assert called["n"] == 0  # never forwarded to the broker


@pytest.mark.asyncio
async def test_metrics_defaults_to_lifetime(client, monkeypatch):
    seen = {}

    def fake_get(path, query=""):
        seen["query"] = query
        return {}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics")
    assert res.status_code == 200
    assert seen["query"] == "window=lifetime"


@pytest.mark.asyncio
async def test_spill_get_proxies_broker(client, monkeypatch):
    payload = {
        "spill_thresholds_s": {"interactive": 30.0, "worker": 300.0, "batch": None},
        "spilled_total": 5,
        "spilled_by_class": {"interactive": 5},
        "persisted": False,
    }

    def fake_get(path, query=""):
        assert path == "/config/spill"
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/spill")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_spill_put_forwards_partial_map(client, monkeypatch):
    seen = {}

    def fake_put(path, body):
        seen["path"] = path
        seen["body"] = body
        return {"spill_thresholds_s": {"interactive": 45, "worker": 300.0, "batch": None}}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"interactive": 45})
    assert res.status_code == 200
    assert seen["path"] == "/config/spill"
    assert seen["body"] == {"interactive": 45}
    assert res.json()["spill_thresholds_s"]["interactive"] == 45


@pytest.mark.asyncio
async def test_spill_put_accepts_null_to_disable(client, monkeypatch):
    monkeypatch.setattr(server_module, "_broker_put", lambda path, body: {"echo": body})
    res = await client.post("/api/local/spill", json={"batch": None})
    assert res.status_code == 200
    assert res.json()["echo"] == {"batch": None}


@pytest.mark.asyncio
async def test_spill_put_rejects_unknown_class_not_forwarded(client, monkeypatch):
    called = {"n": 0}

    def fake_put(path, body):
        called["n"] += 1
        return {}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"gpu": 10})
    assert res.status_code == 400
    assert called["n"] == 0  # invalid class never reaches the broker


@pytest.mark.asyncio
async def test_spill_put_rejects_out_of_range(client, monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(server_module, "_broker_put", lambda path, body: called.__setitem__("n", called["n"] + 1) or {})
    res = await client.post("/api/local/spill", json={"interactive": 999999})
    assert res.status_code == 400
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_spill_put_rejects_empty_body(client):
    res = await client.post("/api/local/spill", json={})
    assert res.status_code == 400
