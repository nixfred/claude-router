# Routing Rules

Claude Router classifies every prompt with instant, free regex rules (an optional ~$0.001 Haiku check handles only genuinely ambiguous prompts), then routes the ones that do not need Opus to a cheaper model. It is deliberately conservative about Opus to protect your 5-hour budget.

## Fast route (Haiku): clearly simple, substantive
- Factual lookups, formatting and linting, git status/log/diff, JSON/YAML, regex, syntax questions.
- Trivial one-liners (very short, no tool intent) are answered inline on the main loop instead of being delegated. The Opus hand-off would cost more than it saves, so they are not delegated and not counted.

## Standard route (Sonnet): the workhorse, and the default when uncertain
- Bug fixes, feature work, code review, refactoring, test writing.
- Tool-intensive work: codebase search, "where is X used", multi-file mechanical edits, running tests.
- Anything the rules are unsure about. Sonnet is capable enough to avoid a wrong cheap answer that would force an Opus retry.

## Deep route (Opus): reserved for genuine reasoning
- Architecture and system design, security audits, deep trade-off analysis, hard performance work.
- Escalation requires a strong signal. A single incidental keyword next to tool or exploration signals is treated as exploration and routed to Sonnet, not escalated to Opus. Genuine Opus-tier prompts stay on the main loop (already Opus) rather than being handed to an Opus subagent.

## What counts as "kept off Opus"
Every prompt routed to Sonnet or Haiku. Trivial inline answers and Opus-tier prompts are not counted. See `/router-stats`.

## Example directive (Sonnet)
When CR routes a prompt down it injects a short, reasoned instruction (not an aggressive command, which modern Opus tends to distrust):
```
[Claude Router] Keep this off Opus to preserve the 5-hour budget. Route it to Sonnet.
Classified: standard (85%, rules) | tool-intensive | signals: find all, across the codebase

Spawn the standard-executor subagent with the Task tool and answer from its result; do not handle it directly on Opus.
```

## Classification
- **Rules (default):** zero latency, no API call, tuned for coding workflows.
- **Hybrid (optional):** when rule confidence is below 70%, a Haiku check (~100ms, ~$0.001) improves accuracy on ambiguous prompts. Enable with `export ANTHROPIC_API_KEY=sk-ant-...`. Off by default; it also spends a few tokens against your 5-hour budget.
