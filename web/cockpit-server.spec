# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for cockpit-server (Tauri sidecar)

import os

block_cipher = None
root = os.path.dirname(os.path.abspath(SPEC))
frontend_dist = os.path.join(root, 'frontend', 'dist')

# No winpty DLLs needed — we use a pure-ctypes ConPTY wrapper (conpty.py)
# that calls the Windows ConPTY API directly, bypassing pywinpty's C
# extension which causes 0xC0000142 in PyInstaller onefile bundles.

a = Analysis(
    [os.path.join(root, 'server.py')],
    pathex=[root],
    binaries=[],
    datas=[
        (os.path.join(root, 'static'), 'static'),
        (frontend_dist, 'frontend_dist'),
        (os.path.join(root, 'cockpit_mcp.py'), '.'),
    ],
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'starlette',
        'starlette.middleware',
        'starlette.routing',
        'starlette.responses',
        'fastapi',
        'fastapi.responses',
        'winpty',
        'conpty',
        'dotenv',
        'websockets',
        'httpx',
        'multipart',
        'python_multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='claude-cockpit',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    icon=os.path.join(root, 'frontend', 'src-tauri', 'icons', 'icon.ico'),
)
