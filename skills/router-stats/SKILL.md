---
name: router-stats
description: Use when user says "router stats", "/router-stats", "how much did we keep off opus", "show routing", "cr stats", or wants Claude Router's kept-off-Opus tally and route distribution.
user_invokable: true
---

# Router Stats

Show how much work Claude Router kept off Opus. **No dollar figures**: on a Max/Pro subscription dollar savings are fictional (flat fee regardless). The number that matters is how many prompts went to Sonnet/Haiku instead of Opus, which is what preserves the 5-hour budget.

## Instructions

Read `~/.claude/router-stats.json` (v3.0 schema) and present it clearly.

## Data Format (v3.0)
```json
{
  "version": "3.0",
  "total_queries": 120,
  "routes": {"fast": 14, "standard": 78, "deep": 28, "orchestrated": 0},
  "kept_off_opus_all_time": 92,
  "recent_events": [{"ts": 0.0, "route": "standard", "kept": true}],
  "sessions": [
    {"date": "2026-06-07", "queries": 40, "kept_off_opus": 31,
     "routes": {"fast": 5, "standard": 26, "deep": 9, "orchestrated": 0}}
  ],
  "last_updated": "2026-06-07T20:40:00"
}
```

`kept_off_opus` = prompts routed to Sonnet or Haiku instead of Opus. Trivial prompts answered inline and genuine Opus-tier reasoning are deliberately not counted (no real saving to claim).

## Output Format
```
╔═══════════════════════════════════════════════════╗
║              Claude Router · kept off Opus         ║
╚═══════════════════════════════════════════════════╝

⇩ Kept off Opus
───────────────────────────────────────────────────
  This 5-hour window:  <N>
  Today:               31
  This week:           <sum of last 7 days>
  All time:            92

📊 Route distribution (all time)
───────────────────────────────────────────────────
  Haiku  (fast):     14  ███░░░░░░░░░░░░░░
  Sonnet (standard): 78  ████████████████
  Opus   (deep):     28  ██████░░░░░░░░░░

📅 Today (2026-06-07)
───────────────────────────────────────────────────
  40 prompts | 31 kept off Opus
  Haiku 5 · Sonnet 26 · Opus 9
```

## Steps
1. Read `~/.claude/router-stats.json`. If it is missing, say there are no stats yet (fresh install, or no routed prompts since the last reset).
2. 5-hour window: count `recent_events` entries with `kept == true` whose `ts` is within the last 5 hours.
3. This week: sum `kept_off_opus` across `sessions` dated within the last 7 days.
4. Show today's session, all-time `kept_off_opus`, and route distribution with simple bars.
5. **Never show dollar amounts.** If asked about money, explain: on a subscription the value is 5-hour budget preserved (fewer rate-limit walls), not dollars saved. Suggest lining the kept-off-Opus count up against how fast their usage meter moves.
