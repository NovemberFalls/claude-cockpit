"""Tests for pty_backend.py (get_backend factory) and unix_pty.py (UnixPtyProcess).

All tests use mocking throughout — no real PTY processes are spawned.
This suite must run cleanly on Windows in CI where ptyprocess is not installed.

The ptyprocess package is Unix-only (it uses os.openpty / pty.fork under the
hood).  We stub it out at the top of this file so that `import unix_pty` works
on any platform.
"""

import sys
import types
from unittest.mock import MagicMock, patch
import pytest

# ---------------------------------------------------------------------------
# Platform-stub helpers
# ---------------------------------------------------------------------------

def _stub_ptyprocess():
    """Insert a fake ptyprocess module into sys.modules if needed.

    unix_pty.py does `from ptyprocess import PtyProcess as _PtyProcess` at
    import time.  On Windows that module doesn't exist, so every test that
    imports unix_pty would fail with ModuleNotFoundError.  We add a minimal
    stub once so the import succeeds everywhere.
    """
    if "ptyprocess" in sys.modules:
        return  # Already present (real or stub)

    fake_ptyprocess = types.ModuleType("ptyprocess")

    class FakePtyProcess:
        """Minimal stand-in for ptyprocess.PtyProcess."""
        fd = None
        exitstatus = None

        @classmethod
        def spawn(cls, argv, **kwargs):
            inst = cls()
            return inst

        def isalive(self):
            return True

        def write(self, data):
            pass

        def setwinsize(self, rows, cols):
            pass

        def terminate(self, force=False):
            pass

    fake_ptyprocess.PtyProcess = FakePtyProcess
    sys.modules["ptyprocess"] = fake_ptyprocess


# Stub before any unix_pty import happens.
_stub_ptyprocess()


def _make_mock_winpty():
    """Return a minimal fake winpty module with a PtyProcess class."""
    mod = types.ModuleType("winpty")
    mod.PtyProcess = type("PtyProcess", (), {})
    return mod


def _make_mock_conpty():
    """Return a minimal fake conpty module with a PtyProcess class."""
    mod = types.ModuleType("conpty")
    mod.PtyProcess = type("PtyProcess", (), {})
    return mod


# ---------------------------------------------------------------------------
# Section 1 — get_backend() factory routing
# ---------------------------------------------------------------------------

