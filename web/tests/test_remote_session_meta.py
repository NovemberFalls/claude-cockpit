"""Tests for Plexar Mobile Stage 4 server-side additions.

Covers three independent pieces added to `remote_gateway.py`:
  * `branch` on a sessions-list row, derived via `RemoteBackend.git_branch`.
  * `effort` on a sessions-list row -- resolved by the gateway itself from the
    real session's `tracker.effort` (live) falling back to `TerminalSession.effort`
    (launch), since `pty_manager._session_to_dict` emits no `effort` key.
  * `<image name=[Image #N] path="...">...</image>` tags in a user message's
    text becoming `image` blocks, with the tag text removed from the bubble.

Deliberately unit-level (calls `remote_gateway._session_view` /
`_claude_message` / `_extract_image_tags` directly) rather than routed through
a TestClient -- these are pure functions of their inputs and do not need a
running app to prove.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_gateway  # noqa: E402
from remote_gateway import RemoteBackend  # noqa: E402


def _minimal_backend(**overrides) -> RemoteBackend:
    base = dict(
        settings=lambda: {},
        app_version=lambda: "test",
        list_sessions=lambda: [],
        get_session=lambda tid: None,
        create_session=None,
        submit=None,
        write_raw=None,
        interrupt=None,
    )
    base.update(overrides)
    return RemoteBackend(**base)


# -- branch ------------------------------------------------------------------


def test_session_view_derives_branch_via_backend_callable():
    backend = _minimal_backend(git_branch=lambda workdir: {"C:/repo": "lane/mobile"}.get(workdir))
    entry = {"id": "t1", "working_dir": "C:/repo"}
    view = remote_gateway._session_view(entry, backend)
    assert view["branch"] == "lane/mobile"


def test_session_view_branch_null_with_no_working_dir():
    backend = _minimal_backend(git_branch=lambda workdir: "should-not-be-called")
    view = remote_gateway._session_view({"id": "t1", "working_dir": None}, backend)
    assert view["branch"] is None


def test_session_view_branch_null_when_git_branch_not_wired():
    view = remote_gateway._session_view({"id": "t1", "working_dir": "C:/repo"})
    assert view["branch"] is None


def test_session_view_branch_null_when_backend_callable_raises():
    def _boom(_workdir):
        raise OSError("no such dir")

    backend = _minimal_backend(git_branch=_boom)
    view = remote_gateway._session_view({"id": "t1", "working_dir": "C:/repo"}, backend)
    assert view["branch"] is None


# -- effort --------------------------------------------------------------
#
# `effort` is resolved off the REAL session object (`backend.get_session`),
# never off the already-stripped list entry -- `pty_manager._session_to_dict`
# emits no `effort` key at all. Live (`tracker.effort`) wins over launch
# (`TerminalSession.effort`); an empty string is treated as unset at every
# step, including on a dict-shaped test double.


def _real_session(*, tracker_effort=None, session_effort=""):
    import pty_manager

    session = pty_manager.TerminalSession(
        id="t1", name="s", pty=None, created_at="now",
    )
    session.effort = session_effort
    session.tracker.effort = tracker_effort
    return session


def test_session_view_effort_prefers_live_tracker_over_launch():
    session = _real_session(tracker_effort="high", session_effort="low")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] == "high"


def test_session_view_effort_falls_back_to_launch_when_tracker_unset():
    session = _real_session(tracker_effort=None, session_effort="low")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] == "low"


def test_session_view_effort_null_when_both_empty():
    session = _real_session(tracker_effort=None, session_effort="")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] is None


def test_session_view_effort_dict_double_empty_string_becomes_none():
    backend = _minimal_backend(get_session=lambda tid: None)
    view = remote_gateway._session_view({"id": "t1", "effort": ""}, backend)
    assert view["effort"] is None


def test_session_view_effort_dict_double_passthrough_when_no_backend_session():
    backend = _minimal_backend(get_session=lambda tid: None)
    view = remote_gateway._session_view({"id": "t1", "effort": "high"}, backend)
    assert view["effort"] == "high"


def test_session_view_effort_null_when_absent():
    backend = _minimal_backend()
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] is None


def test_field_pin_is_twelve_and_ordered():
    assert len(remote_gateway.SESSION_FIELDS) == 12
    assert remote_gateway.SESSION_FIELDS[-2:] == ("branch", "effort")


# -- image tags ------------------------------------------------------------


def test_extract_image_tags_open_close_with_whitespace():
    text = '<image name=[Image #1] path="C:\\shots\\one.png">  </image>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_self_closing():
    text = '<image name=[Image #1] path="C:\\shots\\one.png"/>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_multiline_whitespace_variant():
    text = '<image name=[Image #1] path="C:\\shots\\one.png">\n\n   </image>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_preserves_surrounding_text_and_collapses_whitespace():
    text = 'check   this <image name=[Image #1] path="C:\\a.png"></image>   out'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png"]
    assert remaining == "check this out"


def test_extract_image_tags_multiple_tags_in_order():
    text = (
        '<image name=[Image #1] path="C:\\a.png"></image>'
        " and "
        '<image name=[Image #2] path="C:\\b.png"/>'
    )
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png", "C:\\b.png"]
    assert remaining == "and"


def test_extract_image_tags_no_tag_returns_text_unchanged():
    remaining, paths = remote_gateway._extract_image_tags("plain text, no tags here")
    assert paths == []
    assert remaining == "plain text, no tags here"


def test_claude_message_turns_image_tag_into_image_block_and_drops_empty_text():
    entry = {
        "id": "u1",
        "type": "user",
        "role": "user",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": '<image name=[Image #1] path="C:\\shots\\one.png">  </image>',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message is not None
    assert message["blocks"] == [{"type": "image", "path": "C:\\shots\\one.png"}]


def test_claude_message_keeps_remaining_text_alongside_image_block():
    entry = {
        "id": "u1",
        "type": "user",
        "role": "user",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": 'take a look <image name=[Image #1] path="C:\\a.png"></image> please',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message["blocks"] == [
        {"type": "text", "text": "take a look please"},
        {"type": "image", "path": "C:\\a.png"},
    ]


def test_claude_message_assistant_role_does_not_get_tag_extraction():
    entry = {
        "id": "a1",
        "type": "assistant",
        "role": "assistant",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": '<image name=[Image #1] path="C:\\a.png"></image>',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message["blocks"] == [
        {"type": "text", "text": '<image name=[Image #1] path="C:\\a.png"></image>'}
    ]
