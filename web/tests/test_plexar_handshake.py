"""Gate for `GET /.well-known/plexar` — the estate-wide product handshake.

Three properties are load-bearing and each has an arm here:

1. It answers **200 whenever the process is up**, with `authenticated` derived
   from the device store. A missing or garbage token is `false`, never a 401 —
   a 401 merges "wrong credential" with "server down" and those have opposite
   remedies.
2. It is reachable through a tunnel (public `Host`, no `Origin`) *and* from
   loopback, because it is origin-exempt — while `/api/terminals` with that
   SAME tunnel Host is still 403. That pairing is the anti-regression trap: an
   exemption written one character too wide would open the whole surface.
3. The body carries no secret, path, hostname or private count.

Every negative arm has a positive twin, and the tunnel arm doubles as the proof
that the guard is not simply allowing everything.
"""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient

import origin_guard
import remote_gateway
import server
from server import app

LOOPBACK = "http://127.0.0.1:8420"
TUNNEL = "http://studio.example.com"


def _client(base_url: str = LOOPBACK, headers: dict | None = None):
    return AsyncClient(
        transport=ASGITransport(app=app), base_url=base_url, headers=headers or {}
    )


@pytest.fixture
def remote_on(monkeypatch):
    monkeypatch.setattr(remote_gateway, "remote_enabled", lambda: True)


@pytest.fixture
def remote_off(monkeypatch):
    monkeypatch.setattr(remote_gateway, "remote_enabled", lambda: False)


# ── The exemption predicate, in the module that owns it ───────────────────

def test_the_handshake_path_is_exempt():
    assert origin_guard.is_handshake_path("/.well-known/plexar")
    assert origin_guard.is_origin_exempt("/.well-known/plexar")


@pytest.mark.parametrize(
    "path",
    [
        "/.well-known/plexar/x",   # a deeper route inherits nothing
        "/.well-known/plexarx",
        "/.well-known/",
        "/well-known/plexar",
        "/api/terminals",
        "/api/remote/status",
    ],
)
def test_nothing_else_becomes_exempt(path):
    """Negative twin of the arm above: the carve-out is exactly one path."""
    assert not origin_guard.is_handshake_path(path)


def test_the_remote_exemption_still_stands():
    """`is_origin_exempt` must not have replaced the older carve-out."""
    assert origin_guard.is_origin_exempt("/remote/v1/hello")


# ── 200 whenever we are up ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unauthenticated_answers_200(remote_on):
    async with _client() as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    body = r.json()
    assert body["plexar"] == 1
    assert body["product"] == "studio"
    assert body["name"] == "Plexar Studio"
    assert body["auth"] == "device-token"
    assert body["authenticated"] is False
    assert body["version"] == server._app_version()


