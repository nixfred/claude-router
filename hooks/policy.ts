// Claude Router v4 - routing policy.
//
// Pure functions, no `$`. They decide which model a main-loop turn and a
// subagent spawn run on: the lowest tier that does the job, lifted for deep
// and security work, and never a switch whose prompt-cache rewrite costs more
// than it saves.

import type { Classification, Route } from './classify'

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

export const NAME: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

/** The family a model id or alias belongs to; undefined for one we cannot place. */
export const tierOf = (model: string | undefined): Tier | undefined => {
  const m = (model ?? '').toLowerCase()
  if (/fable|mythos|\bbest\b/.test(m)) return 'fable'
  if (/opus/.test(m)) return 'opus'
  if (/sonnet/.test(m)) return 'sonnet'
  if (/haiku/.test(m)) return 'haiku'
  return undefined
}

/** Whether a model name is a full API id (what a request must carry) rather than an alias. */
export const isFullId = (model: string | undefined): model is string => /^claude-[a-z]+-\d/.test(model ?? '')

/**
 * A model id of `tier` from the same generation as `from`: `claude-opus-5-5`
 * or "Opus 5.5" gives `claude-sonnet-5-5` for sonnet. A guess: the caller
 * verifies it before any request carries it.
 */
export const siblingId = (tier: Tier, from: string | undefined): string | undefined => {
  const name = (from ?? '').toLowerCase()
  const id = /^claude-(?:opus|sonnet|haiku|fable)-(\d+(?:-\d+)?)(?:-\d{8})?(?:\[.*\])?$/.exec(name)
  const shown = /(?:opus|sonnet|haiku|fable)\s+(\d+)(?:\.(\d+))?/.exec(name)
  const version = id ? id[1] : shown ? (shown[2] ? `${shown[1]}-${shown[2]}` : shown[1]) : undefined
  return version ? `claude-${tier}-${version}` : undefined
}

/** Past this much context the main loop is not dropped to Haiku, whose window may be smaller. */
export const HAIKU_MAX_CONTEXT = 150_000

export type Config = {
  /** full: main loop + subagents; subagents: spawns only; advise: dry run, shows what it would do; off. */
  mode: 'full' | 'subagents' | 'advise' | 'off'
  /** The lowest tier the main loop may drop to ('sonnet' unless opted into haiku). */
  mainFloor: Tier
  /** Which deep turns lift a cheaper main loop to Opus on their own. */
  lift: 'security' | 'deep' | 'off'
  /** A down-switch whose extra cache rewrite exceeds this many tokens is skipped. */
  maxSwitchTokens: number
  /** How long a model's prompt cache is assumed to stay warm. */
  cacheTtlMinutes: number
  /** Route agents that come from a plugin or the user's own agent files too. */
  routeCustomAgents: boolean
}

export const DEFAULTS: Config = {
  mode: 'full',
  mainFloor: 'sonnet',
  lift: 'security',
  maxSwitchTokens: 60_000,
  cacheTtlMinutes: 60,
  routeCustomAgents: false,
}

/** Where a model's prompt cache stood after the last main-loop request on it. */
export type CacheMark = { at: number; messageCount: number }

export type CacheView = {
  now: number
  messageCount: number
  /** Input tokens of the last main-loop request: the prefix a cold model rewrites. */
  contextTokens: number
  marks: Partial<Record<Tier, CacheMark>>
  ttlMs: number
}

/**
 * Tokens a request on `tier` would have to write to the cache now: the part
 * of the conversation added since that model last ran, or all of it when its
 * cache has lapsed, never existed, or the prefix changed (a compaction).
 */
export const recacheTokens = (tier: Tier, view: CacheView): number => {
  const mark = view.marks[tier]
  const isWarm = mark !== undefined && view.now - mark.at < view.ttlMs && view.messageCount >= mark.messageCount
  if (!isWarm) return view.contextTokens
  const added = view.messageCount - mark.messageCount
  return Math.round((view.contextTokens * added) / Math.max(1, view.messageCount))
}

/** What switching from `current` to `target` costs beyond staying put. */
export const extraSwitchTokens = (current: Tier, target: Tier, view: CacheView): number =>
  Math.max(0, recacheTokens(target, view) - recacheTokens(current, view))

export type MainDecision = {
  /** The tier the turn runs on. */
  tier: Tier
  /** Why, in a few words, for the status line and /cr. */
  reason: string
  /** A one-line hint for the model (the turn is Opus-grade but was not lifted). */
  hint?: string
}

const DOWN: Partial<Record<Route, 'floor' | 'sonnet'>> = {
  standard: 'sonnet',
  gpu: 'sonnet',
  lookup: 'floor',
  fast: 'floor',
}

