"""PTY backend abstraction for Plexar Studio.

Defines the PtyProcess ABC and a get_backend() factory.  Adding support for
a new platform (Linux, macOS) means implementing PtyProcess and registering
it in get_backend().
"""

from __future__ import annotations

import sys
from abc import ABC, abstractmethod


class PtyProcess(ABC):
    """Abstract interface for a running pseudo-terminal process."""

    @classmethod
    @abstractmethod
    def spawn(
        cls,
        argv,
        cwd: str | None = None,
        env: dict | None = None,
        dimensions: tuple[int, int] = (24, 80),
        **kwargs,
    ) -> "PtyProcess":
        """Spawn a process inside a PTY. Returns a PtyProcess instance."""

    @abstractmethod
    def isalive(self) -> bool:
        """Return True if the process is still running."""

    @abstractmethod
    def read(self, size: int = 65536) -> str:
        """Read available output from the PTY. Returns empty string if none."""

    @abstractmethod
    def write(self, data: str) -> None:
        """Write data to the PTY stdin."""

    @abstractmethod
    def setwinsize(self, rows: int, cols: int) -> None:
        """Resize the PTY dimensions."""

    @abstractmethod
    def terminate(self, force: bool = False) -> None:
        """Terminate the process."""

    @property
    @abstractmethod
    def exitstatus(self) -> int | None:
        """Exit code of the process, or None if still running."""


def get_backend() -> type:
    """Return the appropriate PtyProcess class for the current environment.

    Windows uses the same pure-ctypes ConPTY implementation in development
    and bundles. pywinpty 3.0.3 was observed delivering input while returning
    zero bytes, causing the paced writer to stop after the first chunk.
    Keep the genuine zero-write failure guard and use our verified backend.

    To add Linux/macOS support, detect sys.platform here and return your
    backend class (must implement the PtyProcess interface above).

    Raises RuntimeError on unsupported platforms.
    """
    # Linux / macOS — use ptyprocess-based backend
    if sys.platform in ("linux", "darwin"):
        from unix_pty import UnixPtyProcess
        return UnixPtyProcess

    # Windows — one verified write contract in dev and packaged builds.
    if sys.platform == "win32":
        from conpty import PtyProcess as ConPtyProcess  # type: ignore[import]
        return ConPtyProcess

    raise RuntimeError(
        f"No PTY backend available for platform '{sys.platform}'. "
        "Supported platforms: Windows, Linux, macOS."
    )