class TestGetBackendRouting:
    """Verify that get_backend() returns the correct class for each platform."""

    def test_linux_returns_unix_pty_process(self):
        """sys.platform == 'linux' must route to UnixPtyProcess."""
        mock_sys = MagicMock()
        mock_sys.platform = "linux"
        # Simulate no _MEIPASS (getattr fallback returns None)
        del mock_sys._MEIPASS

        with patch("pty_backend.sys", mock_sys):
            from pty_backend import get_backend
            result = get_backend()

        from unix_pty import UnixPtyProcess
        assert result is UnixPtyProcess

    def test_darwin_returns_unix_pty_process(self):
        """sys.platform == 'darwin' must route to UnixPtyProcess."""
        mock_sys = MagicMock()
        mock_sys.platform = "darwin"
        del mock_sys._MEIPASS

        with patch("pty_backend.sys", mock_sys):
            from pty_backend import get_backend
            result = get_backend()

        from unix_pty import UnixPtyProcess
        assert result is UnixPtyProcess

    def test_win32_without_meipass_returns_winpty_pty_process(self):
        """Windows dev mode (no _MEIPASS) must return winpty.PtyProcess."""
        mock_winpty = _make_mock_winpty()
        mock_sys = MagicMock()
        mock_sys.platform = "win32"
        # getattr(mock_sys, "_MEIPASS", None) must evaluate falsy.
        # MagicMock attributes are truthy by default — set to None explicitly.
        mock_sys.configure_mock(**{"_MEIPASS": None})

        with patch("pty_backend.sys", mock_sys), \
             patch.dict(sys.modules, {"winpty": mock_winpty}):
            from pty_backend import get_backend
            result = get_backend()

        assert result is mock_winpty.PtyProcess

    def test_win32_with_meipass_returns_conpty_pty_process(self):
        """Windows bundled mode (_MEIPASS set) must return conpty.PtyProcess."""
        mock_conpty = _make_mock_conpty()
        mock_sys = MagicMock()
        mock_sys.platform = "win32"
        mock_sys._MEIPASS = "/tmp/_MEIPASS_fake"

        with patch("pty_backend.sys", mock_sys), \
             patch.dict(sys.modules, {"conpty": mock_conpty}):
            from pty_backend import get_backend
            result = get_backend()

        assert result is mock_conpty.PtyProcess

    def test_unknown_platform_raises_runtime_error(self):
        """Unrecognised platform must raise RuntimeError, not silently fail."""
        mock_sys = MagicMock()
        mock_sys.platform = "freebsd"
        del mock_sys._MEIPASS

        with patch("pty_backend.sys", mock_sys):
            from pty_backend import get_backend
            with pytest.raises(RuntimeError, match="freebsd"):
                get_backend()

    def test_unknown_platform_error_message_mentions_supported_platforms(self):
        """RuntimeError message must name at least one supported platform."""
        mock_sys = MagicMock()
        mock_sys.platform = "haiku"
        del mock_sys._MEIPASS

        with patch("pty_backend.sys", mock_sys):
            from pty_backend import get_backend
            with pytest.raises(RuntimeError) as exc_info:
                get_backend()

        msg = str(exc_info.value)
        assert "Windows" in msg or "Linux" in msg or "macOS" in msg


# ---------------------------------------------------------------------------
# Section 2 — UnixPtyProcess ABC compliance
# ---------------------------------------------------------------------------