@pytest.mark.asyncio
async def test_a_garbage_token_is_false_not_401(remote_on):
    """The whole point of the route: a bad credential is an ANSWER."""
    async with _client(headers={"Authorization": "Bearer not-a-real-token"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    assert r.json()["authenticated"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("header", ["", "Bearer", "Basic abc", "Bearer    "])
async def test_malformed_authorization_headers_are_false_not_500(remote_on, header):
    async with _client(headers={"Authorization": header} if header else None) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    assert r.json()["authenticated"] is False


@pytest.mark.asyncio
async def test_a_valid_device_token_reports_authenticated(remote_on, monkeypatch):
    """Positive twin. Without it, a hardcoded `False` passes every arm above."""
    seen = {}

    class _Store:
        def authenticate(self, token):
            seen["token"] = token
            return object() if token == "good-token" else None

    monkeypatch.setattr(server, "_remote_device_store", _Store())
    async with _client(headers={"Authorization": "Bearer good-token"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    assert r.json()["authenticated"] is True
    assert seen["token"] == "good-token"

    async with _client(headers={"Authorization": "Bearer other-token"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.json()["authenticated"] is False


@pytest.mark.asyncio
async def test_a_broken_device_store_still_answers_200(remote_on, monkeypatch):
    class _Broken:
        def authenticate(self, token):
            raise RuntimeError("device file is corrupt")

    monkeypatch.setattr(server, "_remote_device_store", _Broken())
    async with _client(headers={"Authorization": "Bearer x"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    assert r.json()["authenticated"] is False


# ── Capabilities follow remote.enabled ────────────────────────────────────

@pytest.mark.asyncio
async def test_capabilities_are_offered_when_remote_is_on(remote_on):
    async with _client() as c:
        body = (await c.get("/.well-known/plexar")).json()
    assert body["capabilities"] == [
        "sessions", "terminal", "chat", "spawn", "upload", "files",
    ]
    assert body["detail"] == {"remote_enabled": True}


@pytest.mark.asyncio
async def test_disabled_still_answers_200_with_empty_capabilities(remote_off):
    """The one place the remote surface is not 404-when-disabled.

    A hub must be able to tell "off" from "absent" — otherwise the user reads
    "unreachable" when the real cause is an unticked checkbox.
    """
    async with _client() as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    body = r.json()
    assert body["capabilities"] == []
    assert body["detail"] == {"remote_enabled": False}
    assert body["authenticated"] is False


@pytest.mark.asyncio
async def test_every_other_remote_route_still_404s_when_disabled(remote_off):
    """The handshake's exception must not have leaked to the rest of /remote/v1."""
    async with _client(headers={"Authorization": "Bearer whatever"}) as c:
        r = await c.get("/remote/v1/hello")
    assert r.status_code == 404


# ── Reachability: tunnel and loopback, and the trap beside it ─────────────

@pytest.mark.asyncio
async def test_reachable_through_a_tunnel_host_with_no_origin(remote_on):
    """The phone's shape: public Host, no Origin — both clauses would refuse."""
    async with _client(TUNNEL) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    assert r.json()["product"] == "studio"


@pytest.mark.asyncio
async def test_reachable_from_loopback_too(remote_on):
    async with _client(LOOPBACK, {"Origin": "http://localhost:8420"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_the_same_tunnel_host_is_still_403_on_api_terminals():
    """THE ANTI-REGRESSION TRAP.

    The exemption is one path. If it ever widens, this arm reddens — and it is
    the arm that proves the guard is still doing its job rather than the
    handshake passing because everything now passes.
    """
    async with _client(TUNNEL) as c:
        r = await c.get("/api/terminals")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_a_foreign_origin_reaches_the_handshake_by_design(remote_on):
    """Stated, not accidental: §1.2 of the spec accepts this disclosure.

    The route has no side effect and returns no credential, and a page can
    already infer the product's presence from a 403 versus a refused connection.
    """
    async with _client(LOOPBACK, {"Origin": "https://evil.example"}) as c:
        r = await c.get("/.well-known/plexar")
    assert r.status_code == 200
    # ...and that same page still cannot read anything that matters:
    async with _client(LOOPBACK, {"Origin": "https://evil.example"}) as c:
        assert (await c.get("/api/terminals")).status_code == 403


# ── The body discloses nothing ────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("fixture_name", ["remote_on", "remote_off"])
async def test_body_carries_no_secret_path_or_hostname(request, fixture_name):
    request.getfixturevalue(fixture_name)
    async with _client(headers={"Authorization": "Bearer x"}) as c:
        body = (await c.get("/.well-known/plexar")).json()

    banned = ("token", "secret", "cookie", "path", "dir", "jsonl")

    # ONE documented exception, and it is a scheme NAME, not a credential: the
    # spec contracts `"auth": "device-token"` so a hub knows which credential to
    # present. It discloses nothing — the whole estate uses the same vocabulary.
    # Every other key and value, including `auth`'s own key, is checked.
    assert body.pop("auth") == "device-token"

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                assert not any(b in key.lower() for b in banned), key
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            assert not any(b in node.lower() for b in banned), node

    walk(body)
    # No stray field beyond the contracted eight, either.
    assert set(body) == {
        "plexar", "product", "name", "version",
        "authenticated", "capabilities", "detail",
    }  # `auth` was popped above
    # And nothing that looks like a filesystem path or a count.
    assert "\\" not in json.dumps(body)
