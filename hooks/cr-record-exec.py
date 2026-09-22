#!/usr/bin/env python3
"""
Claude Router - cr-record-exec  (SubagentStop hook)

Records ACTUAL cheaper-model executions, not routing intent. The prompt hook
(classify-prompt.py) logs what CR *recommended*; this logs what *actually ran*.

Fires when a subagent finishes. If it was a CR executor (fast/standard) AND the
subagent genuinely ran on Haiku/Sonnet (read from the subagent's own transcript,
not assumed from frontmatter), it increments the real "ran" counter in
router-stats.json. A prompt the main loop handled itself on Opus never reaches
here, so the count cannot overstate offloading.

Part of claude-router: https://github.com/nixfred/claude-router
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import fcntl
    def _lock(f): fcntl.flock(f.fileno(), fcntl.LOCK_EX)
    def _unlock(f): fcntl.flock(f.fileno(), fcntl.LOCK_UN)
except Exception:
    def _lock(f): pass
    def _unlock(f): pass

STATS_FILE = Path.home() / ".claude" / "router-stats.json"
CR_AGENTS = {"fast-executor", "standard-executor", "deep-executor", "opus-orchestrator"}


def tier_from_model(model: str):
    m = (model or "").lower()
    if "haiku" in m:
        return "hku"
    if "sonnet" in m:
        return "snt"
    return None  # opus or unknown -> not an off-Opus execution


def model_from_transcript(path: str) -> str:
    """Return the last model id seen in the subagent transcript (the real model)."""
    try:
        p = Path(os.path.expanduser(path or ""))
        if not p.exists():
            return ""
        last = ""
        with open(p) as f:
            for line in f:
                m = re.search(r'"model"\s*:\s*"([^"]+)"', line)
                if m:
                    last = m.group(1)
        return last
    except Exception:
        return ""


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("agent_type", "") not in CR_AGENTS:
        sys.exit(0)  # not a CR executor

    tier = tier_from_model(model_from_transcript(data.get("agent_transcript_path", "")))
    if tier not in ("hku", "snt"):
        sys.exit(0)  # only count genuine off-Opus executions

    try:
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        today = datetime.now().strftime("%Y-%m-%d")
        # Read-modify-write under an exclusive lock so we never clobber the
        # prompt hook's concurrent updates.
        f = open(STATS_FILE, "a+")
        _lock(f)
        try:
            f.seek(0)
            raw = f.read()
            stats = json.loads(raw) if raw.strip() else {}
            ran = stats.setdefault("ran_all_time", {"hku": 0, "snt": 0})
            ran[tier] = ran.get(tier, 0) + 1
            sessions = stats.setdefault("sessions", [])
            s = next((x for x in sessions if x.get("date") == today), None)
            if s is None:
                s = {"date": today, "queries": 0, "kept_off_opus": 0,
                     "routes": {"fast": 0, "standard": 0, "deep": 0, "orchestrated": 0}}
                sessions.append(s)
            sran = s.setdefault("ran", {"hku": 0, "snt": 0})
            sran[tier] = sran.get(tier, 0) + 1
            f.seek(0)
            f.truncate()
            f.write(json.dumps(stats, indent=2))
        finally:
            _unlock(f)
            f.close()
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
