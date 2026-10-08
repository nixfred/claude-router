# Claude Router (tier-router mod): working notes

This repo is a Claude Code **mod**: a plugin of function hooks in TypeScript, not a settings hook. `hooks/register.ts` is loaded by the engine; `classify.ts` and `policy.ts` are pure and hold the logic. Read `docs/how-it-works.md` first.

## Before claiming a change works

```bash
claude plugin validate .
claude plugin test .
bunx -p typescript tsc -p .
```

For anything that changes which model a request names, also run one live `claude -p --plugin-dir . --model opus --output-format json "<prompt>"` and read `.message.model` on the assistant events. The unit tests cannot catch the API refusing a model name.

## Gotchas this mod already hit (Claude Code 2.1.293)

- **`turn.step` needs a full model id.** An alias such as `sonnet` is sent to the API as-is and refused (`[claude-code:unrecognized_model]`, turn dies). `agent.spawn` does resolve aliases. `modelId()` in register.ts handles this; do not "simplify" it back to aliases.
- **`$` may only be passed to top-level functions** (a function declaration or a top-level const bound to one). Closures inside `register` that take `$` fail validation. Session state lives in the `State` object passed alongside.
- **`$.env.get` takes a literal name**, so the engine can list what a mod reads. One call per variable.
- **No dynamic `import()`** anywhere, tests included.
- **Plugin names starting with `claude-` are reserved.** The repo is `claude-router`, the plugin is `tier-router`, the marketplace is `claude-router`.
- In tests, `agent.spawn` may arrive without `provider`; real sessions always fill it. Keep the name fallback in `isBuiltIn`.

## Upstream

The original upstream (0xrdan/claude-router) is deleted, and GitHub's listed parent is a stale v1.1.0 copy. There is nothing to pull; this fork is the live line.
