---
name: cr-doctor
description: Use when user says "cr-doctor", "/cr-doctor", "check the router", "is claude router working", "is CR alive", "fix the router", or wants to verify or repair Claude Router's health and wiring.
user_invokable: true
---

# CR Doctor

Health check and self-repair for Claude Router. Confirms CR is wired, recording, and alive, and fixes the wiring if anything is missing.

## Instructions

1. Run the doctor (verifies and repairs CR's hook registration):
   ```bash
   python3 ~/.claude/hooks/cr-doctor.py
   ```

2. Report wiring status:
   ```bash
   python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude/settings.json')));h=d.get('hooks',{});ups=[x.get('command','') for g in h.get('UserPromptSubmit',[]) for x in g.get('hooks',[])];ss=[x.get('command','') for g in h.get('SessionStart',[]) for x in g.get('hooks',[])];print('router hook wired:', any('classify-prompt.py' in c for c in ups));print('self-heal wired :', any('cr-doctor.py' in c for c in ss))"
   ```

3. Report recording status (today + all-time kept-off-Opus tally):
   ```bash
   python3 -c "import json,os,datetime;p=os.path.expanduser('~/.claude/router-stats.json');d=json.load(open(p));t=datetime.date.today().isoformat();s=next((x for x in d.get('sessions',[]) if x.get('date')==t),{});print('kept off Opus today:', s.get('kept_off_opus',0),'| all-time:', d.get('kept_off_opus_all_time',0),'| last_updated:', d.get('last_updated'))" 2>/dev/null || echo "no stats yet (fresh install or no routed prompts yet)"
   ```

4. Report last repair (if any):
   ```bash
   tail -3 ~/.claude/router-doctor.log 2>/dev/null || echo "no repairs ever logged (healthy)"
   ```

5. Summarize for the user in one or two lines: is CR wired, is it recording, and did the doctor repair anything just now.
