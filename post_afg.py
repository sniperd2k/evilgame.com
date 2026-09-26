#!/usr/bin/env python3
"""Relay Attic Gaming score brags to Slack (#afg) via configured webhook."""
import json
import os
import sys
import urllib.error
import urllib.request

# Webhook URL file (not committed). Prefer App_Data-style path beside this script.
HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = [
    os.path.join(HERE, "App_Data", "afg_webhook.txt"),
    os.path.join(HERE, "afg_webhook.txt"),
    os.environ.get("AFG_WEBHOOK_URL", ""),
]

KEY_CANDIDATES = [
    os.path.join(HERE, "App_Data", "afg_webhook_key.txt"),
    os.path.join(HERE, "afg_webhook_key.txt"),
    os.environ.get("AFG_WEBHOOK_KEY", ""),
]


def read_webhook():
    for path in CANDIDATES:
        if not path:
            continue
        if path.startswith("http://") or path.startswith("https://"):
            return path.strip()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                url = f.read().strip()
            if url.startswith("http://") or url.startswith("https://"):
                return url
    return None


def read_key():
    for path in KEY_CANDIDATES:
        if not path:
            continue
        # Env may hold the raw key (not a path).
        if path and not os.path.isfile(path) and "/" not in path and "\\" not in path and len(path) >= 8:
            return path.strip()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                key = f.read().strip()
            if key:
                return key
    return None


# Cap CGI body so a hostile client cannot fill memory via CONTENT_LENGTH.
MAX_BODY = 4096

# Nick for Slack mrkdwn: strip control + Slack specials so clients cannot inject formatting.
_NICK_BAD = str.maketrans({c: "" for c in "*_`~<>|\r\n\t"})


def sanitize_nick(raw):
    s = str(raw or "").strip()[:24]
    if not s:
        return ""
    s = s.translate(_NICK_BAD)
    # Keep printable-ish ascii (no control chars).
    out = "".join(ch for ch in s if 32 <= ord(ch) < 127)
    return out.strip()


def content_type_is_json(header):
    if not header:
        return False
    return header.split(";")[0].strip().lower() == "application/json"


def read_body():
    try:
        length = int(os.environ.get("CONTENT_LENGTH") or 0)
    except Exception:
        length = 0
    if length < 0:
        length = 0
    if length > MAX_BODY:
        return None  # signal oversized
    raw = sys.stdin.buffer.read(length) if length > 0 else b"{}"
    if len(raw) > MAX_BODY:
        return None
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return {}


def respond(code, obj):
    body = json.dumps(obj).encode("utf-8")
    sys.stdout.write("Status: %d\r\n" % code)
    sys.stdout.write("Content-Type: application/json\r\n")
    sys.stdout.write("X-Content-Type-Options: nosniff\r\n")
    sys.stdout.write("Access-Control-Allow-Origin: *\r\n")
    sys.stdout.write("Content-Length: %d\r\n\r\n" % len(body))
    sys.stdout.flush()
    sys.stdout.buffer.write(body)


def main():
    method = (os.environ.get("REQUEST_METHOD") or "GET").upper()
    if method == "OPTIONS":
        sys.stdout.write("Status: 204\r\n")
        sys.stdout.write("Access-Control-Allow-Origin: *\r\n")
        sys.stdout.write("Access-Control-Allow-Methods: POST, OPTIONS\r\n")
        sys.stdout.write("Access-Control-Allow-Headers: Content-Type\r\n\r\n")
        return

    if method != "POST":
        respond(405, {"ok": False, "error": "POST only"})
        return

    ctype = os.environ.get("CONTENT_TYPE") or os.environ.get("HTTP_CONTENT_TYPE") or ""
    if not content_type_is_json(ctype):
        respond(415, {"ok": False, "error": "application/json required"})
        return

    data = read_body()
    if data is None:
        respond(413, {"ok": False, "error": "payload too large"})
        return
    nick = sanitize_nick(data.get("nick"))
    try:
        score = int(data.get("score"))
    except Exception:
        score = None
    try:
        high = int(data.get("highScore", data.get("high")))
    except Exception:
        high = None

    if not nick or score is None or high is None:
        respond(400, {"ok": False, "error": "need nick, score, highScore"})
        return
    # Bound numeric fields; never echo request/webhook guts in errors.
    if score < 0 or score > 999999 or high < 0 or high > 999999:
        respond(400, {"ok": False, "error": "score out of range"})
        return

    webhook = read_webhook()
    if not webhook:
        respond(503, {"ok": False, "error": "webhook not configured"})
        return

    # Works for Slack Incoming Webhooks AND Grok Bot webhook routines.
    payload = {
        "nick": nick,
        "score": score,
        "highScore": high,
        "text": "*%s* just posted from Attic Gaming\nScore: *%d* · High: *%d*\nhttp://evilgame.com/attic.html"
        % (nick, score, high),
    }
    headers = {"Content-Type": "application/json"}
    key = read_key()
    if key:
        headers["Authorization"] = "Bearer %s" % key
    req = urllib.request.Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            resp.read()
        respond(200, {"ok": True})
    except urllib.error.HTTPError as e:
        respond(502, {"ok": False, "error": "webhook HTTP %d" % e.code})
    except Exception:
        # Do not include exception text — may contain the webhook URL.
        respond(502, {"ok": False, "error": "webhook failed"})


if __name__ == "__main__":
    main()
