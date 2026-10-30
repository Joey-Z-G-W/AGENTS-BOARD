"""Versioned, bounded read-only probe. State is returned, never persisted here.

The host commits the proposed state only after validating and storing the batch.
Unsupported native lifecycle signals remain unknown even after repeated reads.
"""
import copy
import itertools
import time

PROTOCOL = 1
PAGE = 24
READ_BUDGET = 4 * 1024 * 1024
MAX_TRACKED = 256

_legacy_clean = clean


def clean(value):
    result = _legacy_clean(value)
    return result[:1000] if result else result


def utc_now():
    return iso(datetime.datetime.now(datetime.timezone.utc).isoformat())


def bounded_json(path):
    with Path(path).open("rb") as stream:
        value = stream.read(MAX_RECORD + 1)
    if len(value) > MAX_RECORD:
        raise ValueError("metadata exceeds budget")
    return json.loads(value)


def reduce_codex(session, record):
    if not isinstance(record, dict):
        raise ValueError("invalid log record")
    payload = record.get("payload") or {}
    if not isinstance(payload, dict):
        return
    kind = payload.get("type")
    if record.get("type") == "turn_context" and session.get("_subagent"):
        # Inherited contexts and unproven turn identities cannot supply runtime facts.
        if session["turnId"] and payload.get("turn_id") == session["turnId"]:
            session["_model"] = clean(payload.get("model"))
            session["_effort"] = clean(payload.get("effort"))
            session["_modelObservedAt"] = iso(record.get("timestamp"))
        return
    if record.get("type") == "response_item" and kind == "message" and payload.get("role") == "user":
        metadata = payload.get("internal_chat_message_metadata_passthrough")
        if (isinstance(metadata, dict) and session["turnId"]
                and metadata.get("turn_id") == session["turnId"]
                and isinstance(metadata.get("content_item_kinds"), list)
                and metadata["content_item_kinds"]
                and all(kind == "user.text" for kind in metadata["content_item_kinds"])):
            content = payload.get("content")
            if isinstance(content, list):
                text = "\n".join(item["text"][:1000] for item in content[:128]
                                 if isinstance(item, dict) and item.get("type") == "input_text"
                                 and isinstance(item.get("text"), str))
                session["prompt"] = clean(text)
                session["activityAt"] = iso(record.get("timestamp")) or session["activityAt"]
        return
    if record.get("type") != "event_msg":
        return
    if kind == "task_started" and isinstance(payload.get("turn_id"), str):
        original = session
        session = base(original["source"], original["nativeId"], utc_now())
        session["directory"] = original["directory"]
        if original.get("_subagent"):
            session["_subagent"] = original["_subagent"]
        session["evidence"]["sourceVersion"] = original["evidence"]["sourceVersion"]
        session.update(turnId=payload["turn_id"], turnIdentityKind="native",
                       startedAt=iso(payload.get("started_at")) or iso(record.get("timestamp")),
                       activityAt=iso(record.get("timestamp")),
                       reason="已观察到开始事件，缺少当前存活证据，保持未知。")
        session["capabilities"]["latestTurn"] = "candidate"
        original.clear()
        original.update(session)
        return
    if not session["turnId"]:
        return
    # Explicit mismatches never attach messages or completion to another turn.
    if payload.get("turn_id") not in (None, session["turnId"]):
        return
    if kind == "user_message":
        session["prompt"] = clean(payload.get("message"))
        session["activityAt"] = iso(record.get("timestamp")) or session["activityAt"]
    elif kind in ("task_complete", "turn_aborted") and payload.get("turn_id") == session["turnId"]:
        session["activityAt"] = iso(record.get("timestamp")) or session["activityAt"]
        session["evidence"]["basis"] = "native_task_event"
        if kind == "task_complete":
            completed = iso(payload.get("completed_at")) or iso(record.get("timestamp"))
            session.update(status="unread" if completed else "unknown", completedAt=completed,
                           response=clean(payload.get("last_agent_message")),
                           reason="观察到匹配当前轮次的完成事件。" if completed else "完成事件缺少可靠时间。")
            duration = payload.get("duration_ms")
            session["durationSeconds"] = duration / 1000 if isinstance(duration, (float, int)) and 0 <= duration <= 1e12 else None
            session["capabilities"]["finalResponse"] = "candidate"
            session["capabilities"]["exactCompletionTime"] = "candidate"
        else:
            if session.get("_subagent"):
                session["_interrupted"] = True
            session.update(status="unknown", completedAt=None, response=None, durationSeconds=None,
                           reason="当前任务已中断，不视为成功完成。")
            session["capabilities"]["finalResponse"] = "unavailable"
            session["capabilities"]["exactCompletionTime"] = "unavailable"


