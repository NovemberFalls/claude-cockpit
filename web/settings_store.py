"""Persistent server-side settings store for user-configurable API keys.

Currently stores a single value -- the OpenRouter API key a desktop-app user
pastes in via the Settings UI -- in a small JSON config file under the user's
home directory (``~/.claude-cockpit/config.json``). This is independent of
``web/.env`` (which is read once via ``load_dotenv()`` in server.py); the UI
key takes precedence, and the env var is the fallback for headless/dev setups.

Nothing in this module ever logs or returns a full key -- see ``mask_key``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger("cockpit.settings")

CONFIG_DIR = Path.home() / ".claude-cockpit"
CONFIG_FILE = CONFIG_DIR / "config.json"

_KEY_FIELD = "openrouter_api_key"


def _read_config() -> dict:
    """Read config.json, returning {} if missing, empty, or corrupt.

    Never raises: a missing file, empty file, non-object JSON, or invalid
    JSON are all treated identically as "no settings yet" so a damaged
    on-disk file can never crash a settings read.
    """
    if not CONFIG_FILE.is_file():
        return {}
    try:
        raw = CONFIG_FILE.read_text(encoding="utf-8")
    except OSError:
        logger.warning("Failed to read config file %s -- treating as empty", CONFIG_FILE, exc_info=True)
        return {}

    if not raw.strip():
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Config file %s contains invalid JSON -- treating as empty", CONFIG_FILE, exc_info=True)
        return {}

    if not isinstance(data, dict):
        logger.warning("Config file %s did not contain a JSON object -- treating as empty", CONFIG_FILE)
        return {}
    return data


def _write_config(data: dict) -> None:
    """Atomically write *data* to config.json.

    Writes to a temp file in the same directory first, then ``os.replace``s
    it over the real config file. os.replace is atomic on both POSIX and
    Windows, so a crash or concurrent read mid-write can never observe a
    half-written config.json.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="config_", suffix=".json.tmp", dir=str(CONFIG_DIR))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, CONFIG_FILE)
    except OSError:
        logger.warning("Failed to write config file %s", CONFIG_FILE, exc_info=True)
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Failed to clean up temp config file %s", tmp_path, exc_info=True)
        raise


def get_ui_key() -> str | None:
    """Return the UI-supplied OpenRouter key, or None if not configured."""
    value = _read_config().get(_KEY_FIELD)
    return value if isinstance(value, str) and value else None


def set_ui_key(key: str) -> None:
    """Persist *key* as the UI-supplied OpenRouter key (overwrites any existing value)."""
    data = _read_config()
    data[_KEY_FIELD] = key
    _write_config(data)


def delete_ui_key() -> bool:
    """Remove the UI-supplied key, if any.

    Returns:
        True if a key was actually present and removed, False if there was
        nothing to remove.
    """
    data = _read_config()
    if not data.get(_KEY_FIELD):
        return False
    del data[_KEY_FIELD]
    _write_config(data)
    return True


def resolve_openrouter_key() -> tuple[str | None, str | None]:
    """Resolve the effective OpenRouter key.

    UI-configured keys (config.json) always take precedence over the
    environment. server.py calls ``load_dotenv()`` before any other cockpit
    module is imported, so ``web/.env``'s OPENROUTER_API_KEY (if any) is
    already in os.environ by the time this runs.

    Returns:
        (key, source) where source is "ui", "env", or (None, None) if
        neither is configured.
    """
    ui_key = get_ui_key()
    if ui_key:
        return ui_key, "ui"
    env_key = os.environ.get("OPENROUTER_API_KEY")
    if env_key:
        return env_key, "env"
    return None, None


def mask_key(key: str) -> str:
    """Mask *key* for safe display/logging -- the full key must NEVER appear
    in any log line or API response.

    Format: first 8 characters + "…" + last 4 characters (e.g.
    "sk-or-v1…7f3a"). Keys shorter than 14 characters can't be split that
    way without the two halves overlapping (leaking most of the secret), so
    those are masked down to a single "…" instead of any real characters.
    """
    if not key:
        return ""
    if len(key) < 14:
        return "…"
    return f"{key[:8]}…{key[-4:]}"
