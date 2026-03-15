# Push Cockpit

Build, release, commit, and push the Claude Cockpit project in one shot.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller browser exe**:
   ```
   cd /c/Code/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Copy browser exe to releases**:
   ```
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/releases/claude-cockpit-browser.exe
   ```

4. **Build Tauri desktop installer**:
   ```
   cp /c/Code/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   cd /c/Code/claude-cockpit/web/frontend && npx @tauri-apps/cli build
   ```

5. **Copy Tauri installer to releases**:
   ```
   cp "/c/Code/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_0.2.0-alpha_x64-setup.exe" /c/Code/claude-cockpit/releases/
   ```

6. **Stage, commit, and push**:
   - Stage all changed source files and both release artifacts
   - Write a descriptive commit message summarizing what changed
   - Push to `origin/master`

7. **Report** — List release artifacts with file sizes:
   ```
   ls -lh /c/Code/claude-cockpit/releases/
   ```

## Important

- The full build takes several minutes (Rust compilation is the slowest part).
- If Vite build fails, fix errors before proceeding — everything else depends on the frontend dist.
- If PyInstaller fails, check that `pywinpty` and dependencies are installed.
- The Tauri build requires the sidecar exe to exist at the exact target-triple path.
- Always include both release exes in the commit so the repo has the latest artifacts.
- Do NOT use `git add -A` — stage specific files to avoid committing secrets or temp files.