def read_codex(path, previous, include_subagents=False):
    """Consume complete records only. Partial/oversize input never becomes fresh."""
    path = Path(path)
    info = path.stat()
    identity = [info.st_dev, info.st_ino, getattr(info, "st_birthtime_ns", 0)]
    with path.open("rb") as stream:
        first = stream.readline(MAX_RECORD + 1)
        if len(first) > MAX_RECORD or not first.endswith(b"\n"):
            raise ValueError("invalid metadata record")
        metadata_record = json.loads(first)
        if not isinstance(metadata_record, dict):
            raise ValueError("invalid metadata")
        metadata = metadata_record.get("payload") or {}
        if not isinstance(metadata, dict):
            raise ValueError("invalid metadata payload")
        child = subagent_metadata(metadata) if include_subagents else None
        source = "codex_subagent" if child else codex_source(metadata)
        if metadata_record.get("type") != "session_meta" or source is None:
            return None, None, False
        if not isinstance(metadata.get("id"), str):
            raise ValueError("missing native identity")
        prefix_hash = hashlib.sha256(first).hexdigest()
        # Detect truncate-and-regrow on the same inode, including unchanged metadata.
        previous_anchor = None
        if previous and 0 <= previous.get("offset", -1) <= info.st_size:
            stream.seek(max(0, previous["offset"] - 512))
            previous_anchor = hashlib.sha256(stream.read(min(512, previous["offset"]))).hexdigest()
        if (not previous or previous.get("identity") != identity or previous.get("prefix") != prefix_hash
                or previous.get("anchor") != previous_anchor
                or previous.get("offset", 0) > info.st_size):
            cached_child = previous.get("publishedSubagent") if previous else None
            session = base(source, metadata["id"], utc_now())
            if child:
                session["_subagent"] = child
            session["directory"] = metadata.get("cwd") if isinstance(metadata.get("cwd"), str) else None
            session["evidence"]["sourceVersion"] = metadata.get("cli_version")
            previous = {"identity": identity, "prefix": prefix_hash, "offset": len(first), "session": session}
            if child and cached_child and cached_child["nativeId"] == metadata["id"] and cached_child["parentThreadId"] == child["parentThreadId"]:
                previous["publishedSubagent"] = cached_child
        next_state = copy.deepcopy(previous)
        next_state["modified"] = info.st_mtime_ns
        stream.seek(previous["offset"])
        consumed = 0
        complete = False
        while consumed < READ_BUDGET:
            start = stream.tell()
            if next_state.get("discarding"):
                # Resume an oversized line without allocating it or rereading it.
                chunk = stream.readline(min(65536, READ_BUDGET - consumed))
                if not chunk:
                    break
                consumed += len(chunk)
                next_state["offset"] = stream.tell()
                if chunk.endswith(b"\n"):
                    next_state["discarding"] = False
                continue
            line = stream.readline(min(MAX_RECORD + 1, READ_BUDGET - consumed + 1))
            if not line:
                complete = True
                break
            if consumed + len(line) > READ_BUDGET:
                stream.seek(start)
                break
            if len(line) > MAX_RECORD:
                consumed += len(line)
                next_state["offset"] = stream.tell()
                next_state["discarding"] = not line.endswith(b"\n")
                next_state["oversizedRecords"] = next_state.get("oversizedRecords", 0) + 1
                # A skipped line could contain a new turn. Never attach a later
                # completion to the old turn until a complete start is observed.
                damaged = next_state["session"]
                damaged.update(status="unknown", turnId=None, turnIdentityKind="unavailable",
                               activityAt=None, startedAt=None, completedAt=None, response=None, prompt=None, durationSeconds=None,
                               reason="存在超大记录，已跳过载荷；轮次状态需等待后续完整开始事件确认。")
                for key in ("_model", "_effort", "_modelObservedAt", "_interrupted"):
                    damaged.pop(key, None)
                damaged["evidence"]["basis"] = "unsupported"
                damaged["capabilities"] = dict.fromkeys(damaged["capabilities"], "unavailable")
                continue
            if not line.endswith(b"\n"):
                # Retain the previous complete-record boundary for the next read.
                break
            consumed += len(line)
            if consumed > READ_BUDGET:
                stream.seek(start)
                break
            record = json.loads(line)
            reduce_codex(next_state["session"], record)
            next_state["offset"] = stream.tell()
        if stream.tell() == info.st_size and next_state["offset"] == info.st_size and not next_state.get("discarding"):
            complete = True
        stream.seek(max(0, next_state["offset"] - 512))
        next_state["anchor"] = hashlib.sha256(stream.read(min(512, next_state["offset"]))).hexdigest()
    session = copy.deepcopy(next_state["session"])
    label = "Codex 桌面会话" if session["source"] == "codex_desktop" else "Codex CLI 会话"
    if session["prompt"]:
        session["title"] = session["prompt"].splitlines()[0][:120] or "Codex CLI 会话"
    else:
        session["title"] = label
    session["evidence"]["observedAt"] = utc_now()
    if complete and session.get("_subagent"):
        next_state["publishedSubagent"] = subagent_sample(session)
    # No timestamp is published for an incomplete catch-up or an unfinished line.
    return session if complete else None, next_state, not complete


