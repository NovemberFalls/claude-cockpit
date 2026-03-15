# Build Claude Cockpit

Build the full Claude Cockpit desktop app (Tauri + PyInstaller sidecar) and copy the installer to the releases folder.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller sidecar**:
   ```
   cd /c/Code/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Copy sidecar to Tauri binaries** (with Rust target triple):
   ```
   cp /c/Code/claude-cockpit/web/dist/cockpit-server.exe /c/Code/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   ```

4. **Build Tauri app**:
   ```
   cd /c/Code/claude-cockpit/web/frontend && npx @tauri-apps/cli build
   ```

5. **Copy installer to releases**:
   ```
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_0.2.0-alpha_x64-setup.exe" /c/Code/claude-cockpit/releases/
   ```

6. **Notify user** — "Build complete. Installer ready at `C:\Code\claude-cockpit\releases\`."

## Important

- The full build takes a few minutes (Rust compilation is the slowest part).
- If the Vite build fails, fix errors before proceeding.
- If PyInstaller fails, ensure `pywinpty` and other dependencies are installed.
- The browser-based standalone exe (`claude-cockpit-browser.exe`) is a separate artifact from `web/dist/` — copy it manually to releases if needed.
