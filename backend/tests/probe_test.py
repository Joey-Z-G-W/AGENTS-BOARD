import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("probe", Path(__file__).parent.parent / "src/collection/probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_latest_turn_does_not_reuse_previous_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            events = [
                {"type": "task_started", "turn_id": "old"},
                {"type": "user_message", "message": "old prompt"},
                {"type": "task_complete", "turn_id": "old", "last_agent_message": "old final", "duration_ms": 1000},
                {"type": "task_started", "turn_id": "new"},
                {"type": "user_message", "message": "new prompt"},
                {"type": "task_complete", "turn_id": "old", "last_agent_message": "late old final"},
                {"type": "turn_aborted", "turn_id": "new"},
            ]
            path.write_text("\n".join(json.dumps({"type": "event_msg", "timestamp": "2026-10-24T00:00:00Z", "payload": event}) for event in events) + "\n{", encoding="utf-8")
            result = probe.codex_record(path, {"id": "example", "source": "cli"}, "2026-10-24T00:00:00Z")
            self.assertEqual(result["turnId"], "new")
            self.assertEqual(result["prompt"], "new prompt")
            self.assertEqual(result["status"], "unknown")
            self.assertIsNone(result["response"])
            self.assertIsNone(result["completedAt"])

    def test_completed_history_is_read_not_unread(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            records = [
                {"type": "task_started", "turn_id": "one"},
                {"type": "task_complete", "turn_id": "one", "last_agent_message": "final", "duration_ms": 1250},
            ]
            path.write_text("\n".join(json.dumps({"type": "event_msg", "timestamp": "2026-10-24T00:00:00Z", "payload": event}) for event in records), encoding="utf-8")
            result = probe.codex_record(path, {"id": "example"}, "2026-10-24T00:00:00Z")
            self.assertEqual(result["status"], "read")
            self.assertEqual(result["durationSeconds"], 1.25)
            self.assertEqual(result["response"], "final")

    def test_cursor_reads_user_bubble_without_publishing_intermediate_assistant(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.vscdb"
            connection = sqlite3.connect(path)
            connection.executescript("CREATE TABLE composerHeaders(composerId TEXT,workspaceId TEXT,lastUpdatedAt INTEGER); CREATE TABLE cursorDiskKV(key TEXT,value TEXT);")
            connection.execute("INSERT INTO composerHeaders VALUES('composer','workspace',1)")
            composer = {"name": "Fixture", "status": "completed", "fullConversationHeadersOnly": [{"type": 1, "bubbleId": "user"}, {"type": 2, "bubbleId": "assistant"}]}
            connection.executemany("INSERT INTO cursorDiskKV VALUES(?,?)", [
                ("composerData:composer", json.dumps(composer)),
                ("bubbleId:composer:user", json.dumps({"text": "hello"})),
                ("bubbleId:composer:assistant", json.dumps({"text": "intermediate tool content"})),
            ])
            connection.commit()
            connection.close()
            before = path.read_bytes()
            sessions, total = probe.cursor_ide(path, "2026-10-24T00:00:00Z")
            self.assertEqual(total, 1)
            self.assertEqual(sessions[0]["prompt"], "hello")
            self.assertIsNone(sessions[0]["response"])
            self.assertEqual(sessions[0]["status"], "unknown")
            self.assertEqual(path.read_bytes(), before)

    def test_common_credentials_redacted(self):
        self.assertNotIn("actual-secret", probe.clean("password=actual-secret"))
        self.assertNotIn("private-token", probe.clean("Bearer private-token"))
        self.assertIsNone(probe.iso("not-a-date"))


if __name__ == "__main__":
    unittest.main()
