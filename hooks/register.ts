// Claude Router v4 (tier-router) - a Claude Code mod that routes models for real.
//
// v1-v3 asked the main model to hand work to a cheaper subagent. v4 sets the
// model itself: `turn.step` names the model of every main-loop request,
// `agent.spawn` names a subagent's model. The classifier and policy are pure
// (classify.ts, policy.ts); this file wires them to the engine.

import type { EngineInterface as Engine, Register } from 'claude-code'

import { classify, type Classification, type Route } from './classify'
import {
  decideMain,
  decideSpawn,
  isFullId,
  NAME,
  RANK,
  readConfig,
  siblingId,
  tierOf,
  type CacheMark,
  type CacheView,
  type Config,
  type Tier,
} from './policy'

/**
 * Aliases for `agent.spawn`, which resolves them like the Agent tool's own
 * parameter. A `turn.step` request is sent as named, so it needs a full id
 * (modelId below): an alias there reaches the API as-is and is refused.
 */
const ALIAS: Record<Tier, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' }

/** Prompts from these origins are someone asking; the rest (notifications, peers) keep the running model. */
const TYPED = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

const SKIP: Classification = { route: 'skip', signals: [], security: false, followUp: false }

const GPU_CONTEXT = `[Claude Router] Local-GPU tier: this is bulk text work for the local GPU, not cloud tokens.
Run the heavy part locally: \`gpu "<instruction>" <file> < /dev/null\` or pipe it (\`cmd | gpu --bulk "<instruction>"\`; \`gpu --json '<schema>' <file>\` for structured facts). Verify the output before relying on it, never execute what it returns, and if gpu exits non-zero (3 = Ollama down) do it yourself and say so. Mention in one line that you used the GPU.`

const STORE_KEY = 'days'
const IDS_KEY = 'ids'
const KEEP_DAYS = 30
const MODES: readonly Config['mode'][] = ['full', 'subagents', 'advise', 'off']

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

type Day = {
  /** Main-loop turns by the tier they ran on. */
  turns: Partial<Record<Tier, number>>
  /** Main-loop turns run below the session's own model. */
  down: number
  /** Main-loop turns lifted above it. */
  lifted: number
  /** Down-switches skipped because the cache rewrite cost more than it saved. */
  heldByCache: number
  /** Subagents this router sent to a cheaper model. */
  spawns: Partial<Record<Tier, number>>
  /** API requests and tokens by the model that answered, as the API reported them. */
  usage: Record<string, { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }>
}

/** Everything one session's routing remembers. A reload starts it over. */
type State = {
  config: Config
  mode: Config['mode']
  pin?: Tier
  hasGpu: boolean
  fiveHour?: number
  sevenDay?: number
  contextTokens: number
  previous?: Route
  current?: Tier
  last?: { tier: Tier; reason: string; route: Route }
  marks: Partial<Record<Tier, CacheMark>>
  origins: Map<string, string>
  turns: Map<string, { c: Classification; tier?: Tier }>
  days: Record<string, Day>
  isDirty: boolean
  /** Full model ids seen answering or verified, by tier; kept across sessions. */
  ids: Partial<Record<Tier, string>>
  /** Tiers with no usable id this session: no request is switched to them. */
  unresolved: Set<Tier>
  /** Whether the transcript held answers before this router's first decision; undefined until checked. */
  isResumed?: boolean
}

/** Agents Claude Code ships, for a spawn that arrives without its provider. */
const BUILT_IN = /^(explore|plan|general-purpose|claude|statusline-setup|claude-code-guide)$/i

/** Whether an agent type is one of Claude Code's own rather than a user's or a plugin's. */
const isBuiltIn = (subagentType: string, provider: { plugin: string } | undefined): boolean =>
  provider ? provider.plugin === 'engine' : BUILT_IN.test(subagentType)

const emptyDay = (): Day => ({ turns: {}, down: 0, lifted: 0, heldByCache: 0, spawns: {}, usage: {} })

const tally = (counts: Partial<Record<Tier, number>>): string =>
  (Object.keys(NAME) as Tier[])
    .filter(t => counts[t])
    .map(t => `${NAME[t]} ${counts[t]}`)
    .join(', ') || 'none'