/**
 * The main loop's tier for one turn.
 *
 * `home` is what the session runs on (`/model`); `current` is what the last
 * main-loop request ran on. Lifts ignore cache cost (the job needs the model);
 * down-switches are taken only when the cache rewrite they force is small.
 * Mode is the caller's business: this says what the turn should run on.
 */
export const decideMain = (
  c: Classification,
  home: Tier,
  current: Tier,
  previous: Route | undefined,
  view: CacheView,
  config: Config,
): MainDecision => {
  // A slash command or an empty continuation keeps whatever is running.
  if (c.route === 'skip') return { tier: current, reason: 'command' }
  if (home === 'haiku') return { tier: home, reason: 'home is Haiku' }

  // A follow-up ("yes", "go ahead", "and also") keeps a deep turn deep.
  const route: Route = c.followUp && previous === 'deep' ? 'deep' : c.route

  if (route === 'deep') {
    if (RANK[home] >= RANK.opus) return { tier: home, reason: c.security ? 'security' : 'deep' }
    const lifts = config.lift === 'deep' || (config.lift === 'security' && c.security)
    if (lifts) return { tier: 'opus', reason: c.security ? 'security lift' : 'deep lift' }
    return {
      tier: home,
      reason: 'deep, not lifted',
      hint: `This looks Opus-grade (${c.signals.join(', ')}) and the main loop is ${NAME[home]}. Say so in one line and suggest \`/model opus\`; carry on unless the user switches.`,
    }
  }

  const kind = DOWN[route] ?? 'sonnet'
  const haikuFits = view.contextTokens <= HAIKU_MAX_CONTEXT
  const floor = kind === 'floor' && RANK[config.mainFloor] < RANK.sonnet && haikuFits ? config.mainFloor : 'sonnet'
  const target: Tier = RANK[floor] < RANK[home] ? floor : home
  if (target === current) return { tier: target, reason: route }

  if (RANK[target] < RANK[current]) {
    const extra = extraSwitchTokens(current, target, view)
    if (extra > config.maxSwitchTokens) {
      return { tier: current, reason: `${route}, stayed (switch would rewrite ${Math.round(extra / 1000)}k cached tokens)` }
    }
  }
  return { tier: target, reason: route }
}

export type SpawnFacts = {
  subagentType: string
  isBuiltIn: boolean
  parent: Tier | undefined
}

/** Agent types whose work is deep by definition: never sent down a tier. */
const DEEP_AGENT = /pentest|security|architect|algorithm|^plan$/i

/** Built-in agents that already pick a model of their own, or need the parent's. */
const LEAVE_BUILT_IN = /^(plan|statusline-setup|claude-code-guide|fork)$/i

/**
 * The model a subagent spawned without an explicit `model` should run on, or
 * undefined to leave the engine's own choice (the definition, then the parent).
 * Only ever lowers the tier below the parent's.
 */
export const decideSpawn = (c: Classification, facts: SpawnFacts, config: Config): Tier | undefined => {
  if (config.mode === 'off' || config.mode === 'advise') return undefined
  if (!facts.isBuiltIn && !config.routeCustomAgents) return undefined
  if (DEEP_AGENT.test(facts.subagentType) || (facts.isBuiltIn && LEAVE_BUILT_IN.test(facts.subagentType))) return undefined
  if (c.route === 'deep') return undefined

  const isExplore = /^explore$/i.test(facts.subagentType)
  const target: Tier = isExplore || c.route === 'lookup' || c.route === 'fast' ? 'haiku' : 'sonnet'
  const parent = facts.parent ?? 'opus'
  return RANK[target] < RANK[parent] ? target : undefined
}

/** Reads the manifest's userConfig values over the defaults, ignoring junk. */
export const readConfig = (options: Readonly<Record<string, unknown>>): Config => {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  return {
    mode: pick(options.mode, ['full', 'subagents', 'advise', 'off'], DEFAULTS.mode),
    mainFloor: pick(options.mainFloor, ['haiku', 'sonnet'], DEFAULTS.mainFloor),
    lift: pick(options.lift, ['security', 'deep', 'off'], DEFAULTS.lift),
    maxSwitchTokens: number(options.maxSwitchTokens, DEFAULTS.maxSwitchTokens),
    cacheTtlMinutes: number(options.cacheTtlMinutes, DEFAULTS.cacheTtlMinutes),
    routeCustomAgents: typeof options.routeCustomAgents === 'boolean' ? options.routeCustomAgents : DEFAULTS.routeCustomAgents,
  }
}
