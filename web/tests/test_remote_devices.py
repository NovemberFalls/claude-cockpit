"""Tests for the Studio Remote device/pairing store."""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from remote_devices import (  # noqa: E402
    CODE_ALPHABET,
    MAX_OUTSTANDING_PAIRINGS,
    MAX_PAIRING_ATTEMPTS,
    DeviceStore,
    PairingError,
)


class Clock:
    def __init__(self, start: float = 1_000_000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def store(tmp_path):
    return DeviceStore(tmp_path / "remote_devices.json", now=Clock())


def test_pairing_round_trip(store):
    pairing = store.create_pairing()
    assert len(pairing["code"]) == 9 and pairing["code"][4] == "-"
    assert all(ch in CODE_ALPHABET for ch in pairing["code"].replace("-", ""))

    device_id, token = store.redeem_pairing(pairing["code"], "Pixel")
    assert device_id.startswith("dv_") and len(device_id) == 15
    assert token

    device = store.authenticate(token)
    assert device is not None
    assert device.id == device_id
    assert device.name == "Pixel"
    assert device.last_seen is not None


def test_code_comparison_ignores_case_and_dash(store):
    code = store.create_pairing()["code"]
    mangled = code.replace("-", "").lower()
    device_id, _token = store.redeem_pairing(mangled, "Phone")
    assert device_id


def test_expired_code_is_refused(store, tmp_path):
    clock = Clock()
    store = DeviceStore(tmp_path / "s.json", now=clock)
    code = store.create_pairing()["code"]
    clock.t += 301
    with pytest.raises(PairingError) as exc:
        store.redeem_pairing(code, "Phone")
    assert str(exc.value) == "invalid or expired code"


def test_code_is_single_use(store):
    code = store.create_pairing()["code"]
    store.redeem_pairing(code, "First")
    with pytest.raises(PairingError):
        store.redeem_pairing(code, "Second")


def test_failed_attempts_kill_outstanding_codes(store):
    code = store.create_pairing()["code"]
    for _ in range(MAX_PAIRING_ATTEMPTS):
        with pytest.raises(PairingError):
            store.redeem_pairing("ZZZZ-ZZZZ", "Phone")
    with pytest.raises(PairingError):
        store.redeem_pairing(code, "Phone")


def test_outstanding_pairings_are_capped(store):
    codes = [store.create_pairing()["code"] for _ in range(MAX_OUTSTANDING_PAIRINGS + 1)]
    # The oldest was dropped; the newest still works.
    with pytest.raises(PairingError):
        store.redeem_pairing(codes[0], "Phone")
    assert store.redeem_pairing(codes[-1], "Phone")[0]


def test_every_pairing_failure_has_one_message(store):
    for bad in ["ZZZZ-ZZZZ", "", "not-a-code"]:
        with pytest.raises(PairingError) as exc:
            store.redeem_pairing(bad, "Phone")
        assert str(exc.value) == "invalid or expired code"


def test_blank_device_name_is_refused(store):
    code = store.create_pairing()["code"]
    with pytest.raises(PairingError):
        store.redeem_pairing(code, "   ")


def test_device_name_is_stripped_and_truncated(store):
    code = store.create_pairing()["code"]
    device_id, _t = store.redeem_pairing(code, "  " + "N" * 100 + "  ")
    name = next(d.name for d in store.list_devices() if d.id == device_id)
    assert name == "N" * 64


def test_revoked_device_stops_authenticating(store):
    code = store.create_pairing()["code"]
    device_id, token = store.redeem_pairing(code, "Phone")
    assert store.authenticate(token) is not None
    assert store.revoke(device_id) is True
    assert store.authenticate(token) is None
    assert store.revoke("dv_nope") is False


def test_unknown_token_authenticates_to_none(store):
    assert store.authenticate("nope") is None
    assert store.authenticate("") is None


def test_list_devices_includes_revoked(store):
    code = store.create_pairing()["code"]
    device_id, _t = store.redeem_pairing(code, "Phone")
    store.revoke(device_id)
    devices = store.list_devices()
    assert len(devices) == 1
    assert devices[0].revoked_at is not None


def test_file_never_contains_the_plaintext_token(tmp_path):
    path = tmp_path / "remote_devices.json"
    store = DeviceStore(path, now=Clock())
    code = store.create_pairing()["code"]
    _device_id, token = store.redeem_pairing(code, "Phone")
    raw = path.read_text(encoding="utf-8")
    assert token not in raw
    entry = json.loads(raw)["devices"][0]
    assert len(entry["token_sha256"]) == 64
    assert "token" not in entry


def test_write_is_atomic_and_leaves_no_temp_files(tmp_path):
    path = tmp_path / "remote_devices.json"
    store = DeviceStore(path, now=Clock())
    store.create_pairing()
    store.create_pairing()
    assert path.is_file()
    assert [p.name for p in tmp_path.iterdir()] == ["remote_devices.json"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are cosmetic on Windows")
def test_store_file_is_0600(tmp_path):
    path = tmp_path / "remote_devices.json"
    DeviceStore(path, now=Clock()).create_pairing()
    assert (path.stat().st_mode & 0o777) == 0o600


def test_corrupt_store_reads_as_empty(tmp_path):
    path = tmp_path / "remote_devices.json"
    path.write_text("{not json", encoding="utf-8")
    store = DeviceStore(path, now=Clock())
    assert store.list_devices() == []
    assert store.authenticate("anything") is None
