#!/usr/bin/env python3
"""CGI: AFG soft password gate — POST password, GET verify unlock cookie."""
import json
import os
import sys

import afg_gate

MAX_BODY = 2048


def read_body():
    try:
        length = int(os.environ.get("CONTENT_LENGTH") or 0)
    except Exception:
        length = 0
    if length < 0:
        length = 0
    if length > MAX_BODY:
        return None
    raw = sys.stdin.buffer.read(length) if length > 0 else b"{}"
    if len(raw) > MAX_BODY:
        return None
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return {}


# Whitelist only — never reflect arbitrary Origin when credentials=true.
ALLOWED_ORIGINS = frozenset({
    "http://evilgame.com",
    "https://evilgame.com",
    "http://www.evilgame.com",
    "https://www.evilgame.com",
    "http://localhost",
    "http://127.0.0.1",
})


def cors_origin():
    origin = (os.environ.get("HTTP_ORIGIN") or "").strip()
    if origin in ALLOWED_ORIGINS:
        return origin
    return ""


def respond(code, obj, extra_headers=None):
    body = json.dumps(obj).encode("utf-8")
    sys.stdout.write("Status: %d\r\n" % code)
    sys.stdout.write("Content-Type: application/json\r\n")
    sys.stdout.write("X-Content-Type-Options: nosniff\r\n")
    origin = cors_origin()
    if origin:
        sys.stdout.write("Access-Control-Allow-Origin: %s\r\n" % origin)
        sys.stdout.write("Access-Control-Allow-Credentials: true\r\n")
        sys.stdout.write("Vary: Origin\r\n")
    sys.stdout.write("Cache-Control: no-store\r\n")
    if extra_headers:
        for h in extra_headers:
            sys.stdout.write(h + "\r\n")
    sys.stdout.write("Content-Length: %d\r\n\r\n" % len(body))
    sys.stdout.flush()
    sys.stdout.buffer.write(body)


def main():
    method = (os.environ.get("REQUEST_METHOD") or "GET").upper()
    if method == "OPTIONS":
        origin = cors_origin()
        sys.stdout.write("Status: 204\r\n")
        if origin:
            sys.stdout.write("Access-Control-Allow-Origin: %s\r\n" % origin)
            sys.stdout.write("Access-Control-Allow-Credentials: true\r\n")
            sys.stdout.write("Vary: Origin\r\n")
        sys.stdout.write("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
        sys.stdout.write("Access-Control-Allow-Headers: Content-Type\r\n\r\n")
        return

    HERE = os.path.dirname(os.path.abspath(__file__))
    expected = afg_gate.read_password(here=HERE)
    if not expected:
        respond(503, {"ok": False, "unlocked": False, "error": "gate not configured"})
        return

    if method == "GET":
        token = afg_gate.parse_cookie_header(os.environ.get("HTTP_COOKIE"))
        unlocked = afg_gate.verify_unlock_token(token, expected)
        respond(200, {"ok": True, "unlocked": unlocked})
        return

    if method != "POST":
        respond(405, {"ok": False, "error": "POST or GET only"})
        return

    ctype = os.environ.get("CONTENT_TYPE") or os.environ.get("HTTP_CONTENT_TYPE") or ""
    main = ctype.split(";")[0].strip().lower()
    if main and main != "application/json":
        respond(415, {"ok": False, "error": "application/json required"})
        return

    data = read_body()
    if data is None:
        respond(413, {"ok": False, "error": "payload too large"})
        return

    attempt = data.get("password", data.get("pw", ""))
    if not afg_gate.passwords_match(attempt, expected):
        respond(200, {"ok": False, "unlocked": False, "error": "wrong password"})
        return

    token = afg_gate.make_unlock_token(expected)
    respond(
        200,
        {"ok": True, "unlocked": True},
        extra_headers=["Set-Cookie: " + afg_gate.unlock_cookie_header(token)],
    )


if __name__ == "__main__":
    main()
