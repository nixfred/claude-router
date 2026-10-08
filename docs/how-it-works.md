# How it works

Three files, no runtime dependencies:

- `hooks/classify.ts` names the kind of work in a prompt: `deep`, `standard`, `lookup`, `fast`, `gpu`, or `skip`.
- `hooks/policy.ts` turns that into a model, for the main loop (`decideMain`) and for a subagent (`decideSpawn`), and prices prompt-cache rewrites.
- `hooks/register.ts` wires both to Claude Code's mod events.

## One turn

1. **`prompt.submit`** records where the prompt came from. Typed prompts (`composer`, `bridge`, `sdk`, scheduled triggers) are classified; notifications and peer messages keep whatever is running. A GPU-tier prompt gets a hidden note telling the model to do the bulk work with the local `gpu` command. An Opus-grade prompt on a Sonnet session that is not lifted gets a note to suggest `/model opus`.
2. **`turn.start`** classifies the text the turn begins with.
3. **`turn.step`**, the first request of the turn, decides the turn's model once:
   - deep or security: the session model, or Opus when security lifts a Sonnet session;
   - a follow-up to a deep turn: deep again;
   - everything else: Sonnet (or Haiku for lookups if `mainFloor` allows), **if** the switch is cheap.
   Every later request of the turn carries the same model, so the cache is never rewritten inside a turn.
4. After each request it records which model answered, how big the context was, and the tokens the API reported.
5. **`turn.complete`** remembers the turn's route (for follow-ups) and saves the day's counts.

## The cache rule

Each model has its own prompt cache. A request on a model whose cache is cold pays to write the whole conversation again. The router keeps a mark per model: when it last answered and how many messages the conversation had then. For a candidate switch it estimates:

- tokens the cheaper model must write now: everything, if its cache is cold or older than the TTL or the conversation was compacted since; otherwise only the messages added since its mark;
- tokens staying put would write: the same estimate for the current model.

The difference is the extra cost of switching. Above `maxSwitchTokens` the switch is skipped and counted as "held by cache". Lifts for deep and security work ignore the cost; the job needs the model.

At a session's start both caches are cold, so the first switch is free. After a few turns on Sonnet, coming back from an Opus turn costs only the messages since, so the router can move between the two without paying for the whole conversation each time.

## Subagents

**`agent.spawn`** fires before a subagent starts. A spawn that names a model, a fork (which always inherits), a teammate or a workflow agent is left alone. For the rest:

- deep or security work, or a deep agent type (security, architect, algorithm, plan): left alone;
- built-in Explore, lookups and quick questions: Haiku;
- other work: Sonnet;
- never above the parent's tier.

Custom agents (yours, or a plugin's) are only routed with `routeCustomAgents`, because a mod cannot see an agent file's own `model:`.

## Budget awareness

**`session.measure`** carries the real rate-limit windows (`five_hour`, `seven_day`). Past 80% of five hours or 90% of seven days the router stops optional lifts and doubles the cache allowance for switching down.

## What gets counted

Per day, in the mod's own store: main turns by tier, turns down and lifted, switches held by the cache, subagents sent down by tier, and requests and tokens per model as the API reported them, including subagents' requests. `/cr` shows today's.
