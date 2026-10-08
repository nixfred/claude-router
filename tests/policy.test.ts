import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'
import { decideMain, decideSpawn, DEFAULTS, isFullId, readConfig, recacheTokens, siblingId, tierOf, type CacheView } from '../hooks/policy'

const MIN = 60_000
const cold = (contextTokens = 0, messageCount = 10): CacheView => ({ now: 100 * MIN, messageCount, contextTokens, marks: {}, ttlMs: 60 * MIN })
const c = (text: string, gpu = false) => classify(text, { gpu })

describe('classify', () => {
  test('one security word is deep and never demoted', () => {
    const r = c('check this endpoint for a vulnerability')
    expect(r.route).toBe('deep')
    expect(r.security).toBe(true)
  })

  test('one plain deep word is standard; two are deep', () => {
    expect(c('compare the two loops').route).toBe('standard')
    expect(c('compare the trade-offs of this architecture').route).toBe('deep')
  })

  test('lookups, quick questions and the default', () => {
    expect(c('where is parseConfig defined in this repo').route).toBe('lookup')
    expect(c('what is a closure?').route).toBe('fast')
    expect(c('fix the null check in parser.ts').route).toBe('standard')
  })

  test('the GPU tier needs the gpu command and a subject', () => {
    expect(c('summarize this log file', true).route).toBe('gpu')
    expect(c('summarize this log file', false).route).not.toBe('gpu')
    expect(c('summarize', true).route).not.toBe('gpu')
  })

  test('slash commands and empty continuations are left alone', () => {
    expect(c('/review this').route).toBe('skip')
    expect(c('').route).toBe('skip')
  })

  test('follow-ups are recognised', () => {
    expect(c('yes, do it').followUp).toBe(true)
    expect(c('go ahead').followUp).toBe(true)
    expect(c('rewrite the parser').followUp).toBe(false)
  })
})

describe('tierOf', () => {
  test('names families from ids, aliases and display names', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('Sonnet 5.5')).toBe('sonnet')
    expect(tierOf('claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('claude-fable-5-1')).toBe('fable')
    expect(tierOf('opusplan')).toBe('opus')
    expect(tierOf('gpt-9')).toBe(undefined)
  })
})

describe('recacheTokens', () => {
  test('a cold model rewrites everything, a warm one only what was added', () => {
    const view: CacheView = { ...cold(100_000, 20), marks: { opus: { at: 99 * MIN, messageCount: 18 } } }
    expect(recacheTokens('sonnet', view)).toBe(100_000)
    expect(recacheTokens('opus', view)).toBe(10_000)
  })

  test('a lapsed TTL or a shorter conversation (compaction) is cold', () => {
    const lapsed: CacheView = { ...cold(100_000, 20), marks: { opus: { at: 10 * MIN, messageCount: 18 } } }
    const compacted: CacheView = { ...cold(100_000, 4), marks: { opus: { at: 99 * MIN, messageCount: 18 } } }
    expect(recacheTokens('opus', lapsed)).toBe(100_000)
    expect(recacheTokens('opus', compacted)).toBe(100_000)
  })
})

