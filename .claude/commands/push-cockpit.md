# Push Cockpit

Build, commit, push source changes, and upload release artifacts to GitHub Releases.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller sidecar**:
   ```
   cd /c/Code/Personal/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Build Tauri desktop installer**:
   ```
   cp /c/Code/Personal/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/Personal/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   cd /c/Code/Personal/claude-cockpit/web/frontend && TAURI_SIGNING_PRIVATE_KEY=$(cat /c/Code/.tauri/claude-cockpit.key) TAURI_SIGNING_PRIVATE_KEY_PASSWORD='abc123loa' npx @tauri-apps/cli build
   ```

4. **Copy Tauri installer to local releases and generate latest.json** (gitignored):
   ```
   mkdir -p /c/Code/Personal/claude-cockpit/releases
   cp "/c/Code/Personal/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.exe" /c/Code/Personal/claude-cockpit/releases/
   cp "/c/Code/Personal/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.nsis.zip" /c/Code/Personal/claude-cockpit/releases/
   ```
   Then generate `latest.json` from the `.sig` file (Tauri does NOT auto-generate this):
   - Read the signature from the `.nsis.zip.sig` file
   - Read the version from `pyproject.toml`
   - Build `latest.json` with: version, notes (brief changelog), pub_date (UTC ISO), platforms.windows-x86_64.signature, platforms.windows-x86_64.url pointing to `https://github.com/NovemberFalls/claude-cockpit/releases/download/v{version}/Claude.Cockpit_{version}_x64-setup.nsis.zip`
   - Write to `releases/latest.json`

5. **Stage, commit, and push source changes only**:
   - Stage changed source files (NOT release artifacts — they are gitignored)
   - Write a descriptive commit message summarizing what changed
   - Push to `origin/master`
   - Do NOT use `git add -A` — stage specific files to avoid committing secrets or temp files

6. **Upload to GitHub Releases**:
   - Read the version from `pyproject.toml` (e.g., `0.3.0`)
   - Delete existing release for this version if it exists: `gh release delete v{version} --yes 2>/dev/null`
   - Create a new GitHub Release and upload artifacts:
     ```
     gh release create v{version} --title "v{version}" --generate-notes "releases/Claude Cockpit_{version}_x64-setup.exe" "releases/Claude Cockpit_{version}_x64-setup.nsis.zip" releases/latest.json
     ```

7. **Report** — List release artifacts with file sizes:
   ```
   ls -lh /c/Code/Personal/claude-cockpit/releases/
   ```

## Important

- The full build takes several minutes (Rust compilation is the slowest part).
- If Vite build fails, fix errors before proceeding — everything else depends on the frontend dist.
- If PyInstaller fails, check that `pywinpty` and dependencies are installed.
- The Tauri build requires the sidecar exe to exist at the exact target-triple path. **Always copy the fresh PyInstaller exe to the sidecar location BEFORE building Tauri** (step 3) or the desktop app will bundle a stale server.
- The signing env vars must be set: `TAURI_SIGNING_PRIVATE_KEY` (from `C:/Code/.tauri/claude-cockpit.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Release artifacts are distributed via GitHub Releases — NOT committed to git.
- The `releases/` directory is gitignored. Artifacts live there locally only.
