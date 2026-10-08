# Claude Router

### Stop hitting the wall.

Claude Router keeps your heavy model in reserve so your Claude Code session does not die at "you've reached your 5-hour limit." Version 4 is a Claude Code **mod** (`tier-router`): it sets the model of every request itself, sending each turn and each subagent to the lowest model that does the job, and it shows you what it did on your status line.

> **Read this first, because it is the whole point.**
> If you are on a Max or Pro **subscription**, this tool does **not** save you money. You pay the same flat fee no matter what. There are no dollar figures in this project.
>
> What it saves is your **5-hour and weekly budget**. Opus burns it far faster than Sonnet or Haiku. Every request kept off Opus is budget you still have later: fewer walls, more hours of real work per day.
>
> The goal is not cheaper. The goal is **to keep working.**

---

## What changed in v4

Versions 1 to 3 were a `UserPromptSubmit` hook that guessed the kind of work and then *asked* the main model to hand it to a Haiku or Sonnet subagent. The model could ignore the request, every hand-off cost an extra turn, and the main loop itself never left Opus.

Claude Code now has a mod API (function hooks), and two of its events are exactly what a router needs:

- **`turn.step`** sees every model request before it is sent and can name a different model for it.
- **`agent.spawn`** sees every subagent before it starts and can name its model.

So v4 does not ask. It routes. The classifier (the tuned v3.2 rules) still decides what kind of work a prompt is; the mod puts that decision on the wire.

Claude Code itself still has **no automatic per-prompt model choice**. It ships the knobs (`opusplan`, `/advisor`, `CLAUDE_CODE_SUBAGENT_MODEL`, `fallbackModel`, `model:` in skills and agents) but nothing that decides. Opus is the default on every plan, and the built-in Explore agent now runs on your main model instead of Haiku.

## What it does

| Work | Main loop | Subagent spawned without a model |
|---|---|---|
| Lookups: "where is X defined", "find all callers" | Sonnet | Haiku |
| Quick questions, formatting, syntax | Sonnet (Haiku if you allow it) | Haiku |
| Ordinary coding: fixes, features, tests, anything uncertain | Sonnet | Sonnet |
| Bulk text on a host with a local `gpu` command | Sonnet, plus a note to do the bulk on the GPU | Sonnet |
| Architecture, deep trade-offs (2+ deep signals) | your session model | left alone |
| Anything security (one signal is enough) | your session model, lifted to Opus if you run Sonnet | left alone |
| A follow-up ("yes", "go ahead") to a deep turn | stays deep | |
| Explore (built-in) | | Haiku |

- **It never routes up by accident.** It only lowers a tier, except for security work on a Sonnet session, which it lifts to Opus (configurable).
- **It respects explicit choices.** A spawn that names a model, a forked agent, a teammate and a workflow agent are left alone. `/cr pin opus` pins the main loop.
- **It is cache-aware.** Switching models re-caches the conversation on the new model. The router tracks where each model's prompt cache stands and skips a switch whose rewrite would cost more than the cheaper model saves (default: 60k tokens). One decision per turn, never mid-turn.
- **It never sends a guessed model id.** Requests need full ids. It learns them from what the API reports, honours `ANTHROPIC_DEFAULT_*_MODEL` pins, and verifies any other id once with a one-token call before using it. No verified id, no switch.
- **It tightens when the budget runs hot.** Past 80% of the 5-hour window (or 90% of the week) it stops optional lifts and switches down more eagerly.
- **It counts honestly.** Per day: which tier each main turn ran on, how many turns went down or up, how many switches the cache held back, which subagents it sent down, and the real requests and tokens per model as the API reported them.

## Install

From Claude Code:

```
/plugin install tier-router --marketplace nixfred/claude-router
```

Or from a clone, which also retires a v3 install if one is wired into `settings.json`:

```bash
git clone https://github.com/nixfred/claude-router.git
cd claude-router
./install.sh
```

The clone install reads the mod straight from the folder, so `git pull` and `/reload-plugins` is an upgrade. Tested on Claude Code 2.1.293. The mod API is early access and may change between releases.

## Use

The status line shows the route of the last turn and your 5-hour usage:

```
CR Sonnet · standard · 5h 31%
```

| Command | What it does |
|---|---|
| `/cr` | Status: mode, last decision and why, limits, today's counts, requests by model |
| `/cr pin <opus\|sonnet\|haiku>` | Pin the main loop for this session; `/cr unpin` routes again |
| `/cr dry` | Dry run: show what it would do, change nothing |
| `/cr subagents` | Route subagents only, leave the main loop alone |
| `/cr off` / `/cr full` | Off, or back to full routing |

Settings live in the plugin's options: `claude plugin configure tier-router`, or `/config`. See [docs/configuration.md](docs/configuration.md).

## Honest limits

- The classifier is regex rules. It is fast and free, and it is wrong sometimes. The status line shows every decision so you can see it, and `/cr pin` overrides it.
- Mid-session switches cost a cache rewrite. The router prices that in, but it estimates from message counts, not exact tokens.
- A mod cannot see an agent file's own `model:`. Your own and plugin agents are left alone unless you turn on `routeCustomAgents`; deep agent types (security, architect, plan) are never sent down.

## Credit

Forked from claude-router by Dan Monteiro (0xrdan), whose classifier and subagent design are the foundation here. His repository has since been deleted; this fork is the live line. Version 3 rebuilt the purpose around subscription rate-limit survival. Version 4 rebuilt the mechanism on Claude Code's mod API.

## License

MIT. See [LICENSE](LICENSE).
