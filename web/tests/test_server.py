"""Tests for server endpoints — uses FastAPI TestClient."""

import pytest
from httpx import AsyncClient, ASGITransport

# Import must happen after env setup
import logging_config
logging_config.setup("WARNING")

from server import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_health_endpoint(client):
    res = await client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "sessions" in data
    assert "uptime_seconds" in data


@pytest.mark.asyncio
async def test_browse_drives(client):
    res = await client.get("/api/browse")
    assert res.status_code == 200
    data = res.json()
    assert "dirs" in data
    # On Windows, should have at least C:\
    assert len(data["dirs"]) > 0


@pytest.mark.asyncio
async def test_browse_invalid_path(client):
    res = await client.get("/api/browse?path=Z:\\definitely_not_real_path_xyz")
    assert res.status_code == 200
    data = res.json()
    assert data["dirs"] == []


@pytest.mark.asyncio
async def test_me_unauthenticated(client):
    """Without session cookie on non-localhost, /api/me returns unauthenticated."""
    res = await client.get("/api/me")
    assert res.status_code == 200
    data = res.json()
    # Test client hostname is "test", not localhost, so auth bypass doesn't apply
    assert data["authenticated"] is False


@pytest.mark.asyncio
async def test_git_status_non_git_dir(client):
    """Git status on a non-git directory returns git=False."""
    import tempfile
    import os
    with tempfile.TemporaryDirectory() as tmpdir:
        res = await client.get(f"/api/git/status?path={tmpdir}")
        assert res.status_code == 200
        data = res.json()
        assert data["git"] is False