describe('decideMain', () => {
  test('standard work drops an Opus session to Sonnet when the switch is cheap', () => {
    expect(decideMain(c('fix the null check in parser.ts'), 'opus', 'opus', undefined, cold(), DEFAULTS).tier).toBe('sonnet')
  })

  test('deep and security work stays on Opus', () => {
    expect(decideMain(c('audit this auth flow for exploits'), 'opus', 'sonnet', undefined, cold(), DEFAULTS).tier).toBe('opus')
  })

  test('a follow-up to a deep turn stays deep', () => {
    expect(decideMain(c('yes, go ahead'), 'opus', 'opus', 'deep', cold(), DEFAULTS).tier).toBe('opus')
  })

  test('a switch that would rewrite a large cache is held', () => {
    const view: CacheView = { ...cold(300_000, 40), marks: { opus: { at: 99 * MIN, messageCount: 38 } } }
    const d = decideMain(c('fix the null check in parser.ts'), 'opus', 'opus', undefined, view, DEFAULTS)
    expect(d.tier).toBe('opus')
    expect(d.reason).toContain('stayed')
  })

  test('a resumed conversation with no numbers yet stays put for one turn', () => {
    const resumed: CacheView = { ...cold(0, 30), isResumed: true }
    const d = decideMain(c('fix the null check in parser.ts'), 'opus', 'opus', undefined, resumed, DEFAULTS)
    expect(d.tier).toBe('opus')
    expect(d.reason).toContain('measuring')
    expect(decideMain(c('fix the null check in parser.ts'), 'opus', 'opus', undefined, cold(0, 30), DEFAULTS).tier).toBe('sonnet')
  })

  test('the switch back to a warm Sonnet cache is cheap again', () => {
    const view: CacheView = {
      ...cold(300_000, 40),
      marks: { opus: { at: 99 * MIN, messageCount: 38 }, sonnet: { at: 98 * MIN, messageCount: 36 } },
    }
    expect(decideMain(c('fix the null check in parser.ts'), 'opus', 'opus', 'deep', view, DEFAULTS).tier).toBe('sonnet')
  })

  test('security lifts a Sonnet session to Opus; other deep work only gets a hint', () => {
    expect(decideMain(c('audit this auth flow for exploits'), 'sonnet', 'sonnet', undefined, cold(), DEFAULTS).tier).toBe('opus')
    const d = decideMain(c('compare the trade-offs of this architecture'), 'sonnet', 'sonnet', undefined, cold(), DEFAULTS)
    expect(d.tier).toBe('sonnet')
    expect(d.hint).toContain('/model opus')
  })

  test('lift=deep lifts every deep turn', () => {
    const config = { ...DEFAULTS, lift: 'deep' as const }
    expect(decideMain(c('compare the trade-offs of this architecture'), 'sonnet', 'sonnet', undefined, cold(), config).tier).toBe('opus')
  })

  test('the main loop never drops below Sonnet unless the floor allows Haiku', () => {
    expect(decideMain(c('what is a closure?'), 'opus', 'opus', undefined, cold(), DEFAULTS).tier).toBe('sonnet')
    const config = { ...DEFAULTS, mainFloor: 'haiku' as const }
    expect(decideMain(c('what is a closure?'), 'opus', 'opus', undefined, cold(), config).tier).toBe('haiku')
  })

  test('slash commands keep whatever is running', () => {
    expect(decideMain(c('/review'), 'opus', 'sonnet', 'standard', cold(), DEFAULTS).tier).toBe('sonnet')
  })
})

describe('decideSpawn', () => {
  const builtIn = (subagentType: string, parent: 'opus' | 'sonnet' = 'opus') => ({ subagentType, isBuiltIn: true, parent })

  test('Explore and lookups go to Haiku, other work to Sonnet', () => {
    expect(decideSpawn(c('look around the auth module'), builtIn('Explore'), DEFAULTS)).toBe('haiku')
    expect(decideSpawn(c('find all callers of parseConfig'), builtIn('general-purpose'), DEFAULTS)).toBe('haiku')
    expect(decideSpawn(c('implement the retry wrapper in net.ts'), builtIn('general-purpose'), DEFAULTS)).toBe('sonnet')
  })

  test('deep prompts, deep agent types and Plan are left alone', () => {
    expect(decideSpawn(c('audit the token handling for exploits'), builtIn('general-purpose'), DEFAULTS)).toBe(undefined)
    expect(decideSpawn(c('scan the repo'), builtIn('Plan'), DEFAULTS)).toBe(undefined)
    expect(decideSpawn(c('scan the repo'), { subagentType: 'Pentester', isBuiltIn: false, parent: 'opus' }, { ...DEFAULTS, routeCustomAgents: true })).toBe(undefined)
  })

  test('custom agents are routed only when asked', () => {
    const custom = { subagentType: 'Engineer', isBuiltIn: false, parent: 'opus' as const }
    expect(decideSpawn(c('implement the retry wrapper'), custom, DEFAULTS)).toBe(undefined)
    expect(decideSpawn(c('implement the retry wrapper'), custom, { ...DEFAULTS, routeCustomAgents: true })).toBe('sonnet')
  })

  test('never routes up or sideways', () => {
    expect(decideSpawn(c('implement the retry wrapper'), builtIn('general-purpose', 'sonnet'), DEFAULTS)).toBe(undefined)
  })
})

describe('readConfig', () => {
  test('fills defaults and ignores junk', () => {
    expect(readConfig({})).toEqual(DEFAULTS)
    expect(readConfig({ mode: 'turbo', maxSwitchTokens: -5, lift: 'deep' })).toEqual({ ...DEFAULTS, lift: 'deep' })
  })
})

describe('model ids', () => {
  test('siblings come from ids and display names of the same generation', () => {
    expect(siblingId('sonnet', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(siblingId('haiku', 'Opus 5.5')).toBe('claude-haiku-5-5')
    expect(siblingId('sonnet', 'claude-opus-4-8[1m]')).toBe('claude-sonnet-4-8')
    expect(siblingId('sonnet', 'opus')).toBe(undefined)
    expect(isFullId('claude-sonnet-5-5')).toBe(true)
    expect(isFullId('sonnet')).toBe(false)
  })
})