class TestUnixPtyProcessAbcCompliance:
    """Verify structural compliance with the PtyProcess ABC."""

    def test_import_succeeds(self):
        """UnixPtyProcess must import without TypeError (ABC fully implemented)."""
        from unix_pty import UnixPtyProcess  # noqa: F401 — import is the test

    def test_is_subclass_of_pty_process_abc(self):
        from unix_pty import UnixPtyProcess
        from pty_backend import PtyProcess
        assert issubclass(UnixPtyProcess, PtyProcess)

    def test_spawn_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        assert callable(UnixPtyProcess.spawn)

    def test_isalive_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        assert callable(inst.isalive)

    def test_read_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        assert callable(inst.read)

    def test_write_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        assert callable(inst.write)

    def test_setwinsize_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        assert callable(inst.setwinsize)

    def test_terminate_method_exists_and_is_callable(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        assert callable(inst.terminate)

    def test_exitstatus_property_exists(self):
        """exitstatus must be declared as a @property on the concrete class."""
        from unix_pty import UnixPtyProcess
        assert isinstance(
            UnixPtyProcess.__dict__.get("exitstatus"),
            property,
        )


# ---------------------------------------------------------------------------
# Section 3 — UnixPtyProcess.spawn() argv handling
# ---------------------------------------------------------------------------

class TestUnixPtyProcessSpawn:
    """Verify argv normalisation in spawn() without starting real processes."""

    def _spawn_with_mock(self, argv, **kwargs):
        """Call UnixPtyProcess.spawn() with _PtyProcess.spawn mocked out."""
        from unix_pty import UnixPtyProcess

        mock_pty_inst = MagicMock()
        with patch("unix_pty._PtyProcess") as MockPtyProcess:
            MockPtyProcess.spawn.return_value = mock_pty_inst
            inst = UnixPtyProcess.spawn(argv, **kwargs)
            return inst, MockPtyProcess.spawn.call_args

    def test_string_argv_split_with_shlex_posix(self):
        """A string like "echo 'hello world'" must become ["echo", "hello world"]."""
        _, spawn_call = self._spawn_with_mock("echo 'hello world'")
        actual_argv = spawn_call.args[0]
        assert actual_argv == ["echo", "hello world"]

    def test_string_argv_simple_split(self):
        """A simple space-separated string must be split into tokens."""
        _, spawn_call = self._spawn_with_mock("claude --model sonnet")
        actual_argv = spawn_call.args[0]
        assert actual_argv == ["claude", "--model", "sonnet"]

    def test_list_argv_passes_through_unchanged(self):
        """A list argv must reach _PtyProcess.spawn unchanged."""
        _, spawn_call = self._spawn_with_mock(["echo", "hello"])
        actual_argv = spawn_call.args[0]
        assert actual_argv == ["echo", "hello"]

    def test_tuple_argv_is_converted_to_list(self):
        """A tuple argv must be converted to a list before being passed on."""
        _, spawn_call = self._spawn_with_mock(("echo", "hello"))
        actual_argv = spawn_call.args[0]
        assert actual_argv == ["echo", "hello"]
        assert isinstance(actual_argv, list)

    def test_invalid_argv_type_raises_type_error(self):
        """Non-string/list/tuple argv must raise TypeError immediately."""
        from unix_pty import UnixPtyProcess

        with patch("unix_pty._PtyProcess"):
            with pytest.raises(TypeError, match="argv"):
                UnixPtyProcess.spawn(42)

    def test_cwd_forwarded_to_pty_process(self):
        """The cwd keyword argument must be forwarded to _PtyProcess.spawn."""
        _, spawn_call = self._spawn_with_mock(["echo"], cwd="/tmp/test")
        assert spawn_call.kwargs.get("cwd") == "/tmp/test"

    def test_dimensions_forwarded_to_pty_process(self):
        """The dimensions tuple must be forwarded to _PtyProcess.spawn."""
        _, spawn_call = self._spawn_with_mock(["echo"], dimensions=(30, 120))
        assert spawn_call.kwargs.get("dimensions") == (30, 120)

    def test_spawn_returns_unix_pty_process_instance(self):
        """spawn() must return an UnixPtyProcess instance, not the raw _PtyProcess."""
        from unix_pty import UnixPtyProcess
        inst, _ = self._spawn_with_mock(["echo"])
        assert isinstance(inst, UnixPtyProcess)


# ---------------------------------------------------------------------------
# Section 4 — UnixPtyProcess.read() non-blocking contract
# ---------------------------------------------------------------------------

class TestUnixPtyProcessRead:
    """Verify the non-blocking read() contract with fully mocked I/O."""

    def _make_inst(self):
        """Return a bare UnixPtyProcess instance with a mock _pty."""
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        inst._pty = MagicMock()
        inst._pty.fd = 5          # arbitrary fd number
        inst._pty.isalive.return_value = True
        return inst

    def test_no_data_process_alive_returns_empty_string(self):
        """select returns no ready fds + process alive => returns ''."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select:
            mock_select.return_value = ([], [], [])   # no data ready
            result = inst.read()

        assert result == ""

    def test_no_data_process_dead_raises_eof_error(self):
        """select returns no ready fds + process dead => raises EOFError."""
        inst = self._make_inst()
        inst._pty.isalive.return_value = False

        with patch("unix_pty.select.select") as mock_select:
            mock_select.return_value = ([], [], [])
            with pytest.raises(EOFError):
                inst.read()

    def test_data_available_returns_decoded_string(self):
        """When select reports data ready and os.read returns bytes => returns str."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select, \
             patch("unix_pty.os.read") as mock_os_read:
            mock_select.return_value = ([inst._pty.fd], [], [])
            mock_os_read.return_value = b"hello world"
            result = inst.read()

        assert result == "hello world"

    def test_data_available_unicode_decoded_correctly(self):
        """UTF-8 bytes must be decoded to the original Unicode string."""
        inst = self._make_inst()
        lambda_bytes = "λ".encode("utf-8")   # 0xce 0xbb

        with patch("unix_pty.select.select") as mock_select, \
             patch("unix_pty.os.read") as mock_os_read:
            mock_select.return_value = ([inst._pty.fd], [], [])
            mock_os_read.return_value = lambda_bytes
            result = inst.read()

        assert result == "λ"

    def test_os_read_raises_oserror_becomes_eof_error(self):
        """If os.read raises OSError (fd closed), read() must raise EOFError."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select, \
             patch("unix_pty.os.read") as mock_os_read:
            mock_select.return_value = ([inst._pty.fd], [], [])
            mock_os_read.side_effect = OSError("bad fd")
            with pytest.raises(EOFError):
                inst.read()

    def test_os_read_returns_empty_bytes_raises_eof_error(self):
        """If os.read returns b'' (EOF marker), read() must raise EOFError."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select, \
             patch("unix_pty.os.read") as mock_os_read:
            mock_select.return_value = ([inst._pty.fd], [], [])
            mock_os_read.return_value = b""
            with pytest.raises(EOFError):
                inst.read()

    def test_select_raises_oserror_becomes_eof_error(self):
        """If select() raises OSError (fd already closed), read() must raise EOFError."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select:
            mock_select.side_effect = OSError("bad fd")
            with pytest.raises(EOFError):
                inst.read()

    def test_select_raises_value_error_becomes_eof_error(self):
        """If select() raises ValueError (closed fd), read() must raise EOFError."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select:
            mock_select.side_effect = ValueError("closed")
            with pytest.raises(EOFError):
                inst.read()

    def test_select_called_with_correct_fd_and_timeout(self):
        """read() must pass [fd] and the 0.5s timeout to select()."""
        inst = self._make_inst()

        with patch("unix_pty.select.select") as mock_select, \
             patch("unix_pty.os.read", return_value=b"x"):
            mock_select.return_value = ([inst._pty.fd], [], [])
            inst.read()

        mock_select.assert_called_once_with([inst._pty.fd], [], [], 0.5)


# ---------------------------------------------------------------------------
# Section 5 — UnixPtyProcess.write() encoding
# ---------------------------------------------------------------------------

class TestUnixPtyProcessWrite:
    """Verify that write() encodes strings to UTF-8 before passing to _pty."""

    def _make_inst(self):
        from unix_pty import UnixPtyProcess
        inst = UnixPtyProcess.__new__(UnixPtyProcess)
        inst._pty = MagicMock()
        return inst

    def test_ascii_string_written_as_utf8_bytes(self):
        """ASCII string 'hello' must be written as b'hello'."""
        inst = self._make_inst()
        inst.write("hello")
        inst._pty.write.assert_called_once_with(b"hello")

    def test_unicode_string_written_as_utf8_bytes(self):
        """Unicode 'λ' must be written as its UTF-8 byte sequence 0xce 0xbb."""
        inst = self._make_inst()
        inst.write("λ")
        inst._pty.write.assert_called_once_with(b"\xce\xbb")

    def test_empty_string_written_as_empty_bytes(self):
        """Empty string must result in b'' being written (not skipped)."""
        inst = self._make_inst()
        inst.write("")
        inst._pty.write.assert_called_once_with(b"")

    def test_multi_byte_unicode_encoded_correctly(self):
        """Multi-character Unicode string must be fully encoded."""
        inst = self._make_inst()
        inst.write("héllo")
        inst._pty.write.assert_called_once_with("héllo".encode("utf-8"))

    def test_oserror_from_pty_write_is_not_propagated(self):
        """If _pty.write raises OSError, write() must swallow it silently."""
        inst = self._make_inst()
        inst._pty.write.side_effect = OSError("broken pipe")
        # Must not raise
        inst.write("hello")

    def test_oserror_does_not_propagate_for_unicode_data(self):
        """OSError swallowing applies regardless of the input encoding."""
        inst = self._make_inst()
        inst._pty.write.side_effect = OSError("broken pipe")
        inst.write("λ")  # Must not raise
