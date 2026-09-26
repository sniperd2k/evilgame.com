#!/usr/bin/env python3
"""CGI: POST play-log actions (visit / session_start / session_end / score) -> App_Data SQLite."""
import json
import os
import sys

import play_log_lib as lib

# Whitelist CORS origins (never reflect arbitrary Origin with credentials).
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


def read_body():
    ctype = os.environ.get("CONTENT_TYPE") or os.environ.get("HTTP_CONTENT_TYPE") or ""
    if not lib.content_type_is_json(ctype):
        return None, "content-type"
    try:
        length = int(os.environ.get("CONTENT_LENGTH") or 0)
    except Exception:
        length = 0
    if length < 0:
        length = 0
    if length > lib.MAX_BODY:
        return None, "too-large"
    raw = sys.stdin.buffer.read(length) if length > 0 else b"{}"
    if len(raw) > lib.MAX_BODY:
        return None, "too-large"
    try:
        return json.loads(raw.decode("utf-8") or "{}"), None
    except Exception:
        return None, "bad-json"


def respond(code, obj):
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    sys.stdout.write("Status: %d\r\n" % code)
    sys.stdout.write("Content-Type: application/json; charset=utf-8\r\n")
    sys.stdout.write("Cache-Control: no-store\r\n")
    sys.stdout.write("X-Content-Type-Options: nosniff\r\n")
    origin = cors_origin()
    if origin:
        sys.stdout.write("Access-Control-Allow-Origin: %s\r\n" % origin)
        sys.stdout.write("Vary: Origin\r\n")
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
            sys.stdout.write("Vary: Origin\r\n")
        sys.stdout.write("Access-Control-Allow-Methods: POST, OPTIONS\r\n")
        sys.stdout.write("Access-Control-Allow-Headers: Content-Type\r\n")
        sys.stdout.write("Content-Length: 0\r\n\r\n")
        return

    if method != "POST":
        respond(405, {"ok": False, "error": "POST only"})
        return

    data, err = read_body()
    if err == "content-type":
        respond(415, {"ok": False, "error": "application/json required"})
        return
    if err == "too-large":
        respond(413, {"ok": False, "error": "payload too large"})
        return
    if err == "bad-json" or data is None:
        respond(400, {"ok": False, "error": "invalid json"})
        return

    # Pass CGI environ so IP/UA/referrer come from the SERVER request, not the body.
    action, verr = lib.validate_action_payload(data, environ=dict(os.environ))
    if verr:
        respond(400, {"ok": False, "error": verr})
        return

    here = os.path.dirname(os.path.abspath(__file__))
    conn = None
    try:
        conn = lib.ensure_db(lib.db_path(here=here))
        result = lib.apply_action(conn, action)
        respond(200, result)
    except ValueError:
        respond(400, {"ok": False, "error": "bad ref"})
    except Exception:
        # Generic error — no paths / stack traces.
        respond(500, {"ok": False, "error": "write failed"})
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
