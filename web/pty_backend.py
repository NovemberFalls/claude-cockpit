"""PTY backend abstraction for Claude Cockpit.

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

    Selection priority on Windows:
      1. ConPty (pure ctypes) inside a PyInstaller bundle — pywinpty's C
         extension causes 0xC0000142 DLL failures in onefile bundles.
      2. winpty.PtyProcess in development (installed via pywinpty).

    To add Linux/macOS support, detect sys.platform here and return your
    backend class (must implement the PtyProcess interface above).

    Raises RuntimeError on unsupported platforms.
    """
    # Linux / macOS — use ptyprocess-based backend
    if sys.platform in ("linux", "darwin"):
        from unix_pty import UnixPtyProcess
        return UnixPtyProcess

    # Windows — ConPTY for bundled (PyInstaller), winpty for development
    if sys.platform == "win32":
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            from conpty import PtyProcess as ConPtyProcess  # type: ignore[import]
            return ConPtyProcess

        import winpty  # type: ignore[import]
        return winpty.PtyProcess

    raise RuntimeError(
        f"No PTY backend available for platform '{sys.platform}'. "
        "Supported platforms: Windows, Linux, macOS."
    )
