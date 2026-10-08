# Configuration

The mod's options are its `userConfig` fields. Set them with `claude plugin configure tier-router`, or in `/config`. A change reloads the mod.

| Option | Values | Default | What it does |
|---|---|---|---|
| `mode` | `full`, `subagents`, `advise`, `off` | `full` | `full` routes the main loop and subagents. `subagents` routes spawns only. `advise` is a dry run that shows what it would do. `/cr` changes it for one session. |
| `mainFloor` | `sonnet`, `haiku` | `sonnet` | The lowest model the main loop may drop to for lookups and quick questions. Haiku is never used past 150k tokens of context. |
| `lift` | `security`, `deep`, `off` | `security` | When the session runs below Opus, which turns are lifted to Opus: security only, every deep turn, or none (a one-line suggestion to `/model opus` instead). |
| `maxSwitchTokens` | number | `60000` | A down-switch that would force more than this many tokens to be re-cached on the cheaper model is skipped. Doubled while the budget runs hot. |
| `cacheTtlMinutes` | number | `60` | How long a model's prompt cache is assumed to stay warm. |
| `routeCustomAgents` | boolean | `false` | Also send your own and plugin agents to a cheaper model when they were spawned without one. Deep agent types (security, architect, algorithm, plan) are never sent down. |

Example, from a script:

```bash
echo '{"routeCustomAgents":"true","lift":"deep"}' | claude plugin configure tier-router --values-stdin
```

## Model ids

A `turn.step` request is sent with the model name it carries, so the router needs full ids such as `claude-sonnet-5-5`, not aliases. In order, it uses:

1. ids it has seen answer (kept across sessions in the mod's store),
2. your `ANTHROPIC_DEFAULT_SONNET_MODEL` / `_HAIKU_` / `_OPUS_` / `_FABLE_` pins,
3. the running model's sibling (`claude-opus-5-5` gives `claude-sonnet-5-5`), verified once with a one-token completion.

If none of these gives a working id, the turn stays on the model it had.

## Status line helper

`tools/cr-usage.py` prints today's real request counts per model family (`fable opus sonnet haiku`), read from your session transcripts and deduplicated by request id. It knows nothing about the router, so it also measures whether routing is moving your usage. Call it from a status-line script:

```bash
read cr_fab cr_op cr_sn cr_hk <<< "$(python3 /path/to/claude-router/tools/cr-usage.py 2>/dev/null || echo '0 0 0 0')"
```

The mod also writes its own entry to the status line (`CR Sonnet · standard · 5h 31%`).
