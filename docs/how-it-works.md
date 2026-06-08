# How Claude Router Works

## The problem it solves

Anthropic meters Max and Pro on a rolling 5-hour window (plus a weekly cap). Opus draws that window down far faster than Sonnet or Haiku, so a few heavy Opus hours can lock you out until it resets. Most day-to-day prompts (finding files, small fixes, tests, lookups, routine edits) do not need Opus. Run them on Opus anyway and you spend your budget on work a cheaper model would have done just as well.

## What it does

On every prompt, a `UserPromptSubmit` hook classifies the request and, when it does not need Opus, routes it to a Sonnet or Haiku subagent. Genuine reasoning stays on Opus. Each routed-down prompt is counted as "kept off Opus."

```
"what is a closure"                         -> answered inline (trivial, no hand-off)
"find all callers of parseConfig"           -> Sonnet  (kept off Opus)
"fix the login validation bug, add a test"  -> Sonnet  (kept off Opus)
"where is the auth middleware defined"      -> Sonnet  (kept off Opus)
"design a multi-region failover + security" -> Opus    (this is what Opus is for)
```

## A note on money

On a subscription you pay a flat fee, so this does **not** save dollars, and there are no dollar figures anywhere in this project. What it saves is your 5-hour budget: every prompt kept off Opus is budget you still have later, which means fewer "you've reached your limit" walls and more real working hours per day.

(If you ever point Claude Code at the metered API instead of a subscription, the same routing does translate to real dollars, because you pay per token. That is not the design target here.)

## Conservative about Opus, on purpose

When the classifier is unsure, it defaults to **Sonnet**, not Haiku. Sonnet is capable enough to avoid a wrong cheap answer that would send you back to Opus for a retry (which would burn the budget anyway). Opus is reserved for prompts with strong reasoning signals: architecture, security, system design, deep trade-off analysis.

## Trivial and deep are left alone

Two cases are deliberately **not** delegated, because the Opus hand-off (reading a directive, spawning a subagent, relaying the result, roughly a few hundred Opus tokens) would cost more than it saves:

- Trivial one-liners are answered inline on the main loop.
- Genuine Opus-tier work stays on the main loop (it is already Opus; an Opus subagent would only add tax).

Neither is counted as a saving. The count stays honest.

## See it work

- `/router-stats` shows the kept-off-Opus tally (today / 5-hour window / week).
- Your status line shows a live `⇩ today·week` segment, and flips to `CR⚠` if the router ever stops.
- `/cr-doctor` verifies and repairs the wiring on demand.
