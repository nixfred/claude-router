#!/usr/bin/env python3
"""
Claude Router - cr-usage  (statusline helper; NOT a Claude Code hook)

Prints today's ACTUAL model-call counts, account-wide, as:
    "<fable> <opus> <sonnet> <haiku>"

Counts UNIQUE API requests (deduped by requestId, message.id fallback), not
transcript lines: Claude Code writes one jsonl line per content block, so one
assistant turn with thinking + text + tool calls lands several lines. The
pre-2026-07-11 version counted lines and ran ~3x hot (338 displayed vs 112
real Opus requests, measured). Fable was also invisible to the old regex.

Scans every transcript under ~/.claude/projects (subagents included: they are
real API calls) within the LOCAL (America/New_York) calendar day, converted to
a UTC window because transcript timestamps are UTC.

A 60s result cache (MEMORY/State/cr-usage-cache.txt) keeps the statusline from
rescanning transcripts on every render.

This is real usage (what actually ran), not routing intent. The statusline reads it.
Part of claude-router: https://github.com/nixfred/claude-router
"""
import os
import re
import time
from datetime import datetime, timedelta

CACHE = os.path.expanduser("~/.claude/MEMORY/State/cr-usage-cache.txt")
CACHE_TTL = 60  # seconds; statusline renders far more often than usage changes meaningfully


def main():
    # Serve from cache when fresh
    try:
        if time.time() - os.path.getmtime(CACHE) < CACHE_TTL:
            with open(CACHE) as f:
                out = f.read().strip()
            if re.fullmatch(r"\d+ \d+ \d+ \d+", out):
                print(out)
                return
    except Exception:
        pass

    seen = {"fable": set(), "opus": set(), "sonnet": set(), "haiku": set()}
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("America/New_York")
        utc = ZoneInfo("UTC")
        start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        su = start.astimezone(utc).strftime("%Y-%m-%dT%H:%M:%S")
        eu = (start + timedelta(days=1)).astimezone(utc).strftime("%Y-%m-%dT%H:%M:%S")
        start_epoch = start.timestamp()
    except Exception:
        print("0 0 0 0")
        return

    pm = re.compile(r'"model":"claude-([a-z0-9.-]+)"')
    pt = re.compile(r'"timestamp":"([0-9T:-]{19})')
    prid = re.compile(r'"requestId":"([^"]+)"')
    pmid = re.compile(r'"id":"(msg_[^"]+)"')
    root = os.path.expanduser("~/.claude/projects")
    try:
        for dirpath, _, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".jsonl"):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    if os.path.getmtime(p) < start_epoch:
                        continue  # file not touched today -> no today entries
                    with open(p) as f:
                        for line in f:
                            mt = pt.search(line)
                            if not (mt and su <= mt.group(1) < eu):
                                continue
                            mm = pm.search(line)
                            if not mm:
                                continue
                            fam = next((k for k in seen if k in mm.group(1)), None)
                            if fam is None:
                                continue
                            rid = prid.search(line) or pmid.search(line)
                            if rid:
                                seen[fam].add(rid.group(1))
                except Exception:
                    pass
    except Exception:
        pass

    out = "%d %d %d %d" % (
        len(seen["fable"]), len(seen["opus"]), len(seen["sonnet"]), len(seen["haiku"]),
    )
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w") as f:
            f.write(out + "\n")
    except Exception:
        pass
    print(out)


if __name__ == "__main__":
    main()
