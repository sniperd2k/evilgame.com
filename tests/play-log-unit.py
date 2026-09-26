#!/usr/bin/env python3
"""Unit/integration tests for normalized play_log_lib + CGI handlers (temp sqlite)."""
import io
import json
import os
import sys
import tempfile
from urllib.parse import urlencode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import play_log_lib as lib
import play_log as cgi_post
import play_log_query as cgi_query


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_sanitize():
    assert_true(lib.sanitize_user("SoggyGoblin42") == "SoggyGoblin42", "user ok")
    assert_true(lib.sanitize_user("a" * 65) is None, "user too long")
    assert_true(lib.sanitize_user("evil'; DROP TABLE--") is None, "user sql chars")
    assert_true(lib.sanitize_user("../etc/passwd") is None, "user path")
    assert_true(lib.sanitize_user("") is None, "user empty")
    assert_true(lib.sanitize_game("Attic") == "attic", "game lower")
    assert_true(lib.sanitize_game("bad game!") is None, "game bad")
    assert_true(lib.sanitize_action("VISIT") == "visit", "action")
    assert_true(lib.sanitize_action("drop") is None, "action reject")
    assert_true(lib.sanitize_action("login") is None, "login not action")
    ok, sc = lib.sanitize_score(12)
    assert_true(ok and sc == 12, "score")
    ok, sc = lib.sanitize_score(-1)
    assert_true(not ok, "score neg")
    ok, sc = lib.sanitize_score(None)
    assert_true(ok and sc is None, "score omit")
    assert_true(lib.sanitize_end_reason("pagehide") == "pagehide", "reason")
    assert_true(lib.sanitize_end_reason("DROP") is None, "reason bad")
    assert_true(lib.sanitize_ip("203.0.113.9") == "203.0.113.9", "ip")
    assert_true(lib.sanitize_ip("not-an-ip") is None, "ip bad")
    assert_true(lib.sanitize_ip("1; DROP") is None, "ip inject")


