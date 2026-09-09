"""Shared fixtures.

Near-minimal by design: no sys.path manipulation (every test module already
inserts the parent dir itself). There is exactly ONE autouse fixture, and it
asserts rather than changes -- see `_never_log_into_the_real_data_dir`.

Two things below run at IMPORT rather than as fixtures, for the same reason:
the behaviour they redirect happens at test-module import time, which is before
any ordinary fixture can run. See the temp-root redirect immediately below.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

#: The developer's ACTUAL system temp folder, captured before we redirect.
#: A test that genuinely needs the real thing asks for it explicitly, via the
#: `real_tempdir` fixture below -- never by calling tempfile.gettempdir().
REAL_TEMPDIR = tempfile.gettempdir()

# THE TEST SUITE MUST NEVER CREATE OR DELETE ANYTHING IN THE REAL TEMP FOLDER.
#
# MEASURED 2026-09-09, and it was a live defect: `server.py`'s lifespan calls
# `temp_sweep.sweep_stale(ours=...)` with no `temp_root`, which correctly
# defaults to the real system temp folder in production. But
# `tests/test_upload_eviction.py` uses the context-manager form of TestClient,
# which RUNS THE REAL LIFESPAN -- so one `pytest tests` run swept the
# developer's own temp folder, taking it from 307 directories to 109. The age
# rule held and nothing live was destroyed, but the next person's 25-hour-old
# directory may be one they cared about.
#
# A second, independent leak: `bridge_manager` and `mailbox_bridge` each call
# `mkdtemp` at MODULE IMPORT, so every pytest process that imported them left
# one directory behind in the real temp folder forever (88 of each were found).
#
# Both are fixed by moving the temp ROOT rather than by special-casing the
# sweep: silencing the sweep would leave the import-time mkdtemp leak intact.
# `tempfile.tempdir` is set as well as the env vars because gettempdir()
# memoises its answer and pytest has already called it by now; the env vars are
# what carries the redirect into subprocesses (test_pid_file_scoping.py).
# Opt out for a run with COCKPIT_TESTS_USE_REAL_TEMP=1.
if os.environ.get("COCKPIT_TESTS_USE_REAL_TEMP") != "1":
    _test_tempdir = os.environ.get("COCKPIT_TEST_TMPDIR") or os.path.join(
        REAL_TEMPDIR, "plexar-studio-tests",
    )
    os.makedirs(_test_tempdir, exist_ok=True)
    tempfile.tempdir = _test_tempdir
    for _var in ("TMPDIR", "TEMP", "TMP"):
        os.environ[_var] = _test_tempdir

# logging_config now installs a rotating FILE handler, and most test modules
# call logging_config.setup() at import time. Without this, running the suite
# writes test noise into the user's REAL ~/.claude-cockpit/logs/cockpit.log.
# Set at conftest import (before any test module is imported) rather than as an
# autouse fixture, so it is in force for import-time setup() calls too.
os.environ.setdefault(
    "COCKPIT_LOG_DIR", os.path.join(tempfile.gettempdir(), "cockpit-test-logs"),
)

import app_paths
import logging_config
import server as server_module

# `vllm-local` is DEREGISTERED at import unless a direct vLLM is declared
# (COCKPIT_VLLM_DIRECT=1, or managed intent on) — Plexar owns vLLM now, and a
# provider row pointing at a port nothing listens on is permanently red.
#
# The MACHINERY behind it is untouched and still supported, and the suites that
# cover it (managed lifecycle, model-control, the Prometheus adapter, models-dir)
# are testing real, reachable behaviour. So the entry is put back here for the
# whole suite. The retirement itself is covered directly by
# test_vllm_local_retirement.py, which drives _retire_vllm_local_if_unused and
# restores the registry afterwards.
server_module._register_vllm_local()


@pytest.fixture(autouse=True)
def _never_log_into_the_real_data_dir():
    """Fail the test that points file logging at the user's REAL log directory.

    THE INCIDENT, 2026-08-02: the env override above was correct and was still
    defeated. `test_unwritable_log_dir_degrades_to_stderr_only` deleted
    COCKPIT_LOG_DIR in a `finally` and called setup() -- monkeypatch's restore
    happens at TEARDOWN, so that setup() ran with no override, resolved to
    app_paths.data_path("logs"), and installed a RotatingFileHandler on the
    running app's live cockpit.log. It persisted for the rest of the session, so
    every later test wrote its deliberately-alarming fixture tracebacks
    ("docker not found", "connection refused") into the log a user reads to
    diagnose real faults -- and two processes rotating one file on Windows is a
    rename against an open handle.

    Setting the env var was never the guarantee; the handler's actual
    destination is. Same shape as every other defect this project found today:
    the constant was pinned, the WIRE was not. So this asserts the wire, after
    every test, and names the culprit rather than leaving a future reader to
    diff the log.
    """
    yield
    # READ THE HANDLER, NOT log_file_path(). The first version of this guard
    # called log_file_path() and did not fire when the bug was reintroduced
    # deliberately: that function re-resolves COCKPIT_LOG_DIR at CALL time, and
    # monkeypatch has already restored the env by the time a teardown fixture
    # runs -- so it reported the test directory while the installed handler was
    # still writing to the real one. Asserting a recomputed value instead of the
    # live object is the same defect this fixture exists to catch, committed
    # inside the fixture itself. `baseFilename` is where bytes actually go.
    handler = logging_config._file_handler
    if handler is None:
        return
    active = os.path.abspath(handler.baseFilename)
    real = os.path.abspath(str(app_paths.data_path("logs")))
    assert not active.startswith(real), (
        f"This test left file logging pointed at the REAL data directory "
        f"({active}). Tests must never write to the user's live log -- a "
        f"running Plexar Studio has that file open, and two processes rotating "
        f"one file on Windows is a rename against an open handle. Re-point "
        f"COCKPIT_LOG_DIR rather than unsetting it."
    )


@pytest.fixture()
def real_tempdir():
    """The developer's ACTUAL system temp folder.

    Requirement 4 of the redirect above: a test that genuinely needs the real
    behaviour must be able to ask for it, explicitly and visibly, rather than
    getting it by accident from `tempfile.gettempdir()`. Anything using this
    must READ ONLY -- the redirect exists precisely because writes and deletes
    out here are not the suite's to make.
    """
    return REAL_TEMPDIR


@pytest.fixture()
def vllm_ownership(monkeypatch):
    """Set vLLM ownership (COCKPIT_MANAGED_VLLM + the external verdict) and
    re-sync the "model-control" capability, restoring everything afterwards.

    COCKPIT_MANAGED_VLLM is read from the env ONCE at import into a module
    global, so a test cannot use monkeypatch.setenv — the switch is that global
    plus server._refresh_vllm_model_control(), which is exactly the pair the
    startup path uses. Setting the global to "0"/"1" is an EXPLICIT env value,
    which wins over settings.json's providers.vllm.managed (see
    server._vllm_managed_intent), so these tests never depend on the developer's
    own settings file. Tests that want the settings side are in
    test_vllm_ownership.py. The capability list is mutable module state, so it is
    snapshotted and restored rather than left as the test found it (a developer
    running with COCKPIT_MANAGED_VLLM=1 in their own env would otherwise see
    cross-test pollution).

    Usage: `vllm_ownership("1")` for managed, `vllm_ownership("0")` for
    external-by-config, `vllm_ownership("1", external=True)` for
    opted-in-but-something-else-already-serving.
    """
    caps = server_module._PROVIDERS["vllm-local"]["capabilities"]
    caps_snapshot = list(caps)
    external_snapshot = server_module._MANAGED_VLLM.get("external", False)

    def apply(value: str, external: bool = False):
        monkeypatch.setattr(server_module, "COCKPIT_MANAGED_VLLM", value)
        server_module._MANAGED_VLLM["external"] = external
        server_module._refresh_vllm_model_control()

    yield apply

    caps[:] = caps_snapshot
    server_module._MANAGED_VLLM["external"] = external_snapshot
