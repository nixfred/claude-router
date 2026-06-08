# Configuration & Commands

## Hybrid classification (optional API key)

Classification is rule-based (instant, free). For genuinely ambiguous prompts it can optionally fall back to a ~$0.001 Haiku check. To enable that fallback:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Without a key it runs rules-only, which is plenty. The Haiku check also spends a few tokens against your 5-hour budget, so leave it off if you want zero overhead.

## Commands

| Command | What it does |
|---|---|
| `/route <model> "..."` | Force `haiku` / `sonnet` / `opus` for one prompt |
| `/retry opus` | Re-run the last prompt on a bigger model |
| `/router-stats` | Kept-off-Opus tally (today / window / week) + route distribution |
| `/cr-doctor` | Check CR health and repair the wiring if needed |
| `/router-analytics` | HTML dashboard of routing over time |
| `/orchestrate "..."` | Run a complex task across forked subagents |
| `/learn`, `/learn-on`, `/learn-off`, `/knowledge`, `/learn-reset` | Knowledge system |
| `/router-plugins` | Manage optional plugin integrations |

## Status-line segment (recommended)

Show the kept-off-Opus tally live so a silent failure is impossible. Compute `cr_seg` near the end of your status-line script, then print `${cr_seg}` wherever you want it:

```bash
cr_seg=""
if command -v python3 >/dev/null 2>&1; then
  cr_wired=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude/settings.json')));c=[x.get('command','') for g in d.get('hooks',{}).get('UserPromptSubmit',[]) for x in g.get('hooks',[])];print('1' if any('classify-prompt.py' in x for x in c) else '0')" 2>/dev/null)
  if [ "$cr_wired" != "1" ]; then
    cr_seg="CR⚠"   # router not wired (usually self-heals next session)
  else
    cr_seg=$(python3 - <<'PY' 2>/dev/null || echo '⇩0·0wk'
import json, os, datetime
d = json.load(open(os.path.expanduser('~/.claude/router-stats.json')))
today = datetime.date.today().isoformat()
wk = (datetime.date.today() - datetime.timedelta(days=6)).isoformat()
t = next((s.get('kept_off_opus', 0) for s in d.get('sessions', []) if s.get('date') == today), 0)
w = sum(s.get('kept_off_opus', 0) for s in d.get('sessions', []) if s.get('date', '') >= wk)
print('⇩%d·%dwk' % (t, w))
PY
)
  fi
fi
```

## Daily self-heal cron (recommended)

Belt-and-suspenders so CR re-asserts its wiring even on days you do not start a fresh session:

```bash
cat > ~/.claude/Tools/cr-doctor-cron.sh <<'EOF'
#!/usr/bin/env bash
python3 "$HOME/.claude/hooks/cr-doctor.py"
EOF
chmod +x ~/.claude/Tools/cr-doctor-cron.sh
( crontab -l 2>/dev/null; echo "0 8 * * * $HOME/.claude/Tools/cr-doctor-cron.sh >> $HOME/.claude/logs/cr-doctor-cron.log 2>&1" ) | crontab -
```

## Forcing behavior

- **Automatic**: the hook classifies every prompt and routes the cheap ones down to Sonnet/Haiku.
- **Manual override**: `/route opus "..."` forces Opus; `/route haiku "..."` forces Haiku.
- **Escalate after the fact**: `/retry opus` re-runs the last prompt on a bigger model.

## How routing decides

See [Routing Rules](routing.md) for the classifier, and [How It Works](how-it-works.md) for the why. In short: strong reasoning signals (architecture, security, design, deep trade-offs) go to Opus; everything substantive else goes to Sonnet; clearly simple substantive prompts go to Haiku; trivial one-liners are answered inline. When uncertain, it defaults to Sonnet.