def test_schema_and_flow():
    with tempfile.TemporaryDirectory() as td:
        app = os.path.join(td, "App_Data")
        os.makedirs(app)
        path = os.path.join(app, lib.DB_FILENAME)
        conn = lib.ensure_db(path)
        try:
            # foreign_keys ON
            fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
            assert_true(int(fk) == 1, "foreign_keys ON")

            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            assert_true(
                tables >= {"users", "visits", "game_sessions", "scores"},
                "tables present: " + str(tables),
            )

            env = {
                "REMOTE_ADDR": "198.51.100.7",
                "HTTP_USER_AGENT": "UnitTest/1.0",
                "HTTP_REFERER": "https://evilgame.com/index.html",
            }
            # Client cannot override IP via body
            bad, berr = lib.validate_action_payload(
                {"action": "visit", "user": "Nick1", "ip_address": "1.2.3.4"},
                environ=env,
            )
            assert_true(bad is None and berr == "bad field", "reject client ip")

            act, err = lib.validate_action_payload(
                {"action": "visit", "user": "Nick1"},
                environ=env,
            )
            assert_true(err is None and act["action"] == "visit", "visit ok")
            assert_true(act["ip_address"] == "198.51.100.7", "server ip")
            assert_true(act["user_agent"] == "UnitTest/1.0", "ua")
            assert_true("evilgame.com" in (act["referrer"] or ""), "ref")
            res = lib.apply_action(conn, act)
            assert_true(res["visit_id"] >= 1, "visit id")
            vid = res["visit_id"]

            # Upsert user on second visit
            act2, _ = lib.validate_action_payload(
                {"user": "Nick1", "event": "visit"},
                environ={"REMOTE_ADDR": "198.51.100.8"},
            )
            res2 = lib.apply_action(conn, act2)
            assert_true(res2["visit_id"] > vid, "second visit insert")
            users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
            assert_true(users == 1, "one user upserted")
            visits = conn.execute("SELECT COUNT(*) AS c FROM visits").fetchone()["c"]
            assert_true(visits == 2, "two visits")

            # Session start
            sact, serr = lib.validate_action_payload({
                "action": "session_start",
                "nick": "Nick1",
                "game": "attic",
                "visit_id": vid,
            })
            assert_true(serr is None, "session start validate")
            sres = lib.apply_action(conn, sact)
            sid = sres["game_session_id"]
            assert_true(sid >= 1, "session id")

            # Score
            scact, scerr = lib.validate_action_payload({
                "action": "score",
                "user": "Nick1",
                "game": "attic",
                "score": 99,
                "game_session_id": sid,
            })
            assert_true(scerr is None, "score validate")
            scres = lib.apply_action(conn, scact)
            assert_true(scres["score_id"] >= 1, "score id")

            # End session (once)
            eact, eerr = lib.validate_action_payload({
                "action": "session_end",
                "user": "Nick1",
                "game_session_id": sid,
                "end_reason": "pagehide",
            })
            assert_true(eerr is None, "end validate")
            eres = lib.apply_action(conn, eact)
            assert_true(eres["updated"] is True, "end updated")

            # Second end must not overwrite
            row = conn.execute(
                "SELECT ended_at, end_reason FROM game_sessions WHERE game_session_id = ?",
                (sid,),
            ).fetchone()
            first_end = row["ended_at"]
            eres2 = lib.apply_action(conn, {
                "action": "session_end",
                "game_session_id": sid,
                "end_reason": "hidden",
                "user_id": "Nick1",
            })
            assert_true(eres2["updated"] is False, "no second end")
            row2 = conn.execute(
                "SELECT ended_at, end_reason FROM game_sessions WHERE game_session_id = ?",
                (sid,),
            ).fetchone()
            assert_true(row2["ended_at"] == first_end, "ended_at unchanged")
            assert_true(row2["end_reason"] == "pagehide", "reason unchanged")

            # SQLi user rejected
            bad2, berr2 = lib.validate_action_payload({
                "user": "x' OR '1'='1",
                "action": "visit",
            })
            assert_true(bad2 is None and berr2 == "need user", "reject sqli user")

            # Query views
            f_vis, _ = lib.parse_query_filters({"view": ["visits"], "user": ["Nick1"], "limit": ["10"]})
            vis = lib.query_view(conn, f_vis)
            assert_true(len(vis) == 2, "visits view")
            assert_true(vis[0]["user_id"] == "Nick1", "visit user")

            f_ses, _ = lib.parse_query_filters({"view": ["sessions"], "game": ["attic"]})
            ses = lib.query_view(conn, f_ses)
            assert_true(len(ses) == 1, "sessions view")
            assert_true(ses[0]["game_name"] == "attic", "session game")
            assert_true(ses[0]["duration_seconds"] is not None, "duration")
            assert_true(ses[0]["duration_seconds"] >= 0, "duration >=0")

            f_sc, _ = lib.parse_query_filters({"view": ["scores"], "user": ["Nick1"]})
            scores = lib.query_view(conn, f_sc)
            assert_true(len(scores) == 1 and scores[0]["score_value"] == 99, "scores view")

            f_u, _ = lib.parse_query_filters({"view": ["users"]})
            ulist = lib.query_view(conn, f_u)
            assert_true(len(ulist) == 1, "users view")

            _, e2 = lib.parse_query_filters({"user": ["a; DROP TABLE visits;--"]})
            assert_true(e2 == "bad user", "query filter reject")
        finally:
            conn.close()


def test_fk_enforced():
    with tempfile.TemporaryDirectory() as td:
        app = os.path.join(td, "App_Data")
        os.makedirs(app)
        path = os.path.join(app, lib.DB_FILENAME)
        conn = lib.ensure_db(path)
        try:
            try:
                lib.insert_visit(conn, "ghost", "1.1.1.1", None, None)
                # upsert creates user, so visit ok — use bad visit_id on session
            except Exception as e:
                raise AssertionError("visit should upsert: " + str(e))
            raised = False
            try:
                lib.insert_session(conn, "ghost", "attic", visit_id=99999)
            except ValueError:
                raised = True
            assert_true(raised, "bad visit_id rejected")

            sid = lib.insert_session(conn, "ghost", "farm", visit_id=None)
            raised2 = False
            try:
                lib.insert_score(conn, "other", "farm", 1, sid)
            except ValueError:
                raised2 = True
            assert_true(raised2, "score user mismatch")
        finally:
            conn.close()


