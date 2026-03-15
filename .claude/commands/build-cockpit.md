# Build Claude Cockpit

Build the full Claude Cockpit desktop app (Tauri + PyInstaller sidecar) and browser exe locally.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller sidecar**:
   ```
   cd /c/Code/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Copy browser exe to local releases** (gitignored):
   ```
   mkdir -p /c/Code/claude-cockpit/releases
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/releases/claude-cockpit-browser.exe
   ```

4. **Copy sidecar to Tauri binaries** (with Rust target triple):
   ```
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   ```

5. **Build Tauri app** (requires `TAURI_SIGNING_PRIVATE_KEY` env var for auto-update signing):
   ```
   cd /c/Code/claude-cockpit/web/frontend && npx @tauri-apps/cli build
   ```

6. **Copy installer, updater zip, and manifest to local releases** (gitignored):
   ```
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.exe" /c/Code/claude-cockpit/releases/
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.nsis.zip" /c/Code/claude-cockpit/releases/
   cp /c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/latest.json /c/Code/claude-cockpit/releases/
   ```

7. **Notify user** — "Build complete. Artifacts ready at `C:\Code\claude-cockpit\releases\`."

## Important

- The full build takes a few minutes (Rust compilation is the slowest part).
- If the Vite build fails, fix errors before proceeding.
- If PyInstaller fails, ensure `pywinpty` and other dependencies are installed.
- Release artifacts are NOT committed to git — they are distributed via GitHub Releases.
- Use `/push-cockpit` to build, commit, push, and upload to GitHub Releases in one shot.
