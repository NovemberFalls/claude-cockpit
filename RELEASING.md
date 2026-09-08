# Releasing Plexar Studio

`web/frontend/package.json` is the application version source. Update its lockfile,
the Rust manifest/lockfile and Python project metadata together. Release executables
and updater artifacts belong in GitHub Releases, not Git. Internal planning files,
signing keys and runtime PID files must remain untracked.

Run the backend tests and Ruff checks, frontend tests and ESLint before packaging.
Build in this order from the repository root:

```powershell
Push-Location web/frontend
npm run build
npm run verify:version
Pop-Location
Push-Location web
python -m PyInstaller --clean --noconfirm cockpit-server.spec
python verify_sidecar_bundle.py
Copy-Item dist/plexar-studio-server.exe frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
Pop-Location
```

Stop if any command fails. The sidecar must contain the frontend just built;
building the frontend after freezing the sidecar ships stale UI. Verify the copied
sidecar too with `python web/verify_sidecar_bundle.py` followed by its path.

Provide `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through
the release environment, using the existing trusted updater key. Never commit or
print those values. Then run the Tauri build from `web/frontend`:

```powershell
npx @tauri-apps/cli build --ci
```

Do not use the unsigned local-build override. Copy the exact version's `.exe`,
`.nsis.zip` and `.nsis.zip.sig` from `src-tauri/target/release/bundle/nsis` into
`releases/`. The package name is `Plexar-Studio_<version>_x64-setup`.

The following verification tools require Python's `cryptography` package. They
check the archive signature against the public key embedded in the application,
including its signed comment and a corrupted-digest rejection check. They never
load a private key. Save concise public release notes to a text file, then run:

```powershell
python scripts/create_updater_manifest.py --notes-file releases/release-notes.md
```

This verifies the exact archive before writing `releases/latest.json`. Upload the
installer, archive, detached signature and manifest to
`NovemberFalls/plexar-studio`, using a version tag pointing at the tested source
commit on `master`. Create the release as a draft, verify its asset sizes/hashes,
then publish it as latest. Download the public manifest and archive afterward;
verify the downloaded bytes and signature again. A manifest that points at a
missing asset cannot update installed applications.

Tauri updater signing is separate from Windows Authenticode signing. Report each
status accurately. Keep the installed application identifier, updater public key,
sidecar bundle identity, migration paths and preference keys compatible across
branding changes. Legacy names in those compatibility fields and historical
changelogs are intentional; the application executable is `plexar-studio.exe`.
