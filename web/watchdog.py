"""Watchdog service for Claude Cockpit.

Starts the cockpit server as a subprocess and restarts it on crash.
Usage: python watchdog.py [--port PORT] [--host HOST]
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_PORT = int(os.getenv("PORT", "8420"))
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
RESTART_DELAY = 3  # seconds to wait before restarting after crash
MAX_RAPID_RESTARTS = 5  # max restarts within the rapid window
RAPID_WINDOW = 60  # seconds — if too many restarts happen this fast, back off
BACKOFF_DELAY = 30  # seconds to wait after too many rapid restarts


def run_watchdog(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
    """Monitor and restart the cockpit server."""
    server_dir = Path(__file__).parent
    python = sys.executable
    restart_times: list[float] = []
    shutting_down = False

    def handle_signal(sig, frame):
        nonlocal shutting_down
        shutting_down = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print(f"  Cockpit Watchdog started (pid {os.getpid()})")
    print(f"  Server target: {host}:{port}")

    while not shutting_down:
        # Check for rapid restart loop
        now = time.time()
        restart_times = [t for t in restart_times if now - t < RAPID_WINDOW]
        if len(restart_times) >= MAX_RAPID_RESTARTS:
            print(f"  [watchdog] Too many restarts ({MAX_RAPID_RESTARTS} in {RAPID_WINDOW}s), backing off {BACKOFF_DELAY}s...")
            time.sleep(BACKOFF_DELAY)
            restart_times.clear()

        # Suppress browser auto-open on restarts (only open on first launch)
        env = {**os.environ}
        if restart_times:
            env["NO_BROWSER"] = "1"

        print(f"  [watchdog] Starting cockpit server...")
        proc = subprocess.Popen(
            [python, "-m", "uvicorn", "server:app", "--host", host, "--port", str(port)],
            cwd=str(server_dir),
            env=env,
        )

        try:
            proc.wait()
        except KeyboardInterrupt:
            shutting_down = True
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            break

        exit_code = proc.returncode

        if shutting_down:
            break

        restart_times.append(time.time())
        print(f"  [watchdog] Server exited with code {exit_code}, restarting in {RESTART_DELAY}s...")
        time.sleep(RESTART_DELAY)

    print("  [watchdog] Shutting down.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Cockpit watchdog service")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()
    run_watchdog(host=args.host, port=args.port)