def test_sqli_cannot_break_query():
    with tempfile.TemporaryDirectory() as td:
        app = os.path.join(td, "App_Data")
        os.makedirs(app)
        path = os.path.join(app, lib.DB_FILENAME)
        conn = lib.ensure_db(path)
        try:
            lib.insert_visit(conn, "legit_user", "127.0.0.1", "ua", None)
            rows = lib.query_view(conn, {
                "view": "visits",
                "user_id": "legit_user' OR '1'='1",
                "limit": 10,
            })
            assert_true(len(rows) == 0, "bound param not injectable")
            all_v = lib.query_view(conn, {"view": "visits", "limit": 10})
            assert_true(len(all_v) == 1, "table intact")
        finally:
            conn.close()


def _run_cgi(mod, env, body=b""):
    old_env = os.environ.copy()
    old_stdin = sys.stdin
    old_out = sys.stdout

    class FakeStdin:
        def __init__(self, data):
            self.buffer = io.BytesIO(data)

        def read(self, n=-1):
            return self.buffer.read(n).decode("utf-8")

    class Out:
        def __init__(self):
            self._b = io.BytesIO()
            self.buffer = self._b

        def write(self, s):
            if isinstance(s, bytes):
                self._b.write(s)
            else:
                self._b.write(s.encode("utf-8"))

        def flush(self):
            pass

        def getvalue(self):
            return self._b.getvalue()

    try:
        os.environ.clear()
        os.environ.update(env)
        sys.stdin = FakeStdin(body)
        out = Out()
        sys.stdout = out
        mod.main()
        raw = out.getvalue()
        if b"\r\n\r\n" in raw:
            head, body_out = raw.split(b"\r\n\r\n", 1)
        else:
            head, body_out = raw, b""
        return head.decode("utf-8", errors="replace"), body_out
    finally:
        os.environ.clear()
        os.environ.update(old_env)
        sys.stdin = old_stdin
        sys.stdout = old_out


