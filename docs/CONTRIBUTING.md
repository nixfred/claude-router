# Contributing to Claude Router

Thanks for helping. Fork, branch, change, test, open a pull request.

## Layout

```
claude-router/
├── .claude-plugin/
│   ├── plugin.json        # the tier-router mod: name, version, userConfig options
│   └── marketplace.json   # makes the repo installable with /plugin install
├── hooks/
│   ├── hooks.json         # { "modules": ["./register.ts"] }
│   ├── register.ts        # wires the policy to Claude Code's mod events
│   ├── classify.ts        # prompt -> kind of work (pure)
│   └── policy.ts          # kind of work + cache state -> model (pure)
├── tests/                 # run by `claude plugin test .`
├── tools/cr-usage.py      # status-line helper: real requests per model family
├── install.sh / uninstall.sh
└── docs/
```

## Check a change

```bash
claude plugin validate .     # what the engine would load or refuse
claude plugin test .         # tests/*.test.ts against the engine itself
```

Type-check with the `tsconfig.json` at the root. It extends `.claude-plugin/types/`, which Claude Code writes the first time it loads the mod from this folder (for example with `claude --plugin-dir .`); that folder is not committed.

```bash
bunx -p typescript tsc -p .
```

To watch it route for real, run a print-mode session with the mod loaded and read which model answered:

```bash
claude -p --plugin-dir . --model opus --output-format json "Fix the typo: teh" \
  | jq '.[] | select(.type=="assistant") | .message.model'
```

## Where help is welcome

- **Classification.** New patterns, false positives, false negatives. Add a test in `tests/policy.test.ts` for each.
- **Cache pricing.** The switch cost is estimated from message counts. Better estimates are welcome if they come with tests.
- **Effort.** `turn.step` can also set the effort level. It is not routed yet, because changing it may cost a cache rewrite on some models; measurements first.

## Style

Match the code around you. Pure logic goes in `classify.ts` or `policy.ts`, where it can be tested without the engine. Anything that touches `$` goes in `register.ts`.
