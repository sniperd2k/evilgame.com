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


def read_body():
    length = int(os.environ.get("CONTENT_LENGTH") or 0)
    raw = sys.stdin.buffer.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return {}


def respond(code, obj):
    body = json.dumps(obj).encode("utf-8")
    sys.stdout.write("Status: %d\r\n" % code)
    sys.stdout.write("Content-Type: application/json\r\n")
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

    data = read_body()
    nick = str(data.get("nick") or "").strip()[:24]
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
    req = urllib.request.Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            resp.read()
        respond(200, {"ok": True})
    except urllib.error.HTTPError as e:
        respond(502, {"ok": False, "error": "webhook HTTP %d" % e.code})
    except Exception as e:
        respond(502, {"ok": False, "error": "webhook failed"})


if __name__ == "__main__":
    main()
