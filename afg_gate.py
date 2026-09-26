#!/usr/bin/env python3
"""AFG soft password-gate helpers (pure logic — unit-tested).

Password plaintext lives only in App_Data on the IIS host (never in git).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Optional, Tuple

COOKIE_NAME = "afg_unlock"
TOKEN_VERSION = "v1"
# Soft-gate session length (7 days).
DEFAULT_MAX_AGE = 7 * 24 * 3600


def normalize_password(raw: Optional[str]) -> str:
    """Strip surrounding whitespace; compare is case-insensitive via lower()."""
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raw = str(raw)
    return raw.strip().lower()


def passwords_match(attempt: Optional[str], expected: Optional[str]) -> bool:
    a = normalize_password(attempt)
    b = normalize_password(expected)
    if not a or not b:
        return False
    # Constant-time compare on normalized UTF-8 bytes.
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def password_candidates(here: Optional[str] = None) -> list:
    """Paths / env sources for the secret (first hit wins)."""
    base = here if here is not None else os.path.dirname(os.path.abspath(__file__))
    env = os.environ.get("AFG_PASSWORD", "") or ""
    return [
        os.path.join(base, "App_Data", "afg_password.txt"),
        os.path.join(base, "afg_password.txt"),
        env,
    ]


def read_password(here: Optional[str] = None) -> Optional[str]:
    for path in password_candidates(here):
        if not path:
            continue
        # Env may hold the raw password (not a path).
        if not os.path.isfile(path) and path == os.environ.get("AFG_PASSWORD", ""):
            val = path.strip()
            return val if val else None
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                val = f.read().strip()
            if val:
                return val
    return None


def _signing_key(password: str) -> bytes:
    """Derive HMAC key from the configured password (never embed plaintext in cookie)."""
    return hashlib.sha256(("evilgame-afg-gate|" + normalize_password(password)).encode("utf-8")).digest()


def make_unlock_token(password: str, now: Optional[int] = None, max_age: int = DEFAULT_MAX_AGE) -> str:
    """Signed unlock token: v1.<exp>.<sig>."""
    if now is None:
        now = int(time.time())
    exp = int(now) + int(max_age)
    msg = ("%s.%d" % (TOKEN_VERSION, exp)).encode("utf-8")
    sig = hmac.new(_signing_key(password), msg, hashlib.sha256).hexdigest()
    return "%s.%d.%s" % (TOKEN_VERSION, exp, sig)


def verify_unlock_token(token: Optional[str], password: str, now: Optional[int] = None) -> bool:
    if not token or not password:
        return False
    parts = str(token).strip().split(".")
    if len(parts) != 3:
        return False
    ver, exp_s, sig = parts
    if ver != TOKEN_VERSION:
        return False
    try:
        exp = int(exp_s)
    except Exception:
        return False
    if now is None:
        now = int(time.time())
    if exp < int(now):
        return False
    msg = ("%s.%d" % (ver, exp)).encode("utf-8")
    expected = hmac.new(_signing_key(password), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def parse_cookie_header(header: Optional[str], name: str = COOKIE_NAME) -> Optional[str]:
    if not header:
        return None
    for part in header.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        if k.strip() == name:
            return v.strip()
    return None


def unlock_cookie_header(token: str, max_age: int = DEFAULT_MAX_AGE) -> str:
    # Soft gate: Lax + path=/ so attic.html and index share it. Not HttpOnly so
    # optional client UX can peek; server still verifies signature.
    return (
        "%s=%s; Path=/; Max-Age=%d; SameSite=Lax"
        % (COOKIE_NAME, token, int(max_age))
    )
