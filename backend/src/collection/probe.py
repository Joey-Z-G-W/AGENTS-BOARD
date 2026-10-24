import datetime
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_RECORD = 2 * 1024 * 1024
LIMIT = 15


def clean(value):
    if not isinstance(value, str):
        return None
    value = re.sub(r"(?i)(bearer\s+)[a-z0-9._~-]+", r"\1[REDACTED]", value)
    value = re.sub(r"(?i)((?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]", value)
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[REDACTED PRIVATE KEY]", value)
    return value[:12000]


def iso(value):
    try:
        if isinstance(value, (float, int)):
            if value > 100000000000:
                value /= 1000
            return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        if isinstance(value, str):
            result = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if result.tzinfo is not None:
                return result.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        pass
    return None


def base(source, native_id, observed):
    return {
        "nativeId": native_id, "workspaceHost": None, "commonDir": None,
        "turnId": None, "turnIdentityKind": "unavailable", "source": source,
        "title": "未命名会话", "status": "unknown", "freshness": "fresh",
        "activityAt": None, "startedAt": None, "completedAt": None,
        "durationSeconds": None, "directory": None, "branch": None, "worktree": None,
        "prompt": None, "response": None, "reason": "单次采集不能确认当前执行状态。",
        "evidence": {"level": "observed", "basis": "unsupported", "observedAt": observed, "sourceVersion": None, "reason": "真实只读快照，未验证实时生命周期。"},
        "capabilities": dict.fromkeys(["latestTurn", "waiting", "finalResponse", "nativeRead", "exactCompletionTime"], "unavailable"),
    }


def codex_record(path, meta, observed):
    session = base("codex_cli", str(meta.get("id") or path.stem), observed)
    session["directory"] = meta.get("cwd")
    session["evidence"]["sourceVersion"] = meta.get("cli_version")
    try:
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                if len(line) > MAX_RECORD:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get("type") != "event_msg":
                    continue
                event = record.get("payload") or {}
                kind = event.get("type")
                if kind == "task_started" and event.get("turn_id"):
                    session.update(turnId=event["turn_id"], turnIdentityKind="native", status="unknown",
                                   prompt=None, response=None, completedAt=None, durationSeconds=None,
                                   startedAt=iso(event.get("started_at")) or iso(record.get("timestamp")),
                                   activityAt=iso(record.get("timestamp")), reason="找到任务开始记录，但单次快照不能确认仍在运行。")
                    session["capabilities"]["latestTurn"] = "candidate"
                elif kind == "user_message" and session["turnId"]:
                    session["prompt"] = clean(event.get("message"))
                    session["activityAt"] = iso(record.get("timestamp")) or session["activityAt"]
                elif kind in ("task_complete", "turn_aborted") and session["turnId"] and event.get("turn_id") == session["turnId"]:
                    session["activityAt"] = iso(record.get("timestamp")) or session["activityAt"]
                    session["evidence"]["basis"] = "native_task_event"
                    if kind == "task_complete":
                        session["status"] = "read"
                        session["response"] = clean(event.get("last_agent_message"))
                        session["completedAt"] = iso(event.get("completed_at")) or iso(record.get("timestamp"))
                        duration = event.get("duration_ms")
                        session["durationSeconds"] = duration / 1000 if isinstance(duration, (int, float)) and duration >= 0 else None
                        session["reason"] = "最新轮有明确完成事件；首次历史导入为已读。"
                        session["capabilities"]["finalResponse"] = "candidate"
                        session["capabilities"]["exactCompletionTime"] = "candidate"
                    else:
                        session.update(status="unknown", response=None, completedAt=None, durationSeconds=None,
                                       reason="最新轮明确中断；不能将上一轮完成状态当作本轮结果。")
        if session["prompt"]:
            session["title"] = session["prompt"].splitlines()[0][:120] or "CLI 会话"
        else:
            session["title"] = "Codex CLI 历史会话"
        return session
    except OSError:
        return None