/** Budget running hot: no optional lifts, and down-switches taken more eagerly. */
const effective = (s: State): Config => {
  const isHot = (s.fiveHour ?? 0) >= 80 || (s.sevenDay ?? 0) >= 90
  return isHot ? { ...s.config, lift: 'security', maxSwitchTokens: s.config.maxSwitchTokens * 2 } : s.config
}

async function view($: Engine, s: State, messageCount: number): Promise<CacheView> {
  return {
    now: await $.clock.now(),
    messageCount,
    contextTokens: s.contextTokens,
    marks: s.marks,
    ttlMs: effective(s).cacheTtlMinutes * 60_000,
    isResumed: s.isResumed,
  }
}

/** Whether the main conversation already holds an answer: a resumed or reloaded session. */
async function hasAnswers($: Engine): Promise<boolean> {
  try {
    const messages = await $.session.messages()
    return messages.some(m => m.role === 'assistant')
  } catch {
    return false
  }
}

async function today($: Engine, s: State): Promise<Day> {
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
  s.days[date] ??= emptyDay()
  return s.days[date]
}

async function flush($: Engine, s: State): Promise<void> {
  if (!s.isDirty) return
  const keep = Object.keys(s.days).sort().slice(-KEEP_DAYS)
  s.days = Object.fromEntries(keep.map(d => [d, s.days[d] ?? emptyDay()]))
  await $.store.set(STORE_KEY, s.days)
  await $.store.set(IDS_KEY, s.ids)
  s.isDirty = false
}

/** Remembers a full model id the engine or the API reported. */
function learn(s: State, model: string | undefined): void {
  const tier = tierOf(model)
  if (!tier || !isFullId(model) || s.ids[tier] === model) return
  s.ids[tier] = model.replace(/\[.*\]$/, '')
  s.unresolved.delete(tier)
  s.isDirty = true
}

/** The user's own alias pin for a tier (ANTHROPIC_DEFAULT_<TIER>_MODEL), if any. */
async function pinnedModel($: Engine, tier: Tier): Promise<string | undefined> {
  if (tier === 'haiku') return $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')
  if (tier === 'sonnet') return $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')
  if (tier === 'opus') return $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')
  return $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL')
}

/**
 * The full id a request on `tier` must carry: one seen answering, else the
 * user's ANTHROPIC_DEFAULT_<TIER>_MODEL pin (trusted as given), else the
 * running model's sibling, verified once with a one-token completion.
 * Undefined means the request stays on the model it had: no request is sent
 * on a guessed id.
 */
async function modelId($: Engine, s: State, tier: Tier, running: string): Promise<string | undefined> {
  const known = s.ids[tier]
  if (known) return known
  if (s.unresolved.has(tier)) return undefined

  const pinned = (await pinnedModel($, tier).catch(() => undefined))?.replace(/\[.*\]$/, '')
  if (isFullId(pinned)) {
    learn(s, pinned)
    return pinned
  }
  const candidate = siblingId(tier, running)
  if (!candidate) {
    s.unresolved.add(tier)
    return undefined
  }

  try {
    const probe = await $.model.complete({ model: candidate, prompt: 'Reply with the word ok.', maxTokens: 1, effort: 'low', timeoutMs: 15_000 })
    if (!probe.isAnswered && probe.reason === 'api-error') {
      const isWrongId = probe.status === 404 || probe.status === 400 || probe.error === 'invalid_request'
      if (isWrongId) s.unresolved.add(tier)
      return undefined
    }
    if (!probe.isAnswered && probe.reason === 'aborted') return undefined
  } catch {
    return undefined
  }
  learn(s, candidate)
  return candidate
}

