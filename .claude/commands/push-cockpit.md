# Push Cockpit

Build, commit, push source changes, and upload release artifacts to GitHub Releases.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller browser exe**:
   ```
   cd /c/Code/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Copy browser exe to local releases** (gitignored):
   ```
   mkdir -p /c/Code/claude-cockpit/releases
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/releases/claude-cockpit-browser.exe
   ```

4. **Build Tauri desktop installer**:
   ```
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   cd /c/Code/claude-cockpit/web/frontend && npx @tauri-apps/cli build
   ```

5. **Copy Tauri installer and updater manifest to local releases** (gitignored):
   ```
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.exe" /c/Code/claude-cockpit/releases/
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.nsis.zip" /c/Code/claude-cockpit/releases/
   cp /c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/latest.json /c/Code/claude-cockpit/releases/
   ```

6. **Stage, commit, and push source changes only**:
   - Stage changed source files (NOT release artifacts — they are gitignored)
   - Write a descriptive commit message summarizing what changed
   - Push to `origin/master`
   - Do NOT use `git add -A` — stage specific files to avoid committing secrets or temp files

7. **Upload to GitHub Releases**:
   - Read the version from `pyproject.toml` (e.g., `0.2.0-alpha`)
   - Delete existing release for this version if it exists: `gh release delete v{version} --yes 2>/dev/null`
   - Create a new GitHub Release and upload both artifacts:
     ```
     gh release create v{version} --title "v{version}" --generate-notes releases/claude-cockpit-browser.exe "releases/Claude Cockpit_{version}_x64-setup.exe" "releases/Claude Cockpit_{version}_x64-setup.nsis.zip" releases/latest.json
     ```

8. **Report** — List release artifacts with file sizes:
   ```
   ls -lh /c/Code/claude-cockpit/releases/
   ```

## Important

- The full build takes several minutes (Rust compilation is the slowest part).
- If Vite build fails, fix errors before proceeding — everything else depends on the frontend dist.
- If PyInstaller fails, check that `pywinpty` and dependencies are installed.
- The Tauri build requires the sidecar exe to exist at the exact target-triple path.
- Release artifacts are distributed via GitHub Releases — NOT committed to git.
- The `releases/` directory is gitignored. Artifacts live there locally only.
