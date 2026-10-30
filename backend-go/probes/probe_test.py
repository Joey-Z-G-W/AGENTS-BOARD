"""Synthetic fixtures only; never inspect Path.home() or native Agent data."""
import json
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

scope = {"__name__": "fixture_probe"}
for name in ("legacy.py", "continuous.py"):
    exec(compile((Path(__file__).parent / name).read_text(encoding="utf-8"), name, "exec"), scope)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        environment = patch.dict(os.environ, {"CODEX_HOME": str(Path(self.temp.name) / ".codex"), "APPDATA": str(Path(self.temp.name) / "appdata")})
        environment.start()
        self.addCleanup(environment.stop)
        self.path = Path(self.temp.name) / "rollout.jsonl"
        self.rows = [{"type": "session_meta", "payload": {"id": "fixture", "source": "cli", "cwd": "/synthetic"}},
                     {"type": "event_msg", "timestamp": "2026-10-24T01:00:00Z", "payload": {"type": "task_started", "turn_id": "turn-1"}},
                     {"type": "event_msg", "timestamp": "2026-10-24T01:00:01Z", "payload": {"type": "user_message", "message": "synthetic request"}}]
        self.write(self.rows)

    def write(self, rows):
        self.path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in rows))

    def test_incremental_completion_and_new_turn_reset(self):
        read = scope["read_codex"]
        session, cursor, partial = read(self.path, None)
        self.assertFalse(partial)
        self.assertEqual(session["status"], "unknown")
        self.assertEqual(session["prompt"], "synthetic request")
        completion = {"type": "event_msg", "timestamp": "2026-10-24T01:02:00Z", "payload": {"type": "task_complete", "turn_id": "turn-1", "last_agent_message": "synthetic result"}}
        with self.path.open("ab") as stream:
            stream.write(json.dumps(completion).encode() + b"\n")
        session, cursor, partial = read(self.path, cursor)
        self.assertEqual(session["status"], "unread")
        with self.path.open("ab") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-2"}}).encode() + b"\n")
        session, cursor, partial = read(self.path, cursor)
        self.assertIsNone(session["response"])
        self.assertEqual(session["capabilities"]["finalResponse"], "unavailable")

    def test_partial_line_never_published_and_resumes(self):
        session, cursor, _ = scope["read_codex"](self.path, None)
        offset = cursor["offset"]
        with self.path.open("ab") as stream:
            stream.write(b'{"type":"event_msg","payload":')
        session, pending, partial = scope["read_codex"](self.path, cursor)
        self.assertIsNone(session)
        self.assertTrue(partial)
        self.assertEqual(pending["offset"], offset)
        with self.path.open("ab") as stream:
            stream.write(b'{"type":"turn_aborted","turn_id":"turn-1"}}\n')
        session, _, partial = scope["read_codex"](self.path, pending)
        self.assertFalse(partial)
        self.assertEqual(session["status"], "unknown")

    def test_truncate_resets_cursor(self):
        _, cursor, _ = scope["read_codex"](self.path, None)
        self.write(self.rows[:1])
        session, _, partial = scope["read_codex"](self.path, cursor)
        self.assertIsNone(session["turnId"])
        self.assertFalse(partial)

    def test_wrong_turn_completion_ignored(self):
        rows = self.rows + [{"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "wrong", "last_agent_message": "old"}}]
        self.write(rows)
        session, _, _ = scope["read_codex"](self.path, None)
        self.assertEqual(session["status"], "unknown")
        self.assertIsNone(session["response"])
        self.assertEqual(session["activityAt"], "2026-10-24T01:00:01Z")

    def test_same_inode_rewrite_resets_even_when_size_does_not_shrink(self):
        _, cursor, _ = scope["read_codex"](self.path, None)
        changed = json.loads(json.dumps(self.rows))
        changed[1]["payload"]["turn_id"] = "turn-2"
        changed[2]["payload"]["message"] = "a longer replacement request"
        self.write(changed)
        session, _, partial = scope["read_codex"](self.path, cursor)
        self.assertFalse(partial)
        self.assertEqual(session["turnId"], "turn-2")
        self.assertEqual(session["prompt"], "a longer replacement request")

    def test_bad_ide_row_does_not_block_following_sessions(self):
        path = Path(self.temp.name) / "state.vscdb"
        connection = sqlite3.connect(path)
        connection.executescript("CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);")
        connection.executemany("INSERT INTO composerHeaders VALUES (?,?)", [("bad", "workspace"), ("good", "workspace")])
        connection.execute("INSERT INTO cursorDiskKV VALUES (?,?)", ("composerData:good", json.dumps({"name": "synthetic", "fullConversationHeadersOnly": [{"type": 1, "bubbleId": "prompt"}]})))
        connection.execute("INSERT INTO cursorDiskKV VALUES (?,?)", ("bubbleId:good:prompt", json.dumps({"text": "synthetic request"})))
        connection.commit()
        connection.close()
        records, after, failures = scope["read_ide"](path)
        self.assertEqual(failures, 1)
        self.assertEqual([row["session"]["nativeId"] for row in records], ["good"])
        self.assertEqual(records[0]["session"]["prompt"], "synthetic request")
        self.assertEqual(records[0]["session"]["status"], "unknown")
        with self.assertRaises(ValueError):
            scope["read_ide"](path, "bad")

    def test_budget_and_invalid_record_fail_closed(self):
        with self.path.open("ab") as stream:
            stream.write(b"x" * (scope["MAX_RECORD"] + 1) + b"\n")
        session, cursor, partial = scope["read_codex"](self.path, None)
        self.assertFalse(partial)
        self.assertEqual(cursor["oversizedRecords"], 1)
        self.assertEqual(session["status"], "unknown")
        self.assertIsNone(session["turnId"])
        self.write(self.rows + [[]])
        with self.assertRaises(ValueError):
            scope["read_codex"](self.path, None)

    def test_large_record_advances_across_budgets_without_false_completion(self):
        with self.path.open("ab") as stream:
            stream.write(b'x' * (9 * 1024 * 1024))
        previous = None
        for _ in range(4):
            session, cursor, partial = scope["read_codex"](self.path, previous)
            self.assertIsNone(session)  # No newline: still catching up.
            self.assertTrue(partial)
            if previous:
                self.assertLessEqual(cursor["offset"] - previous["offset"], scope["READ_BUDGET"])
            previous = cursor
        self.assertTrue(cursor["discarding"])
        with self.path.open("ab") as stream:
            stream.write(b'\n' + json.dumps({"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "last_agent_message": "must not attach"}}).encode() + b'\n')
        session, cursor, partial = scope["read_codex"](self.path, cursor)
        self.assertFalse(partial)
        self.assertEqual(session["status"], "unknown")
        self.assertIsNone(session["response"])
        self.assertIsNone(session["activityAt"])
        self.assertEqual(cursor["oversizedRecords"], 1)
        with self.path.open("ab") as stream:
            for row in [
                {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "new"}},
                {"type": "event_msg", "timestamp": "2026-10-24T02:00:00Z", "payload": {"type": "task_complete", "turn_id": "new", "last_agent_message": "new result"}},
            ]:
                stream.write(json.dumps(row).encode()+b'\n')
        session, _, _ = scope["read_codex"](self.path, cursor)
        self.assertEqual(session["status"], "unread")
        self.assertEqual(session["response"], "new result")

    def test_desktop_prompt_keeps_source_and_ignores_injected_messages(self):
        self.rows[0]["payload"].update(source="vscode", originator="Codex Desktop")
        self.rows = self.rows[:2]
        def message(kinds, turn, text):
            return {"type": "response_item", "payload": {"type": "message", "role": "user", "internal_chat_message_metadata_passthrough": {"content_item_kinds": kinds, "turn_id": turn}, "content": [{"type": "input_text", "text": text}]}}
        self.write(self.rows + [message(["user.text"], "turn-1", "real request"),
                                message(["user.text"], "other-turn", "wrong turn"),
                                message(["additional_content.environment_context"], "turn-1", "injected context"),
                                message(["user.text", "additional_content.agents_md"], "turn-1", "unverified mixture")])
        session, _, _ = scope["read_codex"](self.path, None)
        self.assertEqual(session["source"], "codex_desktop")
        self.assertEqual(session["prompt"], "real request")
        self.assertIsNone(scope["codex_source"]({"source": "vscode", "originator": "other client"}))
        self.assertIsNone(scope["codex_source"]({"source": {"subagent": {}}, "originator": "Codex Desktop"}))

    def test_custom_home_archives_and_desktop_directed_refresh(self):
        root = Path(self.temp.name)
        archive = root / "custom/archived_sessions"
        archive.mkdir(parents=True)
        self.rows[0]["payload"].update(source="vscode", originator="Codex Desktop")
        (archive / "fixture.jsonl").write_text(''.join(json.dumps(row)+'\n' for row in self.rows), encoding="utf-8")
        with patch.object(scope["Path"], "home", return_value=root / "empty"), patch.dict(os.environ, {"CODEX_HOME": str(root / "custom"), "APPDATA": str(root / "empty")}), patch.dict(scope, {"enrich_git": lambda *_: None}):
            result = scope["run_request"]({"version": 1})
            self.assertEqual(len(result["records"]), 1)
            locator = result["records"][0]["locator"]
            self.assertEqual(locator["source"], "codex_desktop")
            refreshed = scope["run_request"]({"version": 1, "state": result["state"], "target": locator})
            self.assertEqual(refreshed["records"][0]["session"]["source"], "codex_desktop")

    def test_discovery_pages_preserve_pending(self):
        root = Path(self.temp.name) / "discovery"
        root.mkdir()
        for i in range(30):
            (root / (str(i) + ".jsonl")).write_text("fixture")
        found, pending = scope["discover_page"](root, None, ".jsonl", budget=5)
        all_paths = set(found)
        while pending:
            found, pending = scope["discover_page"](root, pending, ".jsonl", budget=5)
            all_paths.update(found)
        self.assertEqual(len(all_paths), 30)

    def test_git_lookup_is_bounded_cached_and_skips_remote_workspace(self):
        records = [{"session": {"directory": "/synthetic/one", "workspaceHost": None}},
                   {"session": {"directory": "/synthetic/two", "workspaceHost": None}},
                   {"session": {"directory": "/remote", "workspaceHost": "other"}}]
        state = {}
        calls = []
        def lookup(directory):
            calls.append(directory)
            return "/synthetic/repository/.git", directory, "fixture-branch"
        with patch.dict(scope, {"git_details": lookup}):
            scope["enrich_git"](records, state)
            self.assertEqual(calls, ["/synthetic/one"])
            scope["enrich_git"](records, state)
            self.assertEqual(calls, ["/synthetic/one", "/synthetic/two"])
        self.assertEqual(records[0]["session"]["commonDir"], records[1]["session"]["commonDir"])
        self.assertNotIn("commonDir", records[2]["session"])

    def test_excluded_desktop_headers_do_not_consume_cli_read_quota(self):
        home=Path(self.temp.name)
        folder=home / ".codex" / "sessions"
        folder.mkdir(parents=True)
        for index in range(110):
            (folder / ("z%03d.jsonl" % index)).write_text(json.dumps({"type":"session_meta","payload":{"id":str(index),"source":"desktop"}})+"\n")
        (folder / "a-cli.jsonl").write_bytes(self.path.read_bytes())
        state=None
        seen=[]
        with patch.object(Path,"home",return_value=home), patch.dict(os.environ,{"APPDATA":str(home)}), patch.dict(scope,{"git_details":lambda directory:(None,None,None)}):
            for _ in range(3):
                result=scope["run_request"]({"version":1,"state":state})
                state=result["state"]
                seen.extend(row["session"]["nativeId"] for row in result["records"])
        self.assertIn("fixture",seen)


if __name__ == "__main__":
    unittest.main()
