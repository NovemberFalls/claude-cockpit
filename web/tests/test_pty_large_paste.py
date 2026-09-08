"""Real PTY receipt through the production paced writer; no model process."""
import asyncio
import hashlib
import os
import subprocess
import sys
import threading

import pytest

from pty_manager import PtyManager, TerminalSession


@pytest.mark.skipif(sys.platform != "win32", reason="Windows console-host receipt regression")
@pytest.mark.parametrize("backend_name", ["native", "bundled"])
async def test_large_paste_reaches_child_complete(tmp_path, backend_name):
    if backend_name == "bundled":
        from conpty import PtyProcess as backend
    else:
        from pty_backend import get_backend
        backend = get_backend()
    # Console-host Python consumes bracketed-paste protocol markers before
    # stdin. Test complete user text here; splitter tests pin marker boundaries.
    payload = "HEAD-" + ("line 0123456789 abcdef\r" * 600) + "-TAIL"
    child_file = tmp_path / "receiver.py"
    child_file.write_text('''import os, sys
from pathlib import Path
if os.name == "nt":
    import ctypes, msvcrt
    kernel = ctypes.windll.kernel32
    handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    kernel.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    assert kernel.SetConsoleMode(handle, 0x200), "VT input unavailable"
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
else:
    import tty
    tty.setraw(sys.stdin.fileno())
Path("ready").write_text("ready")
remaining = int(sys.argv[1])
with Path("partial").open("wb") as output:
    while remaining:
        block = os.read(sys.stdin.fileno(), min(1024, remaining))
        if not block:
            raise RuntimeError("Unexpected stdin EOF")
        output.write(block)
        output.flush()
        remaining -= len(block)
Path("partial").rename("received")
''', encoding="utf-8")
    argv = [sys.executable, "-u", str(child_file), str(len(payload))]
    child = backend.spawn(subprocess.list2cmdline(argv) if os.name == "nt" else argv,
                          cwd=str(tmp_path), env=dict(os.environ), dimensions=(30, 120))
    def drain():
        try:
            while child.isalive():
                child.read(65536)
        except (EOFError, OSError):
            return
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    manager = PtyManager()
    session = TerminalSession(id="paste-fixture", name="fixture", pty=child, created_at="")
    manager.sessions[session.id] = session

    async def wait_file(path):
        for _ in range(200):
            if path.exists():
                return
            await asyncio.sleep(0.05)
        partial = tmp_path / "partial"
        evidence = partial.read_bytes() if partial.exists() else b""
        pytest.fail(
            f"Owned PTY fixture did not produce {path.name}; received >= {len(evidence)} bytes; "
            f"head={evidence[:30]!r}; tail={evidence[-30:]!r}"
        )

    try:
        await wait_file(tmp_path / "ready")
        child.setwinsize(40, 140)
        assert child.isalive(), "Resizing must preserve the owned process"
        assert await manager.write_pty_async(session.id, payload)
        await wait_file(tmp_path / "received")
        actual = (tmp_path / "received").read_bytes()
        expected = payload.encode("utf-8")
        assert len(actual) == len(expected)
        assert hashlib.sha256(actual).digest() == hashlib.sha256(expected).digest()
        assert actual.startswith(b"HEAD-")
        assert actual.endswith(b"-TAIL")
    finally:
        # Only the process created above, never manager orphan discovery.
        child.terminate(force=True)
        assert not child.isalive()
        reader.join(timeout=2)
        manager._pty_executor.shutdown(wait=True)
