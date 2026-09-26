#!/usr/bin/env python3
"""CGI: GET play-log views (visits / sessions / scores / users). JSON only."""
import json
import os
import sys
from urllib.parse import parse_qs

import play_log_lib as lib

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
        sys.stdout.write("Access-Control-Allow-Methods: GET, OPTIONS\r\n")
        sys.stdout.write("Access-Control-Allow-Headers: Content-Type, X-Play-Log-Key\r\n")
        sys.stdout.write("Content-Length: 0\r\n\r\n")
        return

    if method != "GET":
        respond(405, {"ok": False, "error": "GET only"})
        return

    here = os.path.dirname(os.path.abspath(__file__))
    required_key = lib.read_query_key(here=here)
    if required_key:
        provided = (os.environ.get("HTTP_X_PLAY_LOG_KEY") or "").strip()
        qs_raw = os.environ.get("QUERY_STRING") or ""
        qs = parse_qs(qs_raw, keep_blank_values=False)
        if not provided:
            vals = qs.get("key") or []
            provided = (vals[0] if vals else "").strip()
        import hmac
        if not provided or not hmac.compare_digest(provided, required_key):
            respond(401, {"ok": False, "error": "unauthorized"})
            return
    else:
        qs = parse_qs(os.environ.get("QUERY_STRING") or "", keep_blank_values=False)

    filters, err = lib.parse_query_filters(qs)
    if err:
        respond(400, {"ok": False, "error": err})
        return

    conn = None
    try:
        path = lib.db_path(here=here)
        if not os.path.isfile(path):
            respond(200, {"ok": True, "view": filters["view"], "rows": [], "count": 0})
            return
        conn = lib.ensure_db(path)
        rows = lib.query_view(conn, filters)
        respond(200, {
            "ok": True,
            "view": filters["view"],
            "rows": rows,
            "count": len(rows),
        })
    except Exception:
        respond(500, {"ok": False, "error": "query failed"})
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