def subagent_metadata(metadata):
    source = metadata.get("source")
    subagent = source.get("subagent") if isinstance(source, dict) else None
    spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
    parent = spawn.get("parent_thread_id") if isinstance(spawn, dict) else None
    native = metadata.get("id")
    if (not isinstance(parent, str) or not 0 < len(parent) <= 256
            or not isinstance(native, str) or not 0 < len(native) <= 256 or parent == native):
        return None
    return {"parentThreadId": parent, "nickname": clean(spawn.get("agent_nickname")),
            "path": clean(spawn.get("agent_path")), "role": clean(spawn.get("agent_role"))}


def subagent_sample(session):
    result = {**session["_subagent"], "nativeId": session["nativeId"],
              "model": session.get("_model"), "effort": session.get("_effort"),
              "modelObservedAt": session.get("_modelObservedAt"),
              "status": "completed" if session["status"] == "unread" else
                        "interrupted" if session.get("_interrupted") else "unknown",
              "collectedAt": session["evidence"]["observedAt"], "freshness": "fresh"}
    for key in ("turnId", "prompt", "response", "startedAt", "completedAt", "activityAt", "reason"):
        result[key] = session[key]
    return result


def attach_subagents(records, state, status, observed):
    # Deduplicate within one storage host by native identity and stable file rank.
    children = {}
    for path, cursor in state["codex"].items():
        sample = cursor.get("publishedSubagent")
        if not sample:
            continue
        native = sample["nativeId"]
        rank = (-cursor.get("modified", 0), path)
        if native not in children or rank < children[native][0]:
            children[native] = (rank, sample)
    for record in records:
        parent = record["session"]
        if parent["source"] not in ("codex_cli", "codex_desktop"):
            continue
        items = [copy.deepcopy(value[1]) for native, value in sorted(children.items())
                 if value[1]["parentThreadId"] == parent["nativeId"]]
        parent["subagents"] = {"status": status, "scannedAt": observed, "items": items}


def codex_source(metadata):
    source = metadata.get("source")
    if source in ("cli", "exec"):
        return "codex_cli"
    if source in ("vscode", "appServer") and metadata.get("originator") == "Codex Desktop":
        return "codex_desktop"
    # Child agents are not independent top-level conversations.
    return None


def discover_page(root, queue, suffix, budget=256):
    """Persist pending entries between invocations; cap wide directories explicitly."""
    pending = list(queue) if queue else [str(root)]
    found = []
    visited = 0
    while pending and visited < budget:
        path = Path(pending.pop(0))
        visited += 1
        if path.is_symlink():
            continue
        if path.is_dir():
            with os.scandir(path) as entries:
                children = list(itertools.islice(entries, 4097))
            if len(children) > 4096 or len(pending) + len(children) > 8192:
                raise ValueError("discovery directory exceeds budget")
            # Date-named Codex directories and rollout files: discover recent first.
            pending[0:0] = [entry.path for entry in sorted(children, key=lambda item: item.name, reverse=True) if not entry.is_symlink()]
        elif path.is_file() and path.name.endswith(suffix):
            found.append(str(path))
    return found, pending


