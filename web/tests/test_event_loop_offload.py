"""Nothing blocking runs on the event loop (R-191).

2026-09-10. Paste failed after 20 s, the phone dropped, and Settings ▸ Remote looked
down while the connector was up with four connections. `supervisor.log` showed the
sidecar missing health probes several times a minute. A py-spy profile of the live
sidecar showed why: MainThread — the event loop, the ONE thread that serves every
request — was executing blocking work directly:

  * `/api/git/status`   two `subprocess.run(git ...)`, polled per pane every 30 s
  * `/api/system`       `psutil.cpu_percent(interval=0.1)`, a 100 ms SLEEP, every 5 s
  * `/api/version`      a PATH scan (`shutil.which`) — the watchdog's own probe
  * remote sessions     per phone poll, per session: transcript stat + tail + .git/HEAD

Each is cheap alone (13-38 ms measured). On the loop they are not cheap: while one
runs, nothing else is served.

Two guards, because either alone is insufficient:

  * BEHAVIOURAL — a heartbeat on the loop must keep ticking while a route runs a
    deliberately slow version of its blocking call. That is the property a user
    experiences, and it fails on the pre-fix code.
  * STRUCTURAL — no async route calls a known-blocking function directly. A
    per-route test does not stop the next route from doing it; this does. It
    carries its own positive arm, so it cannot pass by matching nothing.
"""

import ast
import asyncio
import pathlib
import subprocess
import time

import pytest
from httpx import ASGITransport, AsyncClient

import logging_config

logging_config.setup("WARNING")

import server as server_module  # noqa: E402
from server import app  # noqa: E402

WEB = pathlib.Path(__file__).resolve().parents[1]

#: How long each faked blocking call takes.
BLOCK_S = 0.5
#: A heartbeat gap this long means the loop was blocked. Half of BLOCK_S, so a
#: blocking call on the loop cannot slip under it, while scheduler noise does.
MAX_GAP_S = 0.25
TICK_S = 0.01


def _client() -> AsyncClient:
    # Loopback base_url: the origin guard refuses a non-loopback Host.
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


async def _max_loop_gap_during(coro):
    """Await *coro* while a heartbeat ticks on the SAME loop; return (result, worst gap)."""
    gaps: list[float] = []
    stop = asyncio.Event()

    async def heartbeat():
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(TICK_S)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    await asyncio.sleep(TICK_S * 3)  # a baseline before the request starts
    try:
        result = await coro
    finally:
        stop.set()
        await beat
    return result, max(gaps)


# ── BEHAVIOURAL ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_git_status_does_not_block_the_loop(monkeypatch, tmp_path):
    calls = []

    def slow_run(argv, **kwargs):
        calls.append(argv)
        time.sleep(BLOCK_S)
        out = "main\n" if "rev-parse" in argv else ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(server_module.subprocess, "run", slow_run)
    async with _client() as c:
        res, gap = await _max_loop_gap_during(c.get(f"/api/git/status?path={tmp_path}"))

    assert res.status_code == 200
    assert len(calls) == 2, "both git subprocesses must still run"
    assert res.json()["branch"] == "main"
    assert gap < MAX_GAP_S, f"event loop blocked for {gap:.2f}s during /api/git/status"


@pytest.mark.asyncio
async def test_system_stats_does_not_block_the_loop(monkeypatch):
    import psutil

    def slow_cpu(interval=None, percpu=False):
        time.sleep(BLOCK_S)
        return 12.3

    async def no_nvidia_smi(*args, **kwargs):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(psutil, "cpu_percent", slow_cpu)
    # Keep the real GPU probe out of a unit test; the route treats this as "no GPU".
    monkeypatch.setattr(server_module.asyncio, "create_subprocess_exec", no_nvidia_smi)
    async with _client() as c:
        res, gap = await _max_loop_gap_during(c.get("/api/system"))

    assert res.status_code == 200
    assert res.json()["cpu_percent"] == 12.3
    assert gap < MAX_GAP_S, f"event loop blocked for {gap:.2f}s during /api/system"


