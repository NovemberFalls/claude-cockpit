"""The Codex catalog is written down TWICE. This is the thing that notices.

Codex publishes no live `/v1/models` route, so its model list is a static
constant -- and Stage 1c gave it a second home: `remote_gateway.CODEX_MODELS`
serves the phone, `web/frontend/src/modelCatalog.js`'s CODEX_MODEL_GROUPS serves
the desktop picker. Two hand-maintained lists of the same facts is precisely the
drift `modelCatalog.js` exists to prevent for Anthropic, and the drift is
SILENT: a phone offering a retired id spawns a session that fails at the CLI,
and a phone missing a new id simply cannot reach a model the desktop can.

So this reads the JavaScript as text and asserts set equality. It deliberately
does NOT import or evaluate it -- a parser that shrugged at a renamed export
would pass an empty set against an empty set, which is why the extraction below
fails loudly when the marker or the ids are missing.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_gateway  # noqa: E402

CATALOG_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend",
    "src",
    "modelCatalog.js",
)

_MARKER = "export const CODEX_MODEL_GROUPS"


def _codex_ids_from_frontend() -> set[str]:
    """Every `id: "..."` between the export marker and the array's `];`."""
    with open(CATALOG_JS, "r", encoding="utf-8") as handle:
        source = handle.read()
    start = source.find(_MARKER)
    if start < 0:
        pytest.fail(f"{_MARKER} not found in {CATALOG_JS} -- was it renamed?")
    end = source.find("];", start)
    if end < 0:
        pytest.fail(f"{_MARKER} has no terminating '];' in {CATALOG_JS}")
    return set(re.findall(r'id:\s*"([^"]+)"', source[start:end]))


def test_the_extraction_actually_finds_something():
    """A refuse-to-parse build must not pass by comparing two empty sets."""
    ids = _codex_ids_from_frontend()
    assert len(ids) >= 4
    assert "gpt-6-astra" in ids


def test_server_codex_models_match_the_frontend_catalog():
    assert {mid for mid, _label in remote_gateway.CODEX_MODELS} == _codex_ids_from_frontend()


def test_codex_models_carry_a_non_empty_label_each():
    for model_id, label in remote_gateway.CODEX_MODELS:
        assert isinstance(model_id, str) and model_id
        assert isinstance(label, str) and label


def test_the_codex_default_is_one_of_the_listed_models():
    assert remote_gateway.CODEX_DEFAULT_MODEL in {mid for mid, _label in remote_gateway.CODEX_MODELS}
