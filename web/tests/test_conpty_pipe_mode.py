"""Actual Windows handles must support blocking host and ConPTY I/O."""
import ctypes
import ctypes.wintypes as wt
import sys
import threading
import time

import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows NT pipe contract")
def test_independent_pipes_match_blocking_io_contract():
    import conpty

    query = ctypes.WinDLL("ntdll").NtQueryInformationFile
    query.argtypes = [wt.HANDLE, ctypes.POINTER(conpty.IO_STATUS_BLOCK),
                      ctypes.c_void_p, wt.ULONG, wt.ULONG]
    query.restype = ctypes.c_long
    handles = conpty._create_conpty_pipes()
    try:
        def mode(handle):
            result = wt.ULONG()
            status = conpty.IO_STATUS_BLOCK()
            code = query(wt.HANDLE(handle), ctypes.byref(status), ctypes.byref(result),
                         ctypes.sizeof(result), 16)  # FileModeInformation
            assert code >= 0, f"NtQueryInformationFile failed: {code:#x}"
            return result.value

        assert len(handles) == 4 and len(set(handles)) == 4
        for handle in handles:
            assert mode(handle) & 0x30, (
                "Host blocking I/O and CreatePseudoConsole both require synchronous handles"
            )
    finally:
        for handle in handles:
            conpty.kernel32.CloseHandle(wt.HANDLE(handle))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows NT pipe contract")
def test_cleanup_cancels_a_blocked_writer_without_a_reader():
    import conpty

    input_read, input_write, output_read, output_write = conpty._create_conpty_pipes()
    process = conpty.PtyProcess()
    process._input_pipe = input_write
    process._output_pipe = output_read
    result = []
    writer = threading.Thread(target=lambda: result.append(process.write("x" * (1024 * 1024))), daemon=True)
    cleanup = threading.Thread(target=process._cleanup, daemon=True)
    try:
        writer.start()
        deadline = time.monotonic() + 5
        available = wt.DWORD()
        while time.monotonic() < deadline:
            assert conpty.kernel32.PeekNamedPipe(
                wt.HANDLE(input_read), None, 0, None, ctypes.byref(available), None,
            )
            if available.value >= 128 * 1024:
                break
            time.sleep(0.01)
        assert available.value >= 128 * 1024, "Fixture must fill the real input pipe"
        assert writer.is_alive(), "Write must still be waiting for a consumer"
        cleanup.start()
        cleanup.join(timeout=5)
        writer.join(timeout=5)
        assert not cleanup.is_alive(), "Cleanup must cancel pending synchronous I/O"
        assert not writer.is_alive()
        assert result and result[0] < 1024 * 1024, "Cancellation must report a short write"
        assert process._input_pipe is None and process._output_pipe is None
    finally:
        # Only these two owned peer handles; closing them also releases a failed probe.
        conpty.kernel32.CloseHandle(wt.HANDLE(input_read))
        conpty.kernel32.CloseHandle(wt.HANDLE(output_write))
        writer.join(timeout=2)
        if cleanup.ident is not None:
            cleanup.join(timeout=2)
        process._cleanup()