def read_ide(path, native_id=None, after=""):
    connection = open_db(Path(path))
    # Bound work even if a user database lacks a useful index.
    deadline = time.monotonic() + 2
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    results = []
    try:
        if native_id:
            rows = connection.execute("SELECT composerId,workspaceId FROM composerHeaders WHERE composerId=? LIMIT 1", (native_id,)).fetchall()
        else:
            rows = connection.execute("SELECT composerId,workspaceId FROM composerHeaders WHERE composerId>? ORDER BY composerId LIMIT ?", (after, PAGE)).fetchall()
        failures = 0
        for identity, workspace in rows:
            try:
                composer = value_json(connection, "composerData:" + identity)
                if not isinstance(composer, dict) or not composer:
                    raise ValueError("composer unavailable")
                session = base("cursor_ide", identity, utc_now())
                session["title"] = clean(composer.get("name")) or "Cursor IDE 会话"
                session["reason"] = "已读取 IDE 记录；生命周期、最终回复与活动时间尚未验证。"
                session["directory"], session["workspaceHost"] = workspace_details(workspace, Path(path).parent.parent / "workspaceStorage")
                # Reuse the bounded key lookup; never read all bubbles or infer message order from rowid.
                headers = composer.get("fullConversationHeadersOnly") or []
                if not isinstance(headers, list):
                    raise ValueError("invalid headers")
                for header in reversed(headers[-100:]):
                    if isinstance(header, dict) and header.get("type") == 1 and isinstance(header.get("bubbleId"), str):
                        bubble = value_json(connection, "bubbleId:" + identity + ":" + header["bubbleId"])
                        if not isinstance(bubble, dict) or not bubble:
                            raise ValueError("bubble unavailable")
                        session.update(turnId=header["bubbleId"], turnIdentityKind="derived", prompt=clean(bubble.get("text")))
                        session["capabilities"]["latestTurn"] = "candidate"
                        break
                results.append({"session": session, "locator": {"path": str(path), "source": "cursor_ide", "nativeId": identity}})
            except (OSError, ValueError, TypeError, AttributeError, sqlite3.Error):
                if native_id:
                    raise
                failures += 1
        return results, (rows[-1][0] if len(rows) == PAGE else ""), failures
    finally:
        connection.rollback()
        connection.close()


def run_request(request):
    if request.get("version") != PROTOCOL:
        raise ValueError("unsupported protocol")
    state = copy.deepcopy(request.get("state") or {})
    state.setdefault("codex", {})
    results, failures = [], 0
    diagnostics = dict.fromkeys(("codexInspected", "codexExcluded", "codexIncomplete", "codexErrors", "oversizedRecords"), 0)
    target = request.get("target")
    include_subagents = request.get("includeSubagents") is True and not target
    subagent_scan = "complete"
    if target:
        path = target["path"]
        if target["source"] in ("codex_cli", "codex_desktop"):
            session, cursor, partial = read_codex(path, state["codex"].get(path))
            if cursor:
                state["codex"][path] = cursor
            if session and session["nativeId"] == target["nativeId"]:
                results.append({"session": session, "locator": {**target, "modified": cursor["modified"]}})
            else:
                failures += 1
        elif target["source"] == "cursor_ide":
            results, _, failures = read_ide(path, target["nativeId"])
        elif target["source"] == "cursor_cli":
            results = [{"session": cursor_cli(Path(path), utc_now()), "locator": target}]
    else:
        home = Path.home()
        try:
            codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex").expanduser().resolve()
            if state.get("codexRoot") != str(codex_home):
                for key in ("codexQueue", "codexPending", "rotation"):
                    state.pop(key, None)
                state["codex"] = {}
                state.pop("codexLimited", None)
                state["codexRoot"] = str(codex_home)
            roots = [str(codex_home / "sessions"), str(codex_home / "archived_sessions")]
            paths, queue = discover_page(codex_home / "sessions", state.get("codexQueue") or roots, ".jsonl")
            state["codexQueue"] = queue
            known = list(state["codex"])
            offset = state.get("rotation", 0) % max(1, len(known))
            pending = list(dict.fromkeys(state.get("codexPending", []) + paths))
            pending = [path for path in pending if path not in state["codex"]]
            if len(pending) > 4096:
                raise ValueError("candidate queue exceeds budget")
            candidates = list(dict.fromkeys(known + pending[:96]))
            state["codexPending"] = pending[96:]
            state["rotation"] = offset + PAGE // 2
            new_reads = 0
            for index, path in enumerate(candidates):
                try:
                    if path not in state["codex"] and new_reads >= PAGE // 2:
                        state["codexPending"] = candidates[index:] + state["codexPending"]
                        break
                    session, cursor, partial = read_codex(path, state["codex"].get(path), include_subagents)
                    diagnostics["codexInspected"] += 1
                    if cursor is None:
                        diagnostics["codexExcluded"] += 1
                    if cursor:
                        diagnostics["oversizedRecords"] += cursor.get("oversizedRecords", 0)
                        if path not in state["codex"]:
                            new_reads += 1
                            if len(state["codex"]) >= MAX_TRACKED:
                                state["codexLimited"] = True
                                oldest = min(state["codex"], key=lambda key: state["codex"][key].get("modified", 0))
                                failures += 1
                                if cursor["modified"] <= state["codex"][oldest].get("modified", 0):
                                    continue
                                del state["codex"][oldest]
                        state["codex"][path] = cursor
                    if session and not session.get("_subagent"):
                        results.append({"session": session, "locator": {"path": path, "source": session["source"], "nativeId": session["nativeId"], "modified": cursor["modified"]}})
                    if partial:
                        diagnostics["codexIncomplete"] += 1
                        failures += 1
                except (OSError, ValueError, TypeError):
                    subagent_scan = "error"
                    diagnostics["codexErrors"] += 1
                    failures += 1
        except (OSError, ValueError):
            subagent_scan = "error"
            failures += 1
        if include_subagents:
            if subagent_scan != "error" and (state.get("codexQueue") or state.get("codexPending") or state.get("codexLimited") or diagnostics["codexIncomplete"]):
                subagent_scan = "partial"
            attach_subagents(results, state, subagent_scan, utc_now())
        ide = home / ".config/Cursor/User/globalStorage/state.vscdb"
        if os.name == "nt" and os.environ.get("APPDATA"):
            ide = Path(os.environ["APPDATA"]) / "Cursor/User/globalStorage/state.vscdb"
        if ide.is_file():
            try:
                records, after, source_failures = read_ide(ide, after=state.get("ideAfter", ""))
                failures += source_failures
                results.extend(records)
                state["ideAfter"] = after
            except (OSError, ValueError, sqlite3.Error, TypeError):
                failures += 1
        try:
            paths, queue = discover_page(home / ".cursor/chats", state.get("cliQueue"), "store.db")
            state["cliQueue"] = queue
            pending = list(dict.fromkeys(state.get("cliPending", []) + paths))
            if len(pending) > 4096:
                raise ValueError("candidate queue exceeds budget")
            state["cliPending"] = pending[PAGE:]
            for path in pending[:PAGE]:
                try:
                    session = cursor_cli(Path(path), utc_now())
                    results.append({"session": session, "locator": {"path": path, "source": "cursor_cli", "nativeId": session["nativeId"]}})
                except (OSError, ValueError, TypeError, sqlite3.Error):
                    failures += 1
        except (OSError, ValueError):
            failures += 1
    if not target and any(state.get(key) for key in ("codexQueue", "codexPending", "cliQueue", "cliPending", "ideAfter")):
        failures += 1
    enrich_git(results, state)
    return {"version": PROTOCOL, "observedAt": utc_now(), "records": results, "state": state, "failures": failures, "diagnostics": diagnostics}