def test_cgi_post_and_query():
    with tempfile.TemporaryDirectory() as td:
        app = os.path.join(td, "App_Data")
        os.makedirs(app)
        real_db_path = lib.db_path
        real_read_key = lib.read_query_key
        lib.db_path = lambda here=None: os.path.join(td, "App_Data", lib.DB_FILENAME)
        lib.read_query_key = lambda here=None: None
        try:
            payload = json.dumps({
                "action": "visit",
                "user": "TestUser1",
            }).encode("utf-8")
            head, body = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(payload)),
                "REMOTE_ADDR": "203.0.113.50",
                "HTTP_USER_AGENT": "CGI-Test",
            }, payload)
            assert_true("Status: 200" in head, "post 200: " + head[:80])
            data = json.loads(body.decode("utf-8"))
            assert_true(data.get("ok") is True, "post ok")
            assert_true(data.get("visit_id") >= 1, "visit_id returned")
            visit_id = data["visit_id"]

            # session_start
            payload2 = json.dumps({
                "action": "session_start",
                "user": "TestUser1",
                "game": "attic",
                "visit_id": visit_id,
            }).encode("utf-8")
            head_s, body_s = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(payload2)),
                "REMOTE_ADDR": "203.0.113.50",
            }, payload2)
            assert_true("Status: 200" in head_s, "session 200")
            sid = json.loads(body_s.decode("utf-8"))["game_session_id"]

            # score
            payload3 = json.dumps({
                "action": "score",
                "user": "TestUser1",
                "game": "attic",
                "score": 42,
                "game_session_id": sid,
            }).encode("utf-8")
            head_sc, body_sc = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(payload3)),
            }, payload3)
            assert_true("Status: 200" in head_sc, "score 200")
            assert_true(b'"score_id"' in body_sc, "score_id")

            # Reject non-json
            head2, _ = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "text/plain",
                "CONTENT_LENGTH": str(len(payload)),
            }, payload)
            assert_true("Status: 415" in head2, "reject ctype")

            # Oversized
            big = b'{"action":"visit","user":"A"}' + b" " * (lib.MAX_BODY + 10)
            head3, _ = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(big)),
            }, big)
            assert_true("Status: 413" in head3, "too large")

            # Reject client IP in body
            bad_ip = json.dumps({
                "action": "visit",
                "user": "TestUser1",
                "ip_address": "8.8.8.8",
            }).encode("utf-8")
            head_ip, body_ip = _run_cgi(cgi_post, {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(bad_ip)),
                "REMOTE_ADDR": "203.0.113.50",
            }, bad_ip)
            assert_true("Status: 400" in head_ip, "reject body ip")

            # Query visits — who visited when
            qs = urlencode({"view": "visits", "user": "TestUser1", "limit": "5"})
            head4, body4 = _run_cgi(cgi_query, {
                "REQUEST_METHOD": "GET",
                "QUERY_STRING": qs,
            })
            assert_true("Status: 200" in head4, "query 200")
            qdata = json.loads(body4.decode("utf-8"))
            assert_true(qdata.get("ok") is True, "query ok")
            assert_true(qdata.get("view") == "visits", "view")
            assert_true(qdata.get("count") >= 1, "visit count")
            assert_true(qdata["rows"][0]["ip_address"] == "203.0.113.50", "stored server ip")

            # sessions — who played what + duration
            qs2 = urlencode({"view": "sessions", "game": "attic"})
            _, body5 = _run_cgi(cgi_query, {
                "REQUEST_METHOD": "GET",
                "QUERY_STRING": qs2,
            })
            sdata = json.loads(body5.decode("utf-8"))
            assert_true(sdata["count"] == 1, "session count")
            assert_true(sdata["rows"][0]["user_id"] == "TestUser1", "session user")

            # scores
            qs3 = urlencode({"view": "scores", "user": "TestUser1"})
            _, body6 = _run_cgi(cgi_query, {
                "REQUEST_METHOD": "GET",
                "QUERY_STRING": qs3,
            })
            scdata = json.loads(body6.decode("utf-8"))
            assert_true(scdata["rows"][0]["score_value"] == 42, "score value")

            # Query key required when configured
            key_path = os.path.join(td, "App_Data", "play_log_query_key.txt")
            with open(key_path, "w", encoding="utf-8") as f:
                f.write("secret-query-key-99")
            lib.read_query_key = lambda here=None: "secret-query-key-99"
            head5, _ = _run_cgi(cgi_query, {
                "REQUEST_METHOD": "GET",
                "QUERY_STRING": qs,
            })
            assert_true("Status: 401" in head5, "query auth")
            head6, _ = _run_cgi(cgi_query, {
                "REQUEST_METHOD": "GET",
                "QUERY_STRING": qs + "&key=secret-query-key-99",
            })
            assert_true("Status: 200" in head6, "query with key")
        finally:
            lib.db_path = real_db_path
            lib.read_query_key = real_read_key


def test_content_type_helper():
    assert_true(lib.content_type_is_json("application/json"), "json")
    assert_true(lib.content_type_is_json("application/json; charset=utf-8"), "charset")
    assert_true(not lib.content_type_is_json("text/plain"), "plain")
    assert_true(not lib.content_type_is_json(""), "empty")


def main():
    test_sanitize()
    test_schema_and_flow()
    test_fk_enforced()
    test_sqli_cannot_break_query()
    test_content_type_helper()
    test_cgi_post_and_query()
    print("play-log-unit: ok")


if __name__ == "__main__":
    main()
