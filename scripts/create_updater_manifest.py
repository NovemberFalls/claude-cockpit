"""Create the Plexar Studio updater manifest only after verifying its archive."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from verify_updater_signature import verify

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, default=ROOT / "releases")
    parser.add_argument("--notes-file", type=Path, required=True)
    args = parser.parse_args()
    version = json.loads((ROOT / "web/frontend/package.json").read_text(encoding="utf-8"))["version"]
    filename = f"Plexar-Studio_{version}_x64-setup.nsis.zip"
    archive = args.release_dir / filename
    signature = Path(str(archive) + ".sig")
    verify(ROOT / "web/frontend/src-tauri/tauri.conf.json", archive, signature)
    manifest = {
        "version": version,
        "notes": args.notes_file.read_text(encoding="utf-8").strip(),
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": {"windows-x86_64": {
            "signature": signature.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/NovemberFalls/plexar-studio/releases/download/v{version}/{filename}",
        }},
    }
    output = args.release_dir / "latest.json"
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Verified updater manifest written to {output}")


if __name__ == "__main__":
    main()
