"""Verify Tauri minisign envelope without loading any signing key.

Algorithm matches locally installed minisign-verify 0.2.5, lib.rs verify()
and verify_ed25519(): Ed25519 over BLAKE2b-512 plus signed trusted comment.
Uses the independently installed cryptography implementation.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def verify(config, artifact, signature):
    encoded_key = json.loads(config.read_text())["plugins"]["updater"]["pubkey"]
    public_lines = base64.b64decode(encoded_key, validate=True).decode().splitlines()
    key = base64.b64decode(public_lines[1], validate=True)
    signed_lines = base64.b64decode(signature.read_text().strip(), validate=True).decode().splitlines()
    packet = base64.b64decode(signed_lines[1], validate=True)
    assert len(key) == 42 and key[:2] == b"Ed", "Unexpected public key format"
    assert len(packet) == 74 and packet[:2] == b"ED", "Expected prehashed minisign signature"
    assert key[2:10] == packet[2:10], "Signature key ID differs from configured updater key"
    assert signed_lines[2].startswith("trusted comment: "), "Missing trusted comment"
    comment = signed_lines[2][len("trusted comment: "):].encode()
    verifier = Ed25519PublicKey.from_public_bytes(key[10:])
    digest, sha256 = hashlib.blake2b(digest_size=64), hashlib.sha256()
    with artifact.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            sha256.update(chunk)
    verifier.verify(packet[10:], digest.digest())
    verifier.verify(base64.b64decode(signed_lines[3], validate=True), packet[10:] + comment)
    # Negative gate: mutated digest must be rejected, without altering artifact.
    bad_digest = bytes([digest.digest()[0] ^ 1]) + digest.digest()[1:]
    try:
        verifier.verify(packet[10:], bad_digest)
    except InvalidSignature:
        pass
    else:
        raise AssertionError("Corruption gate accepted a modified digest")
    return {"artifact": artifact.name, "bytes": artifact.stat().st_size,
            "sha256": sha256.hexdigest(), "signature": "verified",
            "trusted_comment": "verified", "modified_digest": "rejected"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--signature", type=Path)
    parser.add_argument("--config", type=Path,
                        default=Path(__file__).resolve().parents[1] / "web/frontend/src-tauri/tauri.conf.json")
    args = parser.parse_args()
    print(json.dumps(verify(args.config, args.artifact, args.signature or Path(str(args.artifact) + ".sig"))))
