#!/usr/bin/env python3
"""Unit tests for afg_gate.py pure logic. Run: python3 tests/afg-gate-unit.py"""
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import afg_gate as g


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_normalize():
    assert_true(g.normalize_password("  AbC  ") == "abc", "strip+lower")
    assert_true(g.normalize_password(None) == "", "none")
    assert_true(g.normalize_password("\tSeCrEt\n") == "secret", "ws+case")


def test_match():
    secret = "SeCrEtWord"
    assert_true(g.passwords_match("secretword", secret), "ci match")
    assert_true(g.passwords_match("  SECRETWORD  ", secret), "ws match")
    assert_true(not g.passwords_match("wrong", secret), "reject wrong")
    assert_true(not g.passwords_match("", secret), "reject empty")
    assert_true(not g.passwords_match("secretword", ""), "reject empty secret")
    assert_true(not g.passwords_match(None, secret), "reject none")


def test_token_roundtrip():
    pw = "secret-slur"
    now = 1_700_000_000
    tok = g.make_unlock_token(pw, now=now, max_age=3600)
    assert_true(tok.startswith("v1."), "version prefix")
    assert_true(g.verify_unlock_token(tok, pw, now=now + 10), "valid")
    assert_true(not g.verify_unlock_token(tok, pw, now=now + 4000), "expired")
    assert_true(not g.verify_unlock_token(tok, "other", now=now + 10), "wrong key")
    assert_true(not g.verify_unlock_token("v1.1.deadbeef", pw, now=now), "bad sig")
    assert_true(not g.verify_unlock_token(None, pw), "none token")
    # Case of password used for signing is normalized
    tok2 = g.make_unlock_token("SECRET-SLUR", now=now, max_age=60)
    assert_true(g.verify_unlock_token(tok2, "secret-slur", now=now), "norm key")


def test_cookie_parse_and_header():
    h = g.unlock_cookie_header("v1.1.abc", max_age=99)
    assert_true(h.startswith("afg_unlock=v1.1.abc"), "cookie name")
    assert_true("Max-Age=99" in h and "Path=/" in h, "attrs")
    assert_true(g.parse_cookie_header("foo=1; afg_unlock=tok; bar=2") == "tok", "parse")
    assert_true(g.parse_cookie_header("nope=1") is None, "missing")


def test_read_password_file():
    with tempfile.TemporaryDirectory() as td:
        app = os.path.join(td, "App_Data")
        os.makedirs(app)
        path = os.path.join(app, "afg_password.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("  MixedCaseSlur  \n")
        got = g.read_password(here=td)
        assert_true(got == "MixedCaseSlur", "read strip trailing newline only once — keep content for match")
        # Match uses normalize so whitespace/case on attempt still works
        assert_true(g.passwords_match("mixedcaseslur", got), "file+match")


def test_read_password_env(monkey=None):
    with tempfile.TemporaryDirectory() as td:
        os.environ["AFG_PASSWORD"] = "env-slur-word"
        try:
            got = g.read_password(here=td)  # no file
            assert_true(got == "env-slur-word", "env fallback")
        finally:
            del os.environ["AFG_PASSWORD"]


def main():
    test_normalize()
    test_match()
    test_token_roundtrip()
    test_cookie_parse_and_header()
    test_read_password_file()
    test_read_password_env()
    print("afg-gate-unit: ok")


if __name__ == "__main__":
    main()
