"""Workspace manager for Claude Cockpit agent file communication.

Every agent session gets a workspace folder under <cockpit-install>/mcp/workspaces/.
Folder names use compound session IDs (hex segments joined with '+') to encode
the agent hierarchy, making every folder globally unique and traceable.

Example layout:
    mcp/workspaces/
        abc12345/               ← Vera's workspace
        abc12345+def67890/      ← Nadia under Vera
        abc12345+def67890+gh11/ ← Ash under Nadia under Vera

This module does NOT:
  - Watch for file changes (see workspace_watcher.py)
  - Inject notifications into PTY sessions (see server.py)
  - Manage access control beyond the tree-scoping helpers below
  - Handle compaction / archiving (Phase 3)
"""

from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Workspace root — persistent across restarts, inside the Cockpit install dir.
# PyInstaller bundles: anchor to sys.executable parent (MEIPASS is volatile).
# Dev mode: anchor to this file's parent (web/).
# ---------------------------------------------------------------------------
if getattr(sys, "_MEIPASS", None):
    WORKSPACE_ROOT = Path(sys.executable).parent / "mcp" / "workspaces"
else:
    WORKSPACE_ROOT = Path(__file__).parent / "mcp" / "workspaces"

# Compound ID segments must be lowercase hex only, joined with "+"
_HEX_CHARS = frozenset("0123456789abcdef")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_compound_id(compound_id: str) -> None:
    """Raise ValueError if compound_id contains non-hex segments or empty parts."""
    if not compound_id:
        raise ValueError("compound_id must not be empty")
    for part in compound_id.split("+"):
        if not part or not all(c in _HEX_CHARS for c in part):
            raise ValueError(
                f"compound_id segment {part!r} must be lowercase hex only. "
                f"Full value: {compound_id!r}"
            )


def is_in_tree(caller_compound_id: str, target_compound_id: str) -> bool:
    """Return True if target is within caller's workspace tree.

    Caller can access its own workspace or any descendant:
        caller = "abc"         target = "abc"          → True
        caller = "abc"         target = "abc+def"      → True
        caller = "abc"         target = "abc+def+ghi"  → True
        caller = "abc+def"     target = "abc"          → False (parent, not descendant)
        caller = "abc"         target = "xyz"          → False (different tree)
    """
    return (
        target_compound_id == caller_compound_id
        or target_compound_id.startswith(caller_compound_id + "+")
    )


# ---------------------------------------------------------------------------
# Root access
# ---------------------------------------------------------------------------

def get_workspace_root() -> Path:
    """Return the workspace root path, creating it if absent."""
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    return WORKSPACE_ROOT


def workspace_path(compound_id: str) -> Path:
    """Return the Path for a compound_id workspace folder (does not create it)."""
    _validate_compound_id(compound_id)
    return WORKSPACE_ROOT / compound_id


# ---------------------------------------------------------------------------
# Workspace lifecycle
# ---------------------------------------------------------------------------