async function count($: Engine, s: State, usage: Usage | null | undefined): Promise<void> {
  if (!usage) return
  const day = await today($, s)
  const row = (day.usage[usage.model] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  row.requests += 1
  row.input += usage.input_tokens
  row.output += usage.output_tokens
  row.cacheRead += usage.cache_read_input_tokens
  row.cacheWrite += usage.cache_creation_input_tokens
  s.isDirty = true
}

function showStatus($: Engine, s: State): void {
  if (s.mode === 'off') {
    $.ui.status(undefined)
    return
  }
  const limits = s.fiveHour === undefined ? '' : ` · 5h ${Math.round(s.fiveHour)}%`
  const where = s.pin ? `${NAME[s.pin]} pinned` : s.last ? `${NAME[s.last.tier]} · ${s.last.route}` : s.mode
  const dry = s.mode === 'advise' ? ' (dry run)' : ''
  $.ui.status(`CR ${where}${dry}${limits}`)
}

/** The session's own model (`/model`), or undefined where the host cannot say. */
async function sessionModel($: Engine): Promise<string | undefined> {
  try {
    return await $.session.model()
  } catch {
    return undefined
  }
}

async function findGpu($: Engine): Promise<boolean> {
  const path = (await $.env.get('PATH')) ?? ''
  for (const dir of path.split(':').filter(Boolean)) {
    if (await $.fs.exists(`${dir}/gpu`).catch(() => false)) return true
  }
  return false
}

async function statusText($: Engine, s: State): Promise<string> {
  await flush($, s).catch(() => undefined)
  const day = await today($, s)
  const home = (await sessionModel($)) || 'unknown'
  const usage = Object.entries(day.usage)
    .map(([model, u]) => `  ${model}: ${u.requests} requests, ${Math.round(u.output / 1000)}k out, ${Math.round(u.cacheWrite / 1000)}k cache writes`)
    .join('\n')
  const limits = [s.fiveHour === undefined ? '' : `5h ${s.fiveHour}%`, s.sevenDay === undefined ? '' : `7d ${s.sevenDay}%`]
    .filter(Boolean)
    .join(', ')
  return [
    `Claude Router v4 · mode ${s.mode}${s.pin ? ` · pinned ${NAME[s.pin]}` : ''} · session model ${home}`,
    `Last turn: ${s.last ? `${NAME[s.last.tier]} (${s.last.reason})` : 'none yet'}`,
    `Limits: ${limits || 'not reported yet'} · GPU tier: ${s.hasGpu ? 'on' : 'no gpu command'}`,
    `Today: main turns ${tally(day.turns)} · ${day.down} down, ${day.lifted} lifted, ${day.heldByCache} held by cache · subagents sent down: ${tally(day.spawns)}`,
    usage ? `Requests by model today:\n${usage}` : 'No requests counted today.',
    'Commands: /cr full | subagents | dry | off | pin <model> | unpin',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const s: State = {
    config,
    mode: config.mode,
    hasGpu: false,
    contextTokens: 0,
    marks: {},
    origins: new Map(),
    turns: new Map(),
    days: {},
    isDirty: false,
    ids: {},
    unresolved: new Set(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    s.hasGpu = await findGpu($).catch(() => false)
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    s.days = stored && typeof stored === 'object' ? (stored as Record<string, Day>) : {}
    const ids = await $.store.get(IDS_KEY).catch(() => undefined)
    s.ids = ids && typeof ids === 'object' ? (ids as Partial<Record<Tier, string>>) : {}
    await $.command.register({
      name: 'cr',
      description: 'Claude Router: status, or full | subagents | dry | off | pin <opus|sonnet|haiku> | unpin',
      argumentHint: '[full|subagents|dry|off|pin <model>|unpin]',
      immediate: true,
    })
    showStatus($, s)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.context.tokens !== undefined) s.contextTokens = e.context.tokens
    for (const limit of e.rateLimits) {
      if (limit.kind === 'five_hour') s.fiveHour = limit.percentUsed
      if (limit.kind === 'seven_day') s.sevenDay = limit.percentUsed
    }
    if (e.changed.includes('rateLimits')) showStatus($, s)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    s.origins.set(e.text, e.origin.kind)
    if (s.mode === 'off' || s.pin || !TYPED.has(e.origin.kind)) return next(e)

    const c = classify(e.text, { gpu: s.hasGpu })
    const context: string[] = []
    if (c.route === 'gpu') context.push(GPU_CONTEXT)

    if (c.route === 'deep' && (s.mode === 'full' || s.mode === 'advise')) {
      const home = tierOf(await sessionModel($))
      if (home) {
        const decision = decideMain(c, home, s.current ?? home, s.previous, await view($, s, 0), effective(s))
        if (decision.hint) context.push(`[Claude Router] ${decision.hint}`)
      }
    }
    return context.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  })

  on('turn.start', async ($, e, next) => {
    const origin = s.origins.get(e.text) ?? (e.text === '' ? 'continuation' : 'composer')
    s.origins.delete(e.text)
    s.turns.set(e.turnId, { c: TYPED.has(origin) ? classify(e.text, { gpu: s.hasGpu }) : SKIP })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    learn(s, e.model)

    // Subagent steps were placed at spawn; here they are only counted.
    if (e.agentId !== undefined || s.mode === 'off' || s.mode === 'subagents') {
      const result = yield* next(e)
      learn(s, result.usage?.model)
      await count($, s, result.usage)
      return result
    }

    const running = tierOf(e.model)
    const home = tierOf(await sessionModel($)) ?? running
    const turn = s.turns.get(e.turnId) ?? { c: SKIP }

    if (running && home && turn.tier === undefined) {
      if (s.isResumed === undefined && Object.keys(s.marks).length === 0) s.isResumed = await hasAnswers($)
      // Decided once, at the turn's first request: switching inside a turn
      // would rewrite the cache inside the turn.
      const decision = s.pin
        ? { tier: s.pin, reason: 'pinned' }
        : decideMain(turn.c, home, s.current ?? running, s.previous, await view($, s, e.messageCount), effective(s))
      const wants = s.mode === 'full' || s.pin ? decision.tier : running
      const isReachable = wants === running || (await modelId($, s, wants, e.model)) !== undefined
      turn.tier = isReachable ? wants : running
      s.turns.set(e.turnId, turn)

      const route = turn.c.route === 'skip' ? s.previous ?? 'standard' : turn.c.route
      const reason = isReachable ? decision.reason : `${decision.reason}, no verified ${NAME[wants]} id: stayed`
      s.last = { tier: s.mode === 'advise' ? decision.tier : turn.tier, reason, route }
      if (s.mode === 'full' || s.pin) {
        const day = await today($, s)
        day.turns[turn.tier] = (day.turns[turn.tier] ?? 0) + 1
        if (RANK[turn.tier] < RANK[home]) day.down += 1
        if (RANK[turn.tier] > RANK[home]) day.lifted += 1
        if (decision.reason.includes('stayed')) day.heldByCache += 1
        s.isDirty = true
      }
      showStatus($, s)
    }

    const id = turn.tier && turn.tier !== running ? s.ids[turn.tier] : undefined
    const step = id ? { ...e, model: id } : e
    const result = yield* next(step)

    learn(s, result.usage?.model)
    const answered = tierOf(result.usage?.model) ?? tierOf(step.model)
    if (answered) {
      s.current = answered
      s.marks[answered] = { at: await $.clock.now(), messageCount: e.messageCount }
    }
    if (result.usage) {
      const u = result.usage
      s.contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    }
    await count($, s, result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const turn = s.turns.get(e.turnId)
      if (turn && turn.c.route !== 'skip') {
        s.previous = turn.c.followUp && s.previous === 'deep' ? 'deep' : turn.c.route
      }
      s.turns.delete(e.turnId)
      await flush($, s)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (s.mode === 'off' || s.mode === 'advise' || e.model !== undefined || e.fork || e.isTeammate || e.workflow) {
      return next(e)
    }
    const c = classify(`${e.description}\n${e.prompt}`, { gpu: false })
    const tier = decideSpawn(
      c,
      { subagentType: e.subagentType, isBuiltIn: isBuiltIn(e.subagentType, e.provider), parent: tierOf(e.parentModel) },
      effective(s),
    )
    if (!tier) return next(e)

    const result = await next({ ...e, model: ALIAS[tier] })
    learn(s, result.model)
    if (result.deny === undefined) {
      const day = await today($, s)
      day.spawns[tier] = (day.spawns[tier] ?? 0) + 1
      s.isDirty = true
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    await flush($, s).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'cr' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === 'pin') {
      const tier = tierOf(arg)
      if (!tier) return { text: 'Usage: /cr pin <opus|sonnet|haiku|fable>' }
      s.pin = tier
      showStatus($, s)
      return { text: `Claude Router: main loop pinned to ${NAME[tier]} for this session. /cr unpin to route again.` }
    }
    if (verb === 'unpin') {
      s.pin = undefined
      showStatus($, s)
      return { text: 'Claude Router: unpinned, routing again.' }
    }
    const asked = verb === 'dry' ? 'advise' : verb === 'on' ? 'full' : verb
    if ((MODES as readonly string[]).includes(asked)) {
      s.mode = asked as Config['mode']
      showStatus($, s)
      return { text: `Claude Router: mode ${s.mode} for this session.` }
    }
    return { text: await statusText($, s) }
  })
}