def open_db(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    return connection


def value_json(connection, key):
    row = connection.execute("SELECT value FROM cursorDiskKV WHERE key=? AND length(value)<=?", (key, MAX_RECORD)).fetchone()
    if row:
        try:
            return json.loads(row[0])
        except (ValueError, TypeError):
            pass
    return {}


def workspace_details(workspace, folder):
    try:
        record = json.loads((folder / str(workspace) / "workspace.json").read_text(encoding="utf-8"))
        uri = record.get("folder", "")
        parsed = urlparse(uri)
        if parsed.scheme == "file":
            path = unquote(parsed.path)
            if os.name == "nt" and re.match(r"^/[A-Za-z]:", path):
                path = path[1:]
            return path, None
        if parsed.scheme == "vscode-remote":
            authority = unquote(parsed.netloc)
            if authority.startswith("ssh-remote+"):
                alias = authority[len("ssh-remote+"):]
                try:
                    decoded = json.loads(bytes.fromhex(alias))
                    alias = decoded.get("hostName")
                except (ValueError, TypeError):
                    pass
                return unquote(parsed.path), alias
    except (OSError, ValueError, TypeError):
        pass
    return None, None


def cursor_ide(path, observed):
    connection = open_db(path)
    sessions = []
    try:
        rows = connection.execute("SELECT composerId,workspaceId FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT ?", (LIMIT,)).fetchall()
        total = connection.execute("SELECT count(*) FROM composerHeaders").fetchone()[0]
        for native_id, workspace in rows:
            composer = value_json(connection, "composerData:" + native_id)
            headers = composer.get("fullConversationHeadersOnly") or []
            if not headers:
                continue
            session = base("cursor_ide", native_id, observed)
            session["title"] = clean(composer.get("name")) or "Cursor IDE 会话"
            session["directory"], session["workspaceHost"] = workspace_details(workspace, path.parent.parent / "workspaceStorage")
            session["reason"] = "真实 IDE 历史；原生 status=" + str(composer.get("status", "unknown"))[:40] + "，生命周期与最终回复语义未验证，保留未知。"
            session["evidence"]["basis"] = "composer_status"
            for header in reversed(headers[-100:]):
                if header.get("type") != 1 or not header.get("bubbleId"):
                    continue
                bubble_id = str(header["bubbleId"])
                bubble = value_json(connection, "bubbleId:" + native_id + ":" + bubble_id)
                text = clean(bubble.get("text"))
                session["turnId"] = bubble_id
                session["turnIdentityKind"] = "derived"
                session["prompt"] = text
                session["capabilities"]["latestTurn"] = "candidate"
                break
            sessions.append(session)
        return sessions, total
    finally:
        connection.rollback()
        connection.close()


def cursor_cli(path, observed):
    session = base("cursor_cli", path.parent.name, observed)
    try:
        metadata = json.loads((path.parent / "meta.json").read_text(encoding="utf-8"))
        session["directory"] = metadata.get("cwd")
    except (OSError, ValueError):
        pass
    connection = open_db(path)
    try:
        row = connection.execute("SELECT value FROM meta WHERE key='0' AND length(value)<=?", (MAX_RECORD,)).fetchone()
        if row:
            value = row[0]
            if isinstance(value, bytes):
                value = value.decode("utf-8")
            try:
                metadata = json.loads(bytes.fromhex(value))
                session["title"] = clean(metadata.get("name")) or "Cursor CLI 会话"
            except (ValueError, TypeError):
                pass
        session["reason"] = "真实 Cursor CLI 存储已发现；latestRootBlobId 图顺序未解析，不能可靠提取最新轮、最终回复或执行状态。"
        return session
    finally:
        connection.rollback()
        connection.close()


def git_details(directory):
    if not directory or not Path(directory).is_dir():
        return None, None, None
    def git(*arguments):
        result = subprocess.run(["git", "-C", directory, *arguments], capture_output=True, text=True, timeout=2,
                                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"})
        return result.stdout.strip() if result.returncode == 0 else None
    try:
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
        root = git("rev-parse", "--show-toplevel") if common else None
        branch = git("symbolic-ref", "--short", "-q", "HEAD") if common else None
        return common, root, branch
    except (OSError, subprocess.TimeoutExpired):
        return None, None, None


def collect(home=None):
    home = home or Path.home()
    observed = iso(datetime.datetime.now(datetime.timezone.utc).isoformat())
    sessions = []
    diagnostics = {"codexFiles": 0, "codexEligible": 0, "codexExcluded": 0, "cursorIdeHeaders": 0, "cursorCliStores": 0, "errors": 0, "oversizedSkipped": 0}
    paths = sorted((home / ".codex/sessions").rglob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)[:2000]
    eligible = 0
    for path in paths:
        diagnostics["codexFiles"] += 1
        try:
            with path.open("r", encoding="utf-8") as stream:
                metadata = json.loads(stream.readline(MAX_RECORD)).get("payload") or {}
            if metadata.get("source") not in ("cli", "exec"):
                diagnostics["codexExcluded"] += 1
                continue
            diagnostics["codexEligible"] += 1
            if eligible >= LIMIT:
                continue
            if path.stat().st_size > 32 * 1024 * 1024:
                diagnostics["oversizedSkipped"] += 1
                continue
            result = codex_record(path, metadata, observed)
            if result:
                sessions.append(result)
                eligible += 1
        except (OSError, ValueError):
            diagnostics["errors"] += 1
    ide_roots = [home / ".config/Cursor/User/globalStorage/state.vscdb"]
    if os.name == "nt" and os.environ.get("APPDATA"):
        ide_roots.insert(0, Path(os.environ["APPDATA"]) / "Cursor/User/globalStorage/state.vscdb")
    for path in ide_roots:
        if not path.is_file():
            continue
        try:
            records, total = cursor_ide(path, observed)
            sessions.extend(records)
            diagnostics["cursorIdeHeaders"] += total
        except (OSError, sqlite3.Error, ValueError, TypeError):
            diagnostics["errors"] += 1
    for path in list((home / ".cursor/chats").glob("*/*/store.db"))[:LIMIT]:
        diagnostics["cursorCliStores"] += 1
        try:
            sessions.append(cursor_cli(path, observed))
        except (OSError, sqlite3.Error, ValueError, TypeError):
            diagnostics["errors"] += 1
    cache = {}
    for session in sessions:
        directory = session["directory"]
        if session["workspaceHost"] is None and directory:
            if directory not in cache:
                cache[directory] = git_details(directory) if len(cache) < 20 else (None, None, None)
            session["commonDir"], session["worktree"], session["branch"] = cache[directory]
    return {"observedAt": observed, "sessions": sessions, "diagnostics": diagnostics}


if __name__ == "__main__":
    print(json.dumps(collect(), ensure_ascii=True))