def enrich_git(records, state):
    """At most one directory lookup per invocation; bounded cache, no remote writes."""
    cache = state.setdefault("git", {})
    now = time.time()
    directories = {record["session"].get("directory") for record in records
                   if record["session"].get("directory") and not record["session"].get("workspaceHost")}
    due = [directory for directory in directories if now - cache.get(directory, {}).get("at", 0) > 60]
    if due:
        directory = min(due, key=lambda key: (cache.get(key, {}).get("at", 0), key))
        common, worktree, branch = git_details(directory)
        if len(cache) >= MAX_TRACKED and directory not in cache:
            del cache[min(cache, key=lambda key: cache[key]["at"])]
        cache[directory] = {"at": now, "common": common, "worktree": worktree, "branch": branch}
    for record in records:
        session = record["session"]
        directory = session.get("directory")
        if not directory or session.get("workspaceHost"):
            continue
        saved = cache.get(directory)
        if saved:
            session["commonDir"], session["worktree"] = saved["common"], saved["worktree"]
            session["branch"] = saved["branch"] if now - saved["at"] <= 60 else None


def workspace_details(workspace, folder):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(workspace)):
        return None, None
    try:
        record = bounded_json(Path(folder) / str(workspace) / "workspace.json")
        parsed = urlparse(record.get("folder", ""))
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
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None, None


def cursor_cli(path, observed):
    session = base("cursor_cli", path.parent.name, observed)
    try:
        metadata = bounded_json(path.parent / "meta.json")
        session["directory"] = metadata.get("cwd") if isinstance(metadata.get("cwd"), str) else None
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    connection = open_db(path)
    deadline = time.monotonic() + 2
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    try:
        row = connection.execute("SELECT value FROM meta WHERE key='0' AND length(value)<=?", (MAX_RECORD,)).fetchone()
        if not row:
            raise ValueError("CLI metadata missing or oversized")
        value = row[0].decode("utf-8") if isinstance(row[0], bytes) else row[0]
        metadata = json.loads(bytes.fromhex(value))
        session["title"] = clean(metadata.get("name")) or "Cursor CLI 会话"
        session["reason"] = "已读取 Cursor CLI 存储；最新轮图结构和生命周期未验证，保持未知。"
        return session
    finally:
        connection.rollback()
        connection.close()