def create_workspace(
    compound_id: str,
    agent_name: str,
    agent_role: str,
    model: str,
    character_file: str,
    parent_session_id: str,
    workdir: str,
    pid: int,
) -> Path:
    """Create a workspace folder and write _meta.json. Returns the folder path.

    Safe to call if the folder already exists (exist_ok=True).
    """
    _validate_compound_id(compound_id)
    folder = WORKSPACE_ROOT / compound_id
    folder.mkdir(parents=True, exist_ok=True)

    own_id = compound_id.split("+")[-1]
    now = datetime.now(timezone.utc).isoformat()
    meta = {
        "session_id": own_id,
        "compound_id": compound_id,
        "agent_name": agent_name,
        "agent_role": agent_role,
        "model": model,
        "character_file": character_file,
        "parent_session_id": parent_session_id,
        "status": "starting",
        "pid": pid,
        "created_at": now,
        "updated_at": now,
        "workdir": workdir,
        "resource_usage": {
            "cpu_percent": 0.0,
            "memory_mb": 0,
            "last_sampled": None,
        },
    }
    (folder / "_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return folder


def update_status(compound_id: str, status: str) -> None:
    """Update status and updated_at in _meta.json.

    No-op if the workspace or _meta.json does not exist.
    Valid statuses: starting | working | idle | complete | error | compacted
    """
    _validate_compound_id(compound_id)
    meta_path = WORKSPACE_ROOT / compound_id / "_meta.json"
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["status"] = status
        meta["updated_at"] = datetime.now(timezone.utc).isoformat()
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    except Exception:
        pass  # Best-effort — status updates must not crash callers


def delete_workspace_tree(compound_id: str) -> None:
    """Delete a workspace folder and all its descendant folders.

    This module does NOT confirm before deleting — caller is responsible.
    """
    _validate_compound_id(compound_id)
    for folder in list(WORKSPACE_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        cid = folder.name
        if cid == compound_id or cid.startswith(compound_id + "+"):
            shutil.rmtree(folder, ignore_errors=True)


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

def write_file(compound_id: str, filename: str, content: str) -> Path:
    """Write content to filename inside compound_id's workspace.

    filename must be a plain name (no path separators, no leading dots that
    would shadow _meta.json). Creates the workspace folder if absent.
    Returns the written file path.
    """
    _validate_compound_id(compound_id)
    safe = Path(filename).name
    if not safe or safe != filename:
        raise ValueError(
            f"filename must be a plain name with no path separators. Got: {filename!r}"
        )
    if safe == "_meta.json":
        raise ValueError("filename may not be '_meta.json' — use update_status() instead")

    folder = WORKSPACE_ROOT / compound_id
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / safe
    dest.write_text(content, encoding="utf-8")
    return dest


def read_file(compound_id: str, filename: str) -> str:
    """Read content from filename inside compound_id's workspace."""
    _validate_compound_id(compound_id)
    safe = Path(filename).name
    if not safe or safe != filename:
        raise ValueError(f"filename must be a plain name. Got: {filename!r}")
    dest = WORKSPACE_ROOT / compound_id / safe
    if not dest.exists():
        raise FileNotFoundError(
            f"No file {filename!r} in workspace {compound_id!r}"
        )
    return dest.read_text(encoding="utf-8")


def compact_workspace(compound_id: str, keep_originals: bool = False) -> Path:
    """Concatenate all workspace .md files into compacted.md.

    Reads every .md file in the workspace (excluding _meta.json and any existing
    compacted.md), writes a single compacted.md with ## section headers per source
    file, then optionally deletes the originals.  Updates _meta.json status to
    "compacted".

    Returns the path to compacted.md.
    Raises FileNotFoundError if the workspace folder does not exist.
    """
    _validate_compound_id(compound_id)
    folder = WORKSPACE_ROOT / compound_id
    if not folder.exists():
        raise FileNotFoundError(f"Workspace {compound_id!r} does not exist")

    excluded = {"_meta.json", "compacted.md"}
    md_files = sorted(
        f for f in folder.iterdir()
        if f.is_file() and f.suffix == ".md" and f.name not in excluded
    )

    now = datetime.now(timezone.utc).isoformat()
    sections: list[str] = [
        f"# Compacted Workspace — {compound_id}",
        f"_Generated: {now}_",
        f"_Source files: {', '.join(f.name for f in md_files) or '(none)'}_",
        "",
    ]
    for md_file in md_files:
        sections.append(f"## {md_file.name}")
        sections.append("")
        try:
            sections.append(md_file.read_text(encoding="utf-8").rstrip())
        except Exception:
            sections.append("_(error reading file)_")
        sections.append("")

    compacted_path = folder / "compacted.md"
    compacted_path.write_text("\n".join(sections), encoding="utf-8")

    if not keep_originals:
        for md_file in md_files:
            try:
                md_file.unlink()
            except Exception:
                pass  # Best-effort — do not fail compaction on a locked file

    update_status(compound_id, "compacted")
    return compacted_path


# ---------------------------------------------------------------------------
# Tree listing
# ---------------------------------------------------------------------------

def list_workspaces(scope_compound_id: str) -> list[dict]:
    """List all workspaces in the tree rooted at scope_compound_id.

    Includes the scope workspace itself and all descendants.
    Returns list of dicts: { compound_id, agent_name, status, files[] }
    """
    _validate_compound_id(scope_compound_id)
    if not WORKSPACE_ROOT.exists():
        return []

    results = []
    for folder in sorted(WORKSPACE_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        cid = folder.name
        if not is_in_tree(scope_compound_id, cid):
            continue

        meta_path = folder / "_meta.json"
        agent_name, status = "unknown", "unknown"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                agent_name = meta.get("agent_name", "unknown")
                status = meta.get("status", "unknown")
            except Exception:
                pass

        files = sorted(f.name for f in folder.iterdir() if f.is_file())
        results.append({
            "compound_id": cid,
            "agent_name": agent_name,
            "status": status,
            "files": files,
        })

    return results


# ---------------------------------------------------------------------------
# UI listing (no scope restriction)
# ---------------------------------------------------------------------------

def list_all_workspaces() -> list[dict]:
    """List ALL workspace folders in WORKSPACE_ROOT, regardless of scope.

    For UI use only — does not enforce session-tree access control.
    Returns the same dict shape as list_workspaces().
    """
    if not WORKSPACE_ROOT.exists():
        return []

    results = []
    for folder in sorted(WORKSPACE_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        cid = folder.name
        # Only include folders that look like valid compound IDs
        try:
            _validate_compound_id(cid)
        except ValueError:
            continue

        meta_path = folder / "_meta.json"
        agent_name, status = "unknown", "unknown"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                agent_name = meta.get("agent_name", "unknown")
                status = meta.get("status", "unknown")
            except Exception:
                pass

        files = sorted(f.name for f in folder.iterdir() if f.is_file())
        results.append({
            "compound_id": cid,
            "agent_name": agent_name,
            "status": status,
            "files": files,
        })

    return results


# ---------------------------------------------------------------------------
# Hierarchy helpers
# ---------------------------------------------------------------------------

def parse_parent_compound_id(compound_id: str) -> Optional[str]:
    """Return the parent's compound_id by dropping the last segment.

    Examples:
        "abc+def+ghi" → "abc+def"
        "abc+def"     → "abc"
        "abc"         → None  (top-level session, no parent)
    """
    parts = compound_id.split("+")
    if len(parts) <= 1:
        return None
    return "+".join(parts[:-1])


def parent_session_id(compound_id: str) -> Optional[str]:
    """Return the terminal_id of the parent session (last segment of parent compound_id)."""
    parent = parse_parent_compound_id(compound_id)
    if parent is None:
        return None
    return parent.split("+")[-1]
