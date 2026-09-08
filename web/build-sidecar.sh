#!/usr/bin/env bash
# Build the Plexar Studio sidecar for Tauri
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building Plexar Studio server with PyInstaller..."
pyinstaller --clean --noconfirm cockpit-server.spec

SIDECAR_DIR="frontend/src-tauri/binaries"
mkdir -p "$SIDECAR_DIR"

# Tauri expects the sidecar named with the Rust target triple
TARGET="x86_64-pc-windows-msvc"
cp "dist/plexar-studio-server.exe" "$SIDECAR_DIR/cockpit-server-${TARGET}.exe"

echo "==> Sidecar built: $SIDECAR_DIR/cockpit-server-${TARGET}.exe"
