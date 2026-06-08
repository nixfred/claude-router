# Claude Router

### Stop hitting the wall.

Claude Router keeps your heavy model in reserve so your Claude Code session does not die at "you've reached your 5-hour limit." It quietly routes the prompts that do not need Opus down to Sonnet or Haiku, counts every time it does, and shows you the tally live on your status line.

> **Read this first, because it is the whole point.**
> If you are on a Max or Pro **subscription**, this tool does **not** save you money. You pay the same flat fee no matter what. There are no dollar figures in this project, and any you may have seen in older versions were fiction.
>
> What it saves is your **5-hour budget**. Opus burns that budget far faster than Sonnet or Haiku. Every prompt this router keeps off Opus is budget you still have later, which means fewer walls, more hours of real work per day, and you stay in flow instead of staring at a cooldown timer.
>
> The goal is not cheaper. The goal is **to keep working.**

---

## Why this exists

Anthropic meters Max and Pro on a rolling 5-hour window. Run everything on Opus and you can drain that window in well under an hour on a heavy day, then you are locked out until it resets. Most of what you ask an AI to do in a day does not actually need the most expensive model: finding files, fixing a small bug, adding a test, looking up where something is defined, routine edits. Sonnet handles those just fine.

Claude Router watches each prompt, decides whether it genuinely needs Opus, and if it does not, hands it to a cheaper model so your Opus budget lasts. You reserve the expensive model for the work that earns it: architecture, security, hard reasoning, the stuff that is actually worth a wall.

You do not have to think about it. It runs on every prompt, forever, and it tells you exactly how often it saved your bacon.

## What it does

- **Routes down, not up.** Substantive prompts that do not need Opus go to a Sonnet or Haiku subagent. Genuinely hard reasoning stays on Opus. Trivial one-liners are answered inline (delegating those costs more than it saves, so it does not).
- **Counts honestly.** It tracks one real number: how many prompts it kept off Opus, per day, per 5-hour window, and per week. No estimated dollars. No invented multipliers. Just a count of routing decisions that you validate against your own usage meter.
- **Lives on your status line.** A compact `⇩ today·week` segment ticks up as you work, so you watch your saved budget accumulate in real time.
- **Cannot die quietly.** The previous generation of this router silently stopped working one day and nobody noticed for months. This version repairs its own wiring at every session boot, and the status line flips to `CR⚠` the instant it is not running. Silent death is no longer possible.

## How routing works

The classifier is rule-based and free (instant regex), with an optional ~$0.001 Haiku check only for genuinely ambiguous prompts. It is deliberately **conservative about Opus**:

| Prompt looks like | Goes to | Counted as kept off Opus |
|---|---|---|
| Find / search / "where is X" / multi-file mechanical | **Sonnet** | yes |
| Bug fix, small feature, tests, refactor, anything uncertain | **Sonnet** (the workhorse default) | yes |
| Clearly simple, substantive | **Haiku** | yes |
| Trivial one-liner ("what is a closure") | answered inline, no hand-off | no (no real saving to claim) |
| Architecture, security audit, system design, deep trade-off analysis | **Opus** | no (this is what Opus is for) |

When uncertain, it defaults to **Sonnet**, not Haiku. Sonnet is capable enough to avoid a wrong cheap answer that would force an Opus retry, which would burn the budget anyway.

Need to force a model? `/route opus "..."` or `/route haiku "..."`. Think a cheap answer fell short? `/retry opus`.

## The status line

```
LARRY STATUS │ Opus 4.8 │ ctx:11% (22k/200k) ⏱0s │ ✿1 🔥24d │ ⇩37·214wk
```

`⇩37·214wk` means 37 prompts kept off Opus today, 214 this week. Line that up against how fast your usage meter is moving. Heavy routing days bend your burn curve down. That correlation is the honest version of "it saved me X." If it ever reads `CR⚠`, the router stopped and needs a look (it will usually have already fixed itself by your next session).

## It does not die

Three independent layers, plus git:

1. **Self-heal at boot.** `cr-doctor` runs on every Claude Code session start, verifies the hook is registered and present, and reinstalls it if anything is missing. Wiped by an unrelated settings merge? Restored automatically on the next session.
2. **Visible alarm.** The status line shows `CR⚠` the moment the hook is not wired. You see it within one turn instead of months later.
3. **Daily cron.** An optional once-a-day `cr-doctor` run covers stretches where you do not open a fresh session.

For all three to fail at once and stay failed, the universe has to actively hate you, and even then your git history holds the source.

## Install (manual)

The upstream marketplace plugin is deprecated. The manual install is the supported path and is what makes the self-heal and status line work.

```bash
git clone https://github.com/nixfred/claude-router.git
cd claude-router
./install.sh
```

`install.sh` copies the hooks, agents, and skills into `~/.claude`, then runs `cr-doctor` once to register both hooks (the UserPromptSubmit router and the SessionStart self-heal). Restart Claude Code to activate. Add the status line segment and the daily cron from the snippets in [docs/configuration.md](docs/configuration.md).

## Commands

| Command | What it does |
|---|---|
| `/route <model> "..."` | Force a specific model for one prompt |
| `/retry opus` | Re-run the last prompt on a bigger model |
| `/router-stats` | Show the kept-off-Opus tally (today / window / week) |
| `/cr-doctor` | Check CR health and repair it if needed |
| `/router-analytics` | HTML dashboard of routing over time |
| `/orchestrate` | Run a complex task across forked subagents |

## Credit

Forked from [0xrdan/claude-router](https://github.com/0xrdan/claude-router) by Dan Monteiro, whose classifier and subagent design are the foundation here. Version 3 rebuilt the purpose around subscription rate-limit survival: dollars removed, honest kept-off-Opus counting, conservative Opus routing, a live status-line tally, and the self-heal layer so it never silently dies again.

## License

MIT. See [LICENSE](LICENSE).
