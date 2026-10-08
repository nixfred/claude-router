import type { AgentSpawnInput, On, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'
import { describe, expect, mock, test, type TestBody } from 'claude-code/testing'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

/** Engine stand-ins beneath the mod: record what model each request named. */
const bottom = (
  on: On,
  usage: (e: TurnStepInput) => TurnUsage | null = () => null,
  env: Record<string, string> = { ANTHROPIC_DEFAULT_SONNET_MODEL: SONNET },
) => {
  const steps: { model: string; agentId?: string }[] = []
  const spawns: (string | undefined)[] = []
  mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e): AsyncGenerator<never, TurnStepResult> {
    steps.push({ model: e.model, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(e) }
  })
  on('agent.spawn', ($, e) => {
    spawns.push(e.model)
    return { model: e.model ?? 'inherit', agentId: 'a1' }
  })
  return { steps, spawns }
}

const drain = async <C, R>(stream: AsyncGenerator<C, R> & { result: Promise<R> }): Promise<R> => {
  for await (const _ of stream) {
    // chunks are not under test
  }
  return stream.result
}

const turn = async ($: Parameters<TestBody>[0], turnId: string, text: string, step: Partial<TurnStepInput> = {}) => {
  await $.turn.start({ turnId, text })
  await drain($.turn.step({ turnId, index: 0, model: OPUS, messageCount: 4, ...step }))
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

describe('main loop', () => {
  test('a standard turn on Opus runs on Sonnet, by full id', async ($, on) => {
    const { steps } = bottom(on)
    await turn($, 't1', 'fix the null check in parser.ts')
    expect(steps[0]?.model).toBe(SONNET)
  })

  test('an id learned from a subagent answer is used without a pin', async ($, on) => {
    const usage = (e: TurnStepInput): TurnUsage => ({ model: e.agentId ? SONNET : OPUS, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    const { steps } = bottom(on, usage, {})
    await $.turn.start({ turnId: 'sub', text: '' })
    await drain($.turn.step({ turnId: 'sub', index: 0, model: SONNET, messageCount: 1, agentId: 'a1' }))
    await turn($, 't1', 'fix the null check in parser.ts')
    expect(steps.map(s => s.model)).toEqual([SONNET, SONNET])
  })

  test('with no verified id the turn stays where it was', async ($, on) => {
    const { steps } = bottom(on, () => null, {})
    await turn($, 't1', 'fix the null check in parser.ts')
    expect(steps[0]?.model).toBe(OPUS)
  })

  test('a security turn stays on the session model', async ($, on) => {
    const { steps } = bottom(on)
    await turn($, 't1', 'audit the login flow for exploits')
    expect(steps[0]?.model).toBe(OPUS)
  })

  test('a follow-up to a deep turn stays deep', async ($, on) => {
    const { steps } = bottom(on)
    await turn($, 't1', 'compare the trade-offs of this architecture')
    await turn($, 't2', 'yes, go ahead', { messageCount: 6 })
    expect(steps.map(s => s.model)).toEqual([OPUS, OPUS])
  })

  test('every step of a turn keeps the turn decision', async ($, on) => {
    const { steps } = bottom(on)
    await $.turn.start({ turnId: 't1', text: 'fix the null check in parser.ts' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 4 }))
    await drain($.turn.step({ turnId: 't1', index: 1, model: OPUS, messageCount: 6 }))
    expect(steps.map(s => s.model)).toEqual([SONNET, SONNET])
  })

  test('a large warm Opus cache holds the switch', async ($, on) => {
    const usage = (e: TurnStepInput): TurnUsage => ({
      model: e.model,
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 250_000,
      cache_creation_input_tokens: 500,
    })
    const { steps } = bottom(on, usage)
    await turn($, 't1', 'audit the login flow for exploits', { messageCount: 40 })
    await turn($, 't2', 'fix the null check in parser.ts', { messageCount: 42 })
    expect(steps.map(s => s.model)).toEqual([OPUS, OPUS])
  })

  test('subagent steps are not rewritten', async ($, on) => {
    const { steps } = bottom(on)
    await $.turn.start({ turnId: 't1', text: 'fix the null check in parser.ts' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 2, agentId: 'a9' }))
    expect(steps[0]).toEqual({ model: OPUS, agentId: 'a9' })
  })

  test('mode=subagents leaves the main loop alone', { options: { mode: 'subagents' } }, async ($, on) => {
    const { steps } = bottom(on)
    await turn($, 't1', 'fix the null check in parser.ts')
    expect(steps[0]?.model).toBe(OPUS)
  })
})

const spawn = (over: Partial<AgentSpawnInput>): AgentSpawnInput => ({
  tool_use_id: 'tu1',
  prompt: 'look around the auth module',
  description: 'Explore auth',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: OPUS,
  background: false,
  fork: false,
  ...over,
})

describe('subagents', () => {
  test('Explore without a model goes to Haiku', async ($, on) => {
    const { spawns } = bottom(on)
    await $.agent.spawn(spawn({}))
    expect(spawns).toEqual(['haiku'])
  })

  test('an explicit model is respected', async ($, on) => {
    const { spawns } = bottom(on)
    await $.agent.spawn(spawn({ model: 'opus' }))
    expect(spawns).toEqual(['opus'])
  })
})
