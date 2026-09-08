"""The public-URL probe must not present urllib's default User-Agent.

Measured 2026-09-08 against a Cloudflare-fronted hostname: curl, a Dart client
and a browser all received the Access 302; "Python-urllib/3.x" alone received a
bare 403, which the probe then reported as "unexpected" for a hostname that was
working. The probe announces itself as PlexarStudio so it sees what a phone sees.
"""
import urllib.request

import remote_gateway


def test_probe_sends_its_own_user_agent(monkeypatch):
    seen = {}

    class _Resp:
        status = 302
        headers = {"Location": "https://team.cloudflareaccess.com/x"}

        def read(self, _n):
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class _Opener:
        def open(self, request, timeout):
            seen["ua"] = request.get_header("User-agent")
            seen["url"] = request.full_url
            return _Resp()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: _Opener())
    status, headers, _body = remote_gateway._fetch_probe("studio.example.com")
    assert status == 302 and headers["Location"].endswith("/x")
    assert seen["url"] == "https://studio.example.com/remote/v1/hello"
    assert seen["ua"] == remote_gateway._PROBE_USER_AGENT
    assert not seen["ua"].lower().startswith("python-urllib")


def test_public_url_is_reduced_to_a_hostname_for_the_tools():
    """The Public URL field holds a URL; the tools must accept it as-is."""
    f = remote_gateway._hostname_from
    assert f("https://studio.boord-its.com") == "studio.boord-its.com"
    assert f("https://Studio.Example.com/") == "studio.example.com"
    assert f("http://studio.example.com:8443/remote/v1/") == "studio.example.com"
    assert f("studio.example.com") == "studio.example.com"
    assert f("studio.example.com:8420") == "studio.example.com"
    assert f("  studio.example.com. ") == "studio.example.com"
    assert f("") == ""
    assert remote_gateway._valid_hostname(f("https://studio.boord-its.com"))
    assert not remote_gateway._valid_hostname(f("https://"))