@pytest.mark.asyncio
async def test_version_does_not_block_the_loop(monkeypatch):
    """`/api/version` is the route the Tauri watchdog probes every 5 s."""

    def slow_resolve(search_path):
        time.sleep(BLOCK_S)
        return ("C:/fake/claude.exe", search_path)

    async def fake_version(path):
        return "9.9.9"

    monkeypatch.setattr(server_module.pty_manager_module, "resolve_claude_cli", slow_resolve)
    monkeypatch.setattr(server_module, "_cli_version_for", fake_version)
    async with _client() as c:
        res, gap = await _max_loop_gap_during(c.get("/api/version"))

    assert res.status_code == 200
    assert res.json()["cli"] == "9.9.9"
    assert gap < MAX_GAP_S, f"event loop blocked for {gap:.2f}s during /api/version"


# ── STRUCTURAL ──────────────────────────────────────────────────────────────

#: (module, function) pairs that block the calling thread.
KNOWN_BLOCKING = {
    ("subprocess", "run"),
    ("subprocess", "check_output"),
    ("subprocess", "check_call"),
    ("subprocess", "call"),
    ("subprocess", "Popen"),
    ("time", "sleep"),
    ("shutil", "which"),
    ("psutil", "cpu_percent"),
    ("psutil", "virtual_memory"),
}

#: Project helpers that do file or process I/O and must never run on the loop.
#: Named explicitly because a scan for stdlib calls cannot see through them —
#: which is exactly how `/api/version`'s PATH scan escaped the first sweep.
KNOWN_BLOCKING_HELPERS = {
    "resolve_claude_cli",
    "_session_view",
    "latest_preview",
    "_git_branch_from_head",
}

OFFLOADERS = ("to_thread", "run_in_executor", "run_in_threadpool")
ROUTE_DECORATORS = {"get", "post", "put", "delete", "patch", "websocket"}


def _dotted(node) -> str:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _is_route(fn: ast.AsyncFunctionDef) -> bool:
    return any(
        isinstance(d, ast.Call)
        and isinstance(d.func, ast.Attribute)
        and d.func.attr in ROUTE_DECORATORS
        for d in fn.decorator_list
    )


def blocking_calls_on_loop(source: str) -> list[tuple[str, int, str]]:
    """Every known-blocking call made DIRECTLY inside an async route body.

    A call counts as offloaded when it sits anywhere inside an argument to
    `to_thread` / `run_in_executor` / `run_in_threadpool` — including inside a
    lambda passed there.
    """
    hits = []
    for fn in ast.walk(ast.parse(source)):
        if not isinstance(fn, ast.AsyncFunctionDef) or not _is_route(fn):
            continue
        offloaded: set[int] = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Call) and _dotted(node.func).endswith(OFFLOADERS):
                for arg in node.args:
                    offloaded.update(id(m) for m in ast.walk(arg))
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call) or id(node) in offloaded:
                continue
            name = _dotted(node.func)
            mod, _, attr = name.rpartition(".")
            if (mod.split(".")[-1], attr) in KNOWN_BLOCKING or (attr or name) in KNOWN_BLOCKING_HELPERS:
                hits.append((fn.name, node.lineno, name))
    return hits


def test_the_scanner_is_not_vacuous():
    """The positive arm. A scanner that matches nothing would pass every file."""
    bad = '''
@app.get("/x")
async def x():
    subprocess.run(["git"])
    pty_manager_module.resolve_claude_cli("")
    time.sleep(1)
'''
    good = '''
@app.get("/y")
async def y():
    await asyncio.to_thread(subprocess.run, ["git"])
    await asyncio.to_thread(lambda: psutil.cpu_percent(interval=0.1))
    await asyncio.to_thread(pty_manager_module.resolve_claude_cli, "")
'''
    found = {name for _fn, _ln, name in blocking_calls_on_loop(bad)}
    assert found == {"subprocess.run", "pty_manager_module.resolve_claude_cli", "time.sleep"}
    assert blocking_calls_on_loop(good) == []


@pytest.mark.parametrize("module", ["server.py", "remote_gateway.py"])
def test_no_async_route_blocks_the_loop(module):
    hits = blocking_calls_on_loop((WEB / module).read_text(encoding="utf-8"))
    assert hits == [], "blocking calls made directly on the event loop:\n" + "\n".join(
        f"  {module}:{ln}  {fn}() -> {name}" for fn, ln, name in hits
    )
