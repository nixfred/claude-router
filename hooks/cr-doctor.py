#!/usr/bin/env python3
"""
Claude Router - cr-doctor  (SessionStart self-heal + installer)

Runs at every Claude Code boot so CR can NEVER silently die again (it once sat
dead for months after its registration was wiped by an unrelated settings merge).

On each run it verifies, and repairs if missing:
  1. the UserPromptSubmit classify-prompt.py hook is registered in settings.json
  2. this SessionStart cr-doctor hook is registered (self-perpetuating)
  3. the hook files exist on disk (restores from the repo copy if absent)

Idempotent: only writes settings.json when a repair is actually needed, and
backs it up first. Failures never block session start.

Also usable as a one-shot installer:  python3 cr-doctor.py
Part of claude-router: https://github.com/nixfred/claude-router
"""
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

CLAUDE = Path.home() / ".claude"
SETTINGS = CLAUDE / "settings.json"
HOOK = CLAUDE / "hooks" / "UserPromptSubmit" / "classify-prompt.py"
DOCTOR = CLAUDE / "hooks" / "cr-doctor.py"
REPO = Path.home() / "Projects" / "claude-router" / "hooks"
LOG = CLAUDE / "router-doctor.log"

CLASSIFY_CMD = f"python3 {HOOK}"
DOCTOR_CMD = f"python3 {DOCTOR}"


def log(msg: str):
    try:
        with open(LOG, "a") as f:
            f.write(f"{datetime.now().isoformat()} {msg}\n")
    except Exception:
        pass


def has_cmd(groups, needle: str) -> bool:
    for g in groups or []:
        for h in g.get("hooks", []):
            if needle in (h.get("command") or ""):
                return True
    return False


def main():
    repaired = []

    # 1. Restore hook files from the repo if they vanished.
    for live, name in ((HOOK, "classify-prompt.py"), (DOCTOR, "cr-doctor.py")):
        try:
            src = REPO / name
            if not live.exists() and src.exists():
                live.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, live)
                repaired.append(f"restored {name} from repo")
        except Exception as e:
            log(f"file-restore error ({name}): {e}")

    # 2. Ensure both registrations exist in settings.json.
    try:
        settings = {}
        if SETTINGS.exists():
            settings = json.loads(SETTINGS.read_text())

        hooks = settings.setdefault("hooks", {})
        ups = hooks.setdefault("UserPromptSubmit", [])
        ss = hooks.setdefault("SessionStart", [])

        changed = False
        if HOOK.exists() and not has_cmd(ups, "classify-prompt.py"):
            ups.append({"hooks": [{"type": "command", "command": CLASSIFY_CMD, "timeout": 15}]})
            repaired.append("re-registered UserPromptSubmit -> classify-prompt.py")
            changed = True
        if DOCTOR.exists() and not has_cmd(ss, "cr-doctor.py"):
            ss.append({"hooks": [{"type": "command", "command": DOCTOR_CMD, "timeout": 10}]})
            repaired.append("re-registered SessionStart -> cr-doctor.py")
            changed = True

        if changed:
            try:
                if SETTINGS.exists():
                    shutil.copy2(SETTINGS, SETTINGS.with_name("settings.json.bak-crdoctor"))
            except Exception as e:
                log(f"settings backup error: {e}")
            SETTINGS.write_text(json.dumps(settings, indent=2))
    except Exception as e:
        log(f"settings-repair error: {e}")

    if repaired:
        log("REPAIRED: " + "; ".join(repaired))

    # SessionStart hooks may print additionalContext; CR stays silent.
    sys.exit(0)


if __name__ == "__main__":
    main()
