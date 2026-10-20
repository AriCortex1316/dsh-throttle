/**
 * Unit tests for the `/throttle` plugin.
 *
 * Run from the plugin's parent directory (no Harness runtime needed):
 *
 *     node --test dsh-throttle/test/throttle.test.mjs
 *
 * 插件核心保持纯 Node 可加载，schema 外部依赖通过动态导入降级。
 * These tests exercise the real registration, projection, command, guard, prompt-section, context, and
 * per-agent request paths through a fake Cordis context that models the
 * Harness's own behaviour closely enough to be meaningful: commands append
 * `command/run` before the handler and `command/done` after it, the session is
 * pinned with its original permission preset at publish time, a late-registered
 * projection folds the whole existing log, and the runtime-context snapshot is
 * replaced in place rather than appended.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { apply, inject, name } from '../index.js'
import {
  applyThrottleEvent,
  ceilingState,
  createThrottleProjection,
  EMPTY_THROTTLE_STATE,
  emptyUsage,
  guardDecision,
  limitsFor,
  modeOfState,
  nextMode,
  observeSessionEvent,
  observeStep,
  parseThrottleState,
  permissionPhrase,
  policySection,
  throttleView,
  receiptText,
  resolveConfig,
  restoreTarget,
  stateContext,
  statusLine,
  SURRENDER_TEMPLATE,
  STANDING_RULES
} from '../state.js'

const here = dirname(fileURLToPath(import.meta.url))
/** A non-zero clock reading, so a real timestamp is never mistaken for "no turn". */
const T0 = 1_000_000

/**
 * A fake Cordis context capturing every registration the plugin makes.
 * @param options - fake service behaviour.
 * @returns the context, the captured registrations, and test helpers.
 */
function fakeCtx (options = {}) {
  const presets = options.presets ?? ['read-only', 'workspace-write', 'danger-full-access']
  const captured = { commands: [], sections: [], contexts: [], guards: [], events: new Map(), effects: [], warnings: [] }
  const session = { header: { id: options.sessionId ?? 'session-1' } }
  const presetOf = new Map()
  const idOf = (target) => String(target.header.id)

  // ── the projection registry ────────────────────────────────────────────────
  const registry = {
    def: null,
    logs: new Map(),
    cache: new Map(),
    folded: new Map(),
    register (definition) {
      registry.def = definition
      registry.cache.clear()
      registry.folded.clear()
      return () => { registry.def = null }
    },
    append (target, event) {
      const id = idOf(target)
      const log = registry.logs.get(id) ?? []
      log.push(event)
      registry.logs.set(id, log)
    },
    stateOf (target, key) {
      if (registry.def === null || key !== registry.def.key) return undefined
      const id = idOf(target)
      const log = registry.logs.get(id) ?? []
      let state = registry.cache.get(id)
      let folded = registry.folded.get(id) ?? 0
      if (state === undefined) {
        state = registry.def.init()
        folded = 0
      }
      for (let index = folded; index < log.length; index += 1) state = registry.def.apply(state, log[index])
      registry.cache.set(id, state)
      registry.folded.set(id, log.length)
      return state
    }
  }

  // The Harness pins a permission preset when a session is published.
  for (const event of options.log ?? []) registry.append(session, event)
  if (options.log === undefined && options.pin !== false) {
    registry.append(session, { type: 'permission/preset', data: { preset: options.preset ?? 'workspace-write' } })
  }

  const service = {
    names: presets,
    // Per session, so a sub-session can hold a different preset from the
    // session that delegated to it — the shape the real service derives from
    // each session's own log.
    current: (target) => presetOf.get(target) ?? options.preset ?? 'workspace-write',
    set: (target, next) => {
      if (!presets.includes(next)) throw new Error(`permission: unknown preset "${next}"`)
      if (service.current(target) !== next) registry.append(target, { type: 'permission/preset', data: { preset: next } })
      presetOf.set(target, next)
    }
  }
  // The single-session tests read and hand-move `service.preset`; moving it here
  // deliberately writes no log event, so a test that models the Harness's own
  // append does it itself (see the "remembers a preset" test).
  Object.defineProperty(service, 'preset', {
    get: () => service.current(session),
    set: (next) => { presetOf.set(session, next) },
    enumerable: true
  })
  const llm = options.llm === false
    ? undefined
    : { resolveModelInfo: options.resolveModelInfo ?? (async () => options.modelInfo ?? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }) }

  const ctx = {
    logger: { info () {}, warn (...args) { captured.warnings.push(args.map(String).join(' ')) } },
    systemPrompt: {
      section: (section) => { captured.sections.push(section); return () => {} },
      context: (entry) => { captured.contexts.push(entry); return () => {} },
      // The first-party allocation table's `SANDBOX_POLICY` slot.
      getContextOrder: (slot) => (slot === 'SANDBOX_POLICY' ? 110 : undefined)
    },
    commands: { register: (definition) => { captured.commands.push(definition); return () => {} } },
    tools: { guard: (guard) => { captured.guards.push(guard); return () => {} } },
    sessionProjections: registry,
    on: (event, listener) => {
      const list = captured.events.get(event) ?? []
      list.push(listener)
      captured.events.set(event, list)
      return () => {}
    },
    effect: (factory) => { captured.effects.push(factory) },
    get: (key) => {
      if (key === 'permissionPresets') return options.permissions === false ? undefined : service
      if (key === 'llm') return llm
      // The agent service a sub-session's tier inheritance resolves through.
      if (key === 'agents') return options.agents
      return undefined
    }
  }

  const emit = async (event, payload) => {
    for (const listener of captured.events.get(event) ?? []) {
      await listener(payload, async () => ({ kind: 'continue', messages: [] }))
    }
  }

  /** Run one `/throttle` invocation through the command pipeline's event order. */
  let counter = 0
  const throttle = (agent, rawInput, attachments = []) => {
    const commandId = `cmd-test-${++counter}`
    registry.append(agent.session, { type: 'command/run', data: { commandId, name: 'throttle', args: rawInput, source: { kind: 'user' } } })
    const [command] = captured.commands
    const result = command.handler({ agent, rawInput, attachments, signal: new AbortController().signal, commandId })
    registry.append(agent.session, { type: 'command/done', data: { commandId, kind: result.kind === 'success' ? 'success' : 'error', text: result.text } })
    return result
  }

  return { ctx, captured, service, session, registry, emit, throttle, appendEvent }

  /**
   * Commit one event the way the Harness does: durable log first, then the
   * synchronous `session/event` broadcast the plugin folds turn boundaries from.
   * @param target - the session the event belongs to.
   * @param event - the event to append.
   */
  function appendEvent (target, event) {
    const committed = { time: Date.now(), ...event }
    registry.append(target, committed)
    for (const listener of captured.events.get('session/event') ?? []) listener(target, committed)
    return committed
  }
}

/** A config block that mirrors the shipped `cordis.patch.yml`. */
const SHIPPED = {
  default: { steps: 4, minutes: 2, effort: 'low', permission: 'read-only' },
  deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' }
}

/** Bind and return the plugin's per-agent request listener. */
async function bindAgent (harness, session = harness.session) {
  const bound = {}
  const agent = {
    session,
    ctx: { on: (event, listener, options) => { Object.assign(bound, { event, listener, options }); return () => {} } }
  }
  await harness.emit('agent/created', { agent })
  const signal = new AbortController().signal
  bound.ask = (seed) => bound.listener({ turn: 1, step: 1, signal }, async () => seed)
  return { agent, bound }
}

test('plugin identity and required services', () => {
  assert.equal(name, 'dsh-throttle')
  assert.deepEqual(inject, ['commands', 'systemPrompt', 'tools', 'sessionProjections'])
})

test('config: shipped values are accepted and the deep floor is enforced', () => {
  const config = resolveConfig(SHIPPED)
  assert.deepEqual(limitsFor(config, 'default'), { kind: 'steps', max: 4, minutes: 2, effort: 'low' })
  assert.deepEqual(limitsFor(config, 'deep'), { kind: 'steps', max: 5, minutes: 5, effort: 'high' })

  // PLAN 8.7: deep.steps: 3 must fail plugin load rather than be clamped.
  assert.throws(() => resolveConfig({ deep: { steps: 3 } }), /config\.deep\.steps must be >= 5/)
  assert.throws(() => resolveConfig({ deep: { minutes: 4 } }), /config\.deep\.minutes must be >= 5/)
  assert.throws(() => resolveConfig({ default: { steps: 0 } }), /config\.default\.steps must be >= 1/)
  assert.throws(() => resolveConfig({ default: { minute: 2 } }), /unknown key\(s\) minute/)
  assert.throws(() => resolveConfig({ deep: { steps: '5' } }), /must be a finite number/)
  // The unit is the step, but the pre-rename key still has to load: a profile
  // patch that says `toolCalls: 6` used to make this throw, and that throw took
  // the plugin row — tier, chip and guard — out of a live session.
  assert.equal(resolveConfig({ default: { toolCalls: 6 }, deep: { steps: 7 } }).default.steps, 6)
  // `steps` wins when a half-migrated patch carries both.
  assert.equal(resolveConfig({ default: { steps: 4, toolCalls: 6 }, deep: { steps: 7 } }).default.steps, 4)
  // A genuinely unknown key is still refused.
  assert.throws(() => resolveConfig({ default: { calls: 4 } }), /unknown key\(s\) calls/)
  // Both limited tiers count steps now, so Wide really has to be wider.
  assert.throws(
    () => resolveConfig({ default: { steps: 6 }, deep: { steps: 5 } }),
    /config\.deep\.steps \(5\) must be greater than config\.default\.steps \(6\)/
  )
  // "Unlimited" is a tier, not a number a user could get wrong.
  assert.throws(() => resolveConfig({ free: { steps: 999 } }), /unknown key\(s\) free/)
})

test('config: a bare row gets the plan defaults', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.default.steps, 4)
  assert.equal(config.default.minutes, 2)
  assert.equal(config.default.permission, 'read-only')
  assert.equal(config.default.effort, 'low', 'the default tier uses the lowest level a gateway accepts, not an untenable "off"')
  assert.equal(config.deep.steps, 5)
  assert.equal(config.deep.minutes, 5)
  assert.equal(config.deep.effort, 'high')
})

test('limits: the free tier has no ceiling, pins no effort, and counts nothing', () => {
  const config = resolveConfig(SHIPPED)
  assert.deepEqual(limitsFor(config, 'free'), { kind: 'unlimited', max: Infinity, minutes: Infinity, effort: null })
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 9 }, T0)
  assert.equal(ceilingState(config, 'free', usage, T0 + 86_400_000).exhausted, false, 'a day of work does not trip a ceiling')
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    assert.equal(guardDecision(config, 'free', usage, T0 + 86_400_000), undefined, `free call ${attempt} is allowed`)
  }
  assert.equal(usage.step, 9, 'the free tier does not even touch the record it reads')
})

test('usage: a turn boundary resets the counters', () => {
  const usage = emptyUsage()
  assert.equal(usage.active, false)
  observeStep(usage, { turn: 1, step: 1 }, T0)
  assert.deepEqual({ active: usage.active, step: usage.step, startedAt: usage.startedAt }, { active: true, step: 1, startedAt: T0 })
  observeStep(usage, { turn: 1, step: 2 }, T0 + 1)
  assert.equal(usage.step, 2)
  observeStep(usage, { turn: 2, step: 1 }, T0 + 2)
  assert.deepEqual({ step: usage.step, startedAt: usage.startedAt }, { step: 1, startedAt: T0 + 2 })
  // A step counter restart without turn numbers must also reset.
  observeStep(usage, { step: 1 }, T0 + 3)
  assert.deepEqual({ step: usage.step, startedAt: usage.startedAt }, { step: 1, startedAt: T0 + 3 })
})

test('usage: a turn/start opens the ceiling before the prompt is assembled', () => {
  const config = resolveConfig(SHIPPED)
  const permission = { preset: 'read-only', source: 'plugin' }
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 5 }, T0)

  // The loop renders the runtime context before `agent/pre-step` runs, so the
  // record a turn's first snapshot sees is the previous turn's. Elapsed time is
  // wall clock, which is how 88 minutes of sitting idle read as a reached ceiling.
  const opened = T0 + 88 * 60_000
  const unfold = stateContext(config, 'default', usage, opened, permission)
  assert.match(unfold, /This turn's ceiling is reached/)
  assert.match(unfold, /the 2-minute ceiling is reached \(88\.0 min elapsed\)/)

  observeSessionEvent(usage, { type: 'turn/start', data: { turn: 2 }, time: opened }, opened)
  assert.deepEqual(
    { active: usage.active, turn: usage.turn, step: usage.step, startedAt: usage.startedAt },
    { active: true, turn: 2, step: 1, startedAt: opened }
  )
  const snapshot = stateContext(config, 'default', usage, opened + 40, permission)
  assert.match(snapshot, /This turn: step 1\/4 · 0\.0\/2 min\./, 'a new turn reports an untouched ceiling')
  assert.ok(!snapshot.includes('ceiling is reached'))
  assert.equal(ceilingState(config, 'default', usage, opened + 40).exhausted, false)
  assert.equal(guardDecision(config, 'default', usage, opened + 40), undefined, 'and its first tool call is allowed')

  // The step's own boundary lands on the same record: it must not re-count or
  // re-anchor the turn it just opened.
  observeStep(usage, { turn: 2, step: 1 }, opened + 41)
  assert.equal(usage.turn, 2)
  assert.equal(usage.step, 1)
  assert.match(stateContext(config, 'default', usage, opened + 100, permission), /step 1\/4/)

  // A closed turn leaves the record inert, so no snapshot rendered in the gap
  // between two turns can claim a ceiling the closed turn never had.
  observeSessionEvent(usage, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, time: opened + 5000 }, opened + 5000)
  assert.equal(usage.active, false)
  const between = stateContext(config, 'default', usage, opened + 10 * 60_000, permission)
  assert.ok(!between.includes('This turn:'), 'an idle gap carries no ceiling line')
  assert.ok(!between.includes('ceiling is reached'))
  assert.equal(ceilingState(config, 'default', usage, opened + 10 * 60_000).exhausted, false)

  // An unrelated event is not a boundary.
  observeSessionEvent(usage, { type: 'permission/preset', data: { preset: 'read-only' }, time: opened + 6000 }, opened + 6000)
  assert.equal(usage.active, false)
})

test('ceiling: nothing is enforced before a turn boundary is seen', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  assert.equal(ceilingState(config, 'default', usage, T0).exhausted, false)
  assert.equal(guardDecision(config, 'default', usage, T0), undefined)
})

test('ceiling: the default tier allows four steps of tools, then exactly one closing step', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  for (let step = 1; step <= 4; step += 1) {
    observeStep(usage, { turn: 1, step }, T0)
    assert.equal(ceilingState(config, 'default', usage, T0).exhausted, false, `step ${step} is inside the ceiling`)
    assert.equal(guardDecision(config, 'default', usage, T0), undefined, `step ${step} may use tools`)
    // Fan-out is free: a step that calls twelve tools in parallel still costs one.
    for (let call = 1; call <= 12; call += 1) {
      assert.equal(guardDecision(config, 'default', usage, T0), undefined, `parallel call ${call} in step ${step} is allowed`)
    }
  }
  observeStep(usage, { turn: 1, step: 5 }, T0)
  const denied = guardDecision(config, 'default', usage, T0)
  assert.match(denied, /the 4-step ceiling is reached/)
  assert.match(denied, /Stop calling tools/)
  assert.match(denied, /## What I found/)
  assert.match(denied, /dsh-throttle plugin's tier ceiling/, 'the refusal names the plugin, not the sandbox')
  assert.equal(usage.step, 5, 'the guard never advances the counter it reads')
  assert.equal(guardDecision(config, 'default', usage, T0), denied, 'the denial is sticky')
})

test('ceiling: the two-minute ceiling denies by time', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 1 }, T0)
  assert.equal(ceilingState(config, 'default', usage, T0 + 119_000).exhausted, false)
  const state = ceilingState(config, 'default', usage, T0 + 121_000)
  assert.equal(state.exhausted, true)
  assert.match(state.reason, /the 2-minute ceiling is reached/)
  assert.match(guardDecision(config, 'default', usage, T0 + 121_000), /the 2-minute ceiling/)
})

test('ceiling: the deep tier allows five steps of tools, then exactly one closing step', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  for (let step = 1; step <= 5; step += 1) {
    observeStep(usage, { turn: 1, step }, T0)
    assert.equal(ceilingState(config, 'deep', usage, T0).exhausted, false, `step ${step} is inside the ceiling`)
    assert.equal(guardDecision(config, 'deep', usage, T0), undefined, `step ${step} may use tools`)
  }
  observeStep(usage, { turn: 1, step: 6 }, T0)
  const state = ceilingState(config, 'deep', usage, T0)
  assert.equal(state.exhausted, true)
  assert.match(state.reason, /the 5-step ceiling is reached/)
  const denied = guardDecision(config, 'deep', usage, T0)
  assert.match(denied, /the 5-step ceiling/, 'the closing step may not call tools')
  assert.match(guardDecision(config, 'deep', usage, T0), /the 5-step ceiling/, 'and the refusal keeps holding')
})

test('prompt section: the tier contract is stable per tier and carries no counter', () => {
  const config = resolveConfig(SHIPPED)
  const fresh = policySection(config, 'default', { preset: 'read-only', source: 'plugin' })
  assert.match(fresh, /^\[throttle\] current tier: Tight/)
  assert.match(fresh, /≤4 steps · ≤2 min/)
  assert.match(fresh, /set by this plugin to read-only/)
  assert.match(fresh, /do not switch the permission preset yourself/)
  assert.ok(fresh.includes(STANDING_RULES), 'the standing rules must be present in every tier')
  assert.ok(!fresh.includes('This turn:'), 'the live counter belongs in the runtime context, not the prompt head')
  assert.ok(!fresh.includes('## What I found'), 'the hand-back format belongs in the runtime context')

  const deep = policySection(config, 'deep', { preset: 'workspace-write', source: 'session' })
  assert.match(deep, /^\[throttle\] current tier: Wide/)
  assert.match(deep, /≤5 steps · ≤5 min/)
  assert.match(deep, /the session's own preset workspace-write/)

  const free = policySection(config, 'free', { preset: 'workspace-write', source: 'session' })
  assert.match(free, /^\[throttle\] current tier: Open/)
  assert.match(free, /sets no tool, step or time ceiling/)
  assert.match(free, /standing collaboration rules still apply/)
  assert.ok(free.includes(STANDING_RULES), 'the standing rules survive into the free tier by design')
})

test('state context: it explains a read-only policy, tracks the ceiling, and carries the hand-back format', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 3 }, T0)

  const text = stateContext(config, 'default', usage, T0 + 30_000, { preset: 'read-only', source: 'plugin' })
  assert.match(text, /^\[throttle:state\] tier: Tight/)
  assert.match(text, /Current DSH file policy/)
  assert.match(text, /The plugin's Tight tier pins the session permission preset to read-only/)
  assert.match(text, /it is not DSH's deployment default/)
  assert.match(text, /This turn: step 3\/4 · 0\.5\/2 min\./)
  assert.ok(text.includes(SURRENDER_TEMPLATE), '步数达到 75% 时提前提供阶段交接格式')

  const deep = stateContext(config, 'deep', usage, T0 + 60_000, { preset: 'workspace-write', source: 'session' })
  assert.match(deep, /^\[throttle:state\] tier: Wide/)
  assert.match(deep, /This turn: step 3\/5 · 1\.0\/5 min\./)

  observeStep(usage, { turn: 1, step: 5 }, T0)
  const spent = stateContext(config, 'default', usage, T0, { preset: 'read-only', source: 'plugin' })
  assert.match(spent, /\*\*This turn's ceiling is reached\*\* \(the 4-step ceiling is reached \(now on step 5\)\)/)
  assert.ok(spent.includes(SURRENDER_TEMPLATE), 'the fixed hand-back format must be rendered verbatim')

  const free = stateContext(config, 'free', usage, T0 + 60_000, { preset: 'read-only', source: 'session' })
  assert.match(free, /^\[throttle:state\] tier: Open/)
  assert.match(free, /No ceiling and no reasoning override in this tier; permissions: the session's own preset read-only/)
  assert.match(free, /it has nothing to do with this plugin/, 'the free tier must not blame itself for the session\'s own read-only preset')
  assert.ok(!free.includes('This turn:'), 'the free tier has no ceiling to report')

  const stuck = stateContext(config, 'free', usage, T0, { preset: 'read-only', source: 'pending', target: 'workspace-write' })
  assert.match(stuck, /putting the permission preset back to the session's own/)
})

test('软检查点覆盖两个有限档的步数和时间边界，且不提前拒绝工具', () => {
  const config = resolveConfig(SHIPPED)
  const permission = { preset: 'read-only', source: 'plugin' }
  for (const mode of ['default', 'deep']) {
    const limits = limitsFor(config, mode)
    const usage = emptyUsage()
    const checkpointStep = Math.ceil(limits.max * 0.75)
    observeStep(usage, { turn: 1, step: checkpointStep - 1 }, T0)
    assert.ok(!stateContext(config, mode, usage, T0, permission).includes('Stage checkpoint'))
    observeStep(usage, { turn: 1, step: checkpointStep }, T0)
    const before = { ...usage }
    assert.match(stateContext(config, mode, usage, T0, permission), /Stage checkpoint/)
    assert.equal(guardDecision(config, mode, usage, T0), undefined)
    assert.deepEqual(usage, before)

    observeStep(usage, { turn: 2, step: 1 }, T0)
    const at = T0 + limits.minutes * 60_000 * 0.75
    assert.ok(!stateContext(config, mode, usage, at - 1, permission).includes('Stage checkpoint'))
    assert.match(stateContext(config, mode, usage, at, permission), /Stage checkpoint/)
    assert.equal(guardDecision(config, mode, usage, at), undefined)
    const exactLimit = T0 + limits.minutes * 60_000
    assert.match(stateContext(config, mode, usage, exactLimit, permission), /Stage checkpoint/)
    assert.equal(guardDecision(config, mode, usage, exactLimit), undefined)
    const exhausted = stateContext(config, mode, usage, exactLimit + 1, permission)
    assert.ok(!exhausted.includes('Stage checkpoint'))
    assert.match(exhausted, /This turn's ceiling is reached/)
    assert.match(guardDecision(config, mode, usage, exactLimit + 1), /Suggested next stage/)
  }
})

test('软检查点跳过空闲和 Open，跟随新轮次及有效配置', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  const render = (mode = 'default', settings = config) => stateContext(settings, mode, usage, T0, {})
  assert.ok(!render().includes('Stage checkpoint'))
  observeStep(usage, { turn: 1, step: 3 }, T0)
  assert.match(render(), /Stage checkpoint/)
  assert.ok(!render('free').includes('Stage checkpoint'))
  const wider = resolveConfig({ default: { steps: 8 }, deep: { steps: 9 } })
  assert.ok(!render('default', wider).includes('Stage checkpoint'))
  assert.equal(usage.step, 3)
  observeSessionEvent(usage, { type: 'turn/end' }, T0)
  assert.ok(!render().includes('Stage checkpoint'))
  observeSessionEvent(usage, { type: 'turn/start', data: { turn: 2 } }, T0)
  assert.ok(!render().includes('Stage checkpoint'))
})

test('阶段交接支持真实空项、完成状态与委派会话回复', () => {
  const config = resolveConfig(SHIPPED)
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 4 }, T0)
  const text = stateContext(config, 'deep', usage, T0, {}, { inherited: true })
  assert.match(text, /reply from the delegating session/)
  assert.ok(text.includes(SURRENDER_TEMPLATE))
  assert.match(SURRENDER_TEMPLATE, /write None/)
  assert.match(SURRENDER_TEMPLATE, /checks already run from suggested checks/)
  assert.match(SURRENDER_TEMPLATE, /if complete, say Complete/)
})

test('permission phrases: each source says who owns the preset', () => {
  assert.match(permissionPhrase({ preset: 'read-only', source: 'plugin' }), /set by this plugin to read-only/)
  assert.match(permissionPhrase({ preset: 'workspace-write', source: 'session' }), /the session's own preset workspace-write \(this tier honours it and adds no further limit\)/)
  assert.match(
    permissionPhrase({ preset: 'read-only', source: 'pending', target: 'workspace-write' }),
    /this plugin targets workspace-write while the current preset is read-only \(the tier was just entered, the user just changed it by hand, or the permission service is unavailable; it is reconciled on the next step\)/
  )
  assert.match(permissionPhrase({ preset: undefined, source: 'pending', target: 'workspace-write' }), /the current preset cannot be read/)
  assert.match(permissionPhrase({ preset: 'read-only', source: 'pending', target: undefined }), /wants to restore the session's own preset, and the current one is read-only/)
  assert.equal(permissionPhrase({ source: 'unknown' }), 'unknown (the permission service is unavailable)')
  assert.equal(permissionPhrase(undefined), 'unknown (the permission service is unavailable)')
})

test('receipts: all three tiers report themselves in the plan format', () => {
  const config = resolveConfig(SHIPPED)
  assert.equal(receiptText(config, 'deep', 'workspace-write'), '⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (workspace-write)')
  assert.equal(receiptText(config, 'default', 'view-only'), '🍃 Tight · reasoning low (lowest) · ≤4 steps · ≤2 min · view-only')
  assert.equal(receiptText(config, 'free', 'workspace-write'), '♾️ Open · no ceiling · no reasoning override · preset left alone (workspace-write)')
  assert.equal(statusLine(config, 'deep', 'restore'), '⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (restore)')
  assert.equal(statusLine(config, 'deep', undefined), '⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (kept as is)')
  assert.equal(statusLine(config, 'free', undefined), '♾️ Open · no ceiling · no reasoning override · preset left alone (kept as is)')
})

test('command grammar: a bare /throttle toggles the limited tiers, words name a tier', () => {
  assert.equal(nextMode('default', ''), 'deep')
  assert.equal(nextMode('deep', ''), 'default')
  assert.equal(nextMode('free', ''), 'default', 'a bare /throttle re-engages the plugin rather than staying free')
  for (const word of ['off', 'free', 'unlimited']) {
    assert.equal(nextMode('default', word), 'free', `${word} must reach the unlimited tier`)
    assert.equal(nextMode('deep', word), 'free', `${word} must reach the unlimited tier from deep`)
  }
  for (const word of ['on', 'default', 'tight']) assert.equal(nextMode('free', word), 'default')
  assert.equal(nextMode('free', 'wide'), 'deep')
  for (const word of ['open']) assert.equal(nextMode('default', word), 'free')
  assert.equal(nextMode('default', 'deep'), 'deep')
  assert.equal(nextMode('default', 'nonsense'), undefined)
})

test('projection: the tier folds from /throttle runs, and a refusal changes nothing', () => {
  const config = resolveConfig(SHIPPED)
  let state = createThrottleProjection(config).init()
  assert.equal(createThrottleProjection(config).stateVersion, 3, 'the state shape changed from the two-state version')
  const fold = (event) => { state = applyThrottleEvent(config, state, event) }
  assert.equal(modeOfState(state), 'default')
  assert.equal(state.commanded, false, 'a session that has never run /throttle does not own its tier')

  // The Harness pins the session's original preset before anything else.
  fold({ type: 'permission/preset', data: { preset: 'workspace-write' } })
  assert.equal(state.original, 'workspace-write')

  // Bare /throttle toggles on.
  fold({ type: 'command/run', data: { commandId: 'c1', name: 'throttle', args: '' } })
  fold({ type: 'command/done', data: { commandId: 'c1', kind: 'success' } })
  assert.equal(modeOfState(state), 'deep')
  assert.equal(state.commanded, true, 'a successful /throttle is what stops the session inheriting a tier')

  // The plugin's own takeover append is not a user preference.
  fold({ type: 'permission/preset', data: { preset: 'read-only' } })
  assert.equal(state.chosenPreset, null, 'the plugin re-asserting the tier must not be recorded as a preference')
  fold({ type: 'permission/preset', data: { preset: 'danger-full-access' } })
  assert.equal(state.chosenPreset, 'danger-full-access', 'a change made outside the default tier is the user\'s choice')

  // /throttle off reaches the free tier even from deep; /throttle on comes back.
  fold({ type: 'command/run', data: { commandId: 'c2', name: 'throttle', args: ' off' } })
  fold({ type: 'command/done', data: { commandId: 'c2', kind: 'success' } })
  assert.equal(modeOfState(state), 'free')
  fold({ type: 'command/run', data: { commandId: 'c3', name: 'throttle', args: ' on' } })
  fold({ type: 'command/done', data: { commandId: 'c3', kind: 'success' } })
  assert.equal(modeOfState(state), 'default')

  // A bare /throttle from free re-engages the plugin at the default tier.
  fold({ type: 'command/run', data: { commandId: 'c4', name: 'throttle', args: ' unlimited' } })
  fold({ type: 'command/done', data: { commandId: 'c4', kind: 'success' } })
  assert.equal(modeOfState(state), 'free')
  fold({ type: 'command/run', data: { commandId: 'c5', name: 'throttle', args: '' } })
  fold({ type: 'command/done', data: { commandId: 'c5', kind: 'success' } })
  assert.equal(modeOfState(state), 'default')

  // An argument the grammar rejects is not even recorded as a pending run.
  fold({ type: 'command/run', data: { commandId: 'c6', name: 'throttle', args: ' sideways' } })
  assert.equal(state.running, null)
  assert.equal(modeOfState(state), 'default')

  // A refused run (the handler errored) must not switch.
  fold({ type: 'command/run', data: { commandId: 'c7', name: 'throttle', args: ' deep' } })
  fold({ type: 'command/done', data: { commandId: 'c7', kind: 'error' } })
  assert.equal(modeOfState(state), 'default')
  fold({ type: 'command/run', data: { commandId: 'c8', name: 'throttle', args: '' } })
  fold({ type: 'command/done', data: { commandId: 'c8', kind: 'error' } })
  assert.equal(modeOfState(state), 'default', 'a failed /throttle must not flip the tier')
})

test('client view: the tier and every ceiling cross the wire as plain JSON', () => {
  const config = resolveConfig(SHIPPED)
  const deep = throttleView(config, { mode: 'deep', running: null, original: null, chosenPreset: null })
  assert.deepEqual(deep, {
    mode: 'deep',
    running: false,
    tiers: {
      default: { kind: 'steps', max: 4, minutes: 2, effort: 'low' },
      deep: { kind: 'steps', max: 5, minutes: 5, effort: 'high' },
      free: { kind: 'unlimited', max: null, minutes: null, effort: null }
    }
  })

  // The value reaches the browser as JSON, which cannot carry Infinity: the
  // unlimited tier must publish nulls itself instead of relying on stringify.
  assert.deepEqual(JSON.parse(JSON.stringify(deep)), deep)

  const running = throttleView(config, { mode: 'free', running: { commandId: 'c', wanted: 'default' } })
  assert.equal(running.mode, 'free')
  assert.equal(running.running, true, 'an in-flight /throttle is visible to the chip')
})

test('client view: an edited ceiling is reflected, and the other tier is untouched', () => {
  const view = throttleView(resolveConfig({ default: { steps: 2, minutes: 7 } }), EMPTY_THROTTLE_STATE)
  assert.equal(view.mode, 'default')
  assert.equal(view.tiers.default.max, 2)
  assert.equal(view.tiers.default.minutes, 7)
  assert.equal(view.tiers.deep.max, 5, 'an untouched tier keeps its default')
})

test('projection: a wire block is published only when one is supplied', () => {
  const config = resolveConfig(SHIPPED)
  const wire = { viewSchema: { parse: (value) => value }, view: (state) => throttleView(config, state) }
  const published = createThrottleProjection(config, wire)
  assert.equal(published.wire, wire)
  assert.equal(published.wire.view(published.init()).mode, 'default')
  assert.equal('wire' in createThrottleProjection(config), false, 'a host-only unit publishes nothing')
})

test('the plugin registers a client-visible tier view the chip can read', () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const definition = harness.registry.def
  assert.equal(definition.key, 'throttleMode')
  assert.equal(definition.stateVersion, 3, 'publishing a view must not invalidate persisted state')
  const view = definition.wire.viewSchema.parse(definition.wire.view(definition.init()))
  assert.equal(view.mode, 'default')
  assert.equal(view.tiers.default.max, 4)
  assert.equal(view.tiers.free.max, null)
  assert.throws(() => definition.wire.viewSchema.parse({ mode: 7 }), /throttleMode view/, 'the schema is not a passthrough')
})

test('a live config edit is picked up without remounting, and a bad one is refused', async () => {
  let current = { default: { ...SHIPPED.default }, deep: { ...SHIPPED.deep } }
  const live = { default: { get: () => current.default }, deep: { get: () => current.deep } }
  const harness = fakeCtx()
  apply(harness.ctx, live)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  assert.match(harness.captured.contexts[0].text({ agent }), /≤4 steps/)

  const listeners = harness.captured.events.get('loader/volatile-update') ?? []
  assert.equal(listeners.length, 1, 'the plugin subscribes to the Loader volatile-update broadcast')

  // The settings form's write path: the Loader updates the references in place
  // and announces it. Nothing remounts, so the running plugin must re-read.
  current = { default: { steps: 3, minutes: 7, effort: 'low', permission: 'read-only' }, deep: current.deep }
  listeners[0]()
  assert.match(harness.captured.contexts[0].text({ agent }), /≤3 steps/, 'the new ceiling is in force')
  assert.equal(harness.registry.def.wire.view(harness.registry.def.init()).tiers.default.max, 3)

  // A value the schema would have rejected cannot silently replace a good one.
  current = { default: { steps: 0, minutes: 7, effort: 'low', permission: 'read-only' }, deep: current.deep }
  listeners[0]()
  assert.match(harness.captured.contexts[0].text({ agent }), /≤3 steps/, 'the last good config stays in force')
  assert.ok(harness.captured.warnings.some((line) => line.includes('the configuration update was refused')))
})

test('projection: unrelated events keep the state reference', () => {
  const config = resolveConfig(SHIPPED)
  const state = createThrottleProjection(config).init()
  for (const event of [
    { type: 'user/message', data: {} },
    { type: 'command/run', data: { commandId: 'c9', name: 'plan', args: '' } },
    { type: 'tool/call', data: {} }
  ]) {
    assert.equal(applyThrottleEvent(config, state, event), state, `${event.type} must not allocate`)
  }
})

test('projection: the persisted state schema rejects untrustworthy shapes', () => {
  const good = { mode: 'deep', running: null, original: 'workspace-write', chosenPreset: null, commanded: true }
  assert.equal(parseThrottleState(good), good)
  assert.throws(() => parseThrottleState(null), /must be an object/)
  assert.throws(() => parseThrottleState({ mode: 'active', running: null, original: null, chosenPreset: null, commanded: false }), /mode must be one of/)
  assert.throws(() => parseThrottleState({ mode: 'default', running: { commandId: 'c' }, original: null, chosenPreset: null, commanded: false }), /running must be null or/)
  assert.throws(() => parseThrottleState({ mode: 'default', running: { commandId: 'c', wanted: true }, original: null, chosenPreset: null, commanded: false }), /running must be null or/)
  assert.throws(() => parseThrottleState({ mode: 'default', running: null, original: 7, chosenPreset: null, commanded: false }), /original must be null or a string/)
  assert.throws(() => parseThrottleState({ mode: 'default', running: null, original: null, chosenPreset: 7, commanded: false }), /chosenPreset must be null or a string/)
  // A checkpoint from the pre-inheritance shape is not a state this version can
  // read: the version bump discards it and refolds the log instead.
  assert.throws(() => parseThrottleState({ mode: 'default', running: null, original: null, chosenPreset: null }), /commanded must be a boolean/)
})

test('restore target: the user\'s own choice, then the session original, then a writable fallback', () => {
  const config = resolveConfig(SHIPPED)
  const all = (candidate) => ['read-only', 'workspace-write', 'danger-full-access'].includes(candidate)
  assert.equal(restoreTarget(config, { original: 'workspace-write', chosenPreset: null }, all), 'workspace-write')
  assert.equal(restoreTarget(config, { original: 'workspace-write', chosenPreset: 'danger-full-access' }, all), 'danger-full-access')
  // An original equal to the default tier's preset is useless as a restore target.
  assert.equal(restoreTarget(config, { original: 'read-only', chosenPreset: null }, all), 'workspace-write')
  assert.equal(restoreTarget(config, { original: 'custom', chosenPreset: null }, all), 'workspace-write')
  assert.equal(restoreTarget(config, { original: null, chosenPreset: null }, all), 'workspace-write')
  assert.equal(restoreTarget(config, { original: null, chosenPreset: null }, () => false), undefined)
})

test('a fresh session is confined before its first step', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  // The first assembly of a session runs before the first pre-step, where the
  // plugin asserts its preset: the text must report the target, not a failure.
  const early = harness.captured.contexts[0].text({ agent: { session: harness.session } })
  assert.match(early, /this plugin targets read-only while the current preset is workspace-write/)
  assert.match(early, /it is reconciled on the next step/)

  await harness.emit('agent/pre-step', { agent: { session: harness.session }, turn: 1, step: 1 })
  assert.equal(harness.service.preset, 'read-only', 'the default tier must confine the session')
  const settled = harness.captured.contexts[0].text({ agent: { session: harness.session } })
  assert.match(settled, /set by this plugin to read-only \(this tier's definition, not the user's choice\)/)
  const state = harness.registry.stateOf(harness.session, 'throttleMode')
  assert.equal(modeOfState(state), 'default')
  assert.equal(state.original, 'workspace-write', 'the preset to restore in the other tiers must be remembered')
})

test('a session the user un-confines by hand is put back in the default tier', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  assert.equal(harness.service.preset, 'read-only')
  harness.service.preset = 'workspace-write' // the user reaches for the permission selector
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 2 })
  assert.equal(harness.service.preset, 'read-only', 'the default tier owns the permission preset')
  // Converged: a third pass appends nothing and does not churn the log.
  const before = harness.registry.logs.get('session-1').length
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 3 })
  assert.equal(harness.registry.logs.get('session-1').length, before)
})

/**
 * A delegating session plus one `subagent` child that never ran `/throttle`,
 * wired the way the Harness wires them: the child's header names its parent and
 * the live parent is reachable through the agent service.
 * @param options - fake-context overrides.
 * @returns the harness, both agents, and the child's own log.
 */
function delegation (options = {}) {
  const agents = { get: () => undefined }
  const harness = fakeCtx({ preset: 'workspace-write', agents, ...options })
  agents.get = (id) => (id === harness.session.header.id ? { session: harness.session } : undefined)
  apply(harness.ctx, SHIPPED)
  const childSession = { header: { id: 'child-1', origin: 'subagent', parentSession: harness.session.header.id } }
  return {
    harness,
    parent: { session: harness.session },
    child: { session: childSession },
    childSession,
    childLog: (type) => (harness.registry.logs.get('child-1') ?? []).filter((event) => event.type === type)
  }
}

test('a delegated sub-session runs on the tier its delegator is in', async () => {
  const { harness, parent, child, childLog } = delegation()
  await harness.emit('agent/pre-step', { agent: parent, turn: 1, step: 1 })
  await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 1 })
  const tight = harness.captured.contexts[0].text({ agent: child })
  assert.match(tight, /tier: Tight/)
  assert.match(tight, /inherited from the session that delegated/)
  assert.equal(harness.service.current(child.session), 'read-only', 'Tight still means view-only for a child')

  // The delegator widens: the child follows it without a record of its own.
  harness.throttle(parent, '')
  assert.equal(modeOfState(harness.registry.stateOf(child.session, 'throttleMode')), 'default', 'the child\'s own log still says nothing')
  assert.equal(harness.registry.stateOf(child.session, 'throttleMode').commanded, false)
  await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 2 })
  const wide = harness.captured.contexts[0].text({ agent: child })
  assert.match(wide, /tier: Wide/)
  assert.match(wide, /≤5 steps/)
  assert.equal(harness.service.current(child.session), 'workspace-write', 'the plugin releases its own read-only pin')
  assert.equal(childLog('permission/preset').length, 2, 'the Tight pin and its release are the only writes it owns')
  assert.match(wide, /the scope this delegated sub-session was started with \(workspace-write\)/)

  // The child's ceiling is Wide's, counted on its own record.
  const guard = harness.captured.guards[0]
  for (let step = 3; step <= 5; step += 1) {
    await harness.emit('agent/pre-step', { agent: child, turn: 1, step })
    assert.equal(guard({ agent: child }), undefined, `the child's step ${step} may call tools`)
  }
  await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 6 })
  assert.match(guard({ agent: child }), /the 5-step ceiling is reached/)
  // …and none of it moved the delegator's own counter or ceiling.
  assert.match(harness.captured.contexts[0].text({ agent: parent }), /This turn: step 1\/5/)
  assert.equal(guard({ agent: parent }), undefined)
})

test('继承 Wide/Open 保留子会话原有的只读权限', async () => {
  for (const mode of ['wide', 'open']) {
    for (const throughTight of [false, true]) {
      const { harness, parent, child, childLog } = delegation()
      harness.service.set(child.session, 'read-only')
      const before = childLog('permission/preset').length
      if (throughTight) await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 1 })
      harness.throttle(parent, mode)
      await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 2 })
      assert.equal(harness.service.current(child.session), 'read-only')
      assert.equal(childLog('permission/preset').length, before)
      assert.match(harness.captured.contexts[0].text({ agent: child }), /delegated sub-session was started with \(read-only\)/)
    }
  }
})

test('继承档仅恢复插件实际替换的委派预设，不使用可写兜底', async () => {
  for (const original of ['workspace-write', 'danger-full-access', 'custom']) {
    const { harness, parent, child } = delegation({ preset: original })
    await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 1 })
    assert.equal(harness.service.current(child.session), 'read-only')
    harness.throttle(parent, 'open')
    await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 2 })
    assert.equal(harness.service.current(child.session), original === 'custom' ? 'read-only' : original)
  }
})

test('插件重新加载后不推断旧只读 pin 的归属', async () => {
  const { harness, parent, child } = delegation()
  await harness.emit('agent/pre-step', { agent: child, turn: 1, step: 1 })
  harness.throttle(parent, 'open')
  const resumed = fakeCtx({
    preset: 'read-only',
    log: harness.registry.logs.get('child-1'),
    agents: { get: () => ({ session: harness.session }) }
  })
  apply(resumed.ctx, SHIPPED)
  // 新注册表需要父会话日志，才能恢复子会话继承的 Open 档。
  resumed.registry.logs.set('child-1', harness.registry.logs.get('child-1'))
  resumed.registry.logs.set(harness.session.header.id, harness.registry.logs.get(harness.session.header.id))
  await resumed.emit('agent/pre-step', { agent: child, turn: 2, step: 1 })
  assert.match(resumed.captured.contexts[0].text({ agent: child }), /tier: Open/)
  assert.equal(resumed.service.current(child.session), 'read-only')
})

test('a sub-session\'s own /throttle ends the inheritance', async () => {
  const { harness, parent, child } = delegation()
  await harness.emit('agent/pre-step', { agent: parent, turn: 1, step: 1 })
  harness.throttle(parent, '')

  const pinned = harness.throttle(child, ' tight')
  assert.equal(modeOfState(harness.registry.stateOf(child.session, 'throttleMode')), 'default')
  assert.match(pinned.text, /^🍃 Tight/)
  assert.match(pinned.text, /now owns the one above/)
  assert.ok(!harness.captured.contexts[0].text({ agent: child }).includes('inherited from the session that delegated'))

  // The delegator is Open now, and the child stays where it was put.
  harness.throttle(parent, ' open')
  assert.match(harness.captured.contexts[0].text({ agent: child }), /tier: Tight/)
  assert.match(harness.captured.contexts[0].text({ agent: parent }), /tier: Open/)
})

test('a refused row config is named in the snapshot and in the receipt', async () => {
  const harness = fakeCtx()
  // The cross-field rule the settings schema cannot express: the form accepts
  // this pair, the plugin refuses it, and the refusal used to be silent.
  apply(harness.ctx, {
    default: { steps: 6, minutes: 2, effort: 'low', permission: 'read-only' },
    deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' }
  })
  assert.ok(harness.captured.warnings.some((line) => line.includes('the row config was refused')))
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  const text = harness.captured.contexts[0].text({ agent })
  assert.match(text, /built-in defaults, because the row config was refused/)
  assert.match(text, /config\.deep\.steps \(5\) must be greater than config\.default\.steps \(6\)/)
  assert.match(text, /≤4 steps/, 'the built-in numbers are the ones in force')
  const receipt = harness.throttle(agent, '')
  assert.match(receipt.text, /the row config was refused, so the numbers above are the plugin's built-in defaults/)
})

test('the prompt section is byte-identical across steps while the context follows the ceiling', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  const [section] = harness.captured.sections
  const [context] = harness.captured.contexts
  assert.equal(section.name, 'throttle:policy')
  assert.equal(context.name, 'throttle:state')
  assert.equal(context.order, 112, 'the state snapshot sits right after sandbox:policy (110)')
  const sectionBefore = section.text({ agent })
  assert.match(context.text({ agent }), /This turn: step 1\/4/)

  const [guard] = harness.captured.guards
  assert.equal(guard({ agent }), undefined, 'a call inside the ceiling is allowed')
  assert.match(context.text({ agent }), /This turn: step 1\/4/, 'and it does not spend the ceiling: the unit is the step')
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 2 })
  assert.equal(section.text({ agent }), sectionBefore, 'an ordinary step must not rewrite the cached prompt head')
  assert.match(context.text({ agent }), /This turn: step 2\/4/, 'but the live snapshot follows the step counter')
})

test('/throttle walks the three tiers and prints the receipt', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  assert.equal(harness.service.preset, 'read-only')

  const entered = harness.throttle(agent, '')
  assert.equal(entered.kind, 'success')
  assert.match(entered.text, /^⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored \(workspace-write\)/)
  assert.equal(harness.service.preset, 'workspace-write', 'the deep tier restores the preset the session had')

  const free = harness.throttle(agent, ' off')
  assert.equal(free.kind, 'success')
  assert.match(free.text, /^♾️ Open · no ceiling · no reasoning override · preset left alone \(workspace-write\)/)
  assert.match(free.text, /Open tier: no step or time ceiling/)
  assert.equal(harness.service.preset, 'workspace-write', 'the free tier leaves the session writable')
  assert.equal(modeOfState(harness.registry.stateOf(harness.session, 'throttleMode')), 'free', '/throttle off must reach the unlimited tier')

  const back = harness.throttle(agent, ' on')
  assert.equal(back.kind, 'success')
  assert.match(back.text, /^🍃 Tight · reasoning low \(lowest\) · ≤4 steps · ≤2 min · view-only/)
  assert.equal(harness.service.preset, 'read-only', 'the default tier confines again')

  assert.match(harness.throttle(agent, ' deep').text, /^⚡ Wide/)
  assert.equal(harness.service.preset, 'workspace-write', '/throttle deep is the explicit deep entry')

  const refused = harness.throttle(agent, ' sideways')
  assert.equal(refused.kind, 'error', 'unknown arguments are refused')
  assert.match(refused.text, /Usage:/)
  assert.equal(harness.service.preset, 'workspace-write', 'a refused /throttle must not change the permission')
})

test('/throttle remembers a preset the user changed while outside the default tier', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })

  harness.throttle(agent, ' deep')
  assert.equal(harness.service.preset, 'workspace-write')
  harness.service.preset = 'danger-full-access' // the user switches while deep
  harness.registry.append(harness.session, { type: 'permission/preset', data: { preset: 'danger-full-access' } })
  harness.throttle(agent, ' on')
  assert.equal(harness.service.preset, 'read-only')
  harness.throttle(agent, ' off')
  assert.equal(harness.service.preset, 'danger-full-access', 'the free tier restores the manual choice')
})

test('/throttle refuses attachments without changing the tier', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  const result = harness.throttle(agent, '', [{ type: 'file' }])
  assert.equal(result.kind, 'error')
  assert.match(result.text, /takes no attachments/)
  assert.equal(harness.service.preset, 'workspace-write', 'a refused /throttle must not touch permissions')
})

test('reasoning effort is pinned per tier', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  const { agent, bound } = await bindAgent(harness)
  assert.equal(bound.event, 'agent/request')
  assert.deepEqual(bound.options, { prepend: true }, 'the listener must stay outermost to win the waterfall')

  const seed = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', maxTokens: 1024 }
  assert.deepEqual(await bound.ask(seed), { ...seed, reasoningEffort: 'low' }, 'the default tier drops thinking to the lowest level')
  assert.deepEqual(await bound.ask({ ...seed, reasoningEffort: 'high' }), { ...seed, reasoningEffort: 'low' }, 'a stale effort is corrected')
  assert.deepEqual(await bound.ask({ ...seed, reasoningEffort: 'low' }), { ...seed, reasoningEffort: 'low' })

  harness.throttle(agent, '')
  assert.deepEqual(await bound.ask(seed), { ...seed, reasoningEffort: 'high' }, 'the deep tier switches thinking on')

  harness.throttle(agent, ' off')
  assert.deepEqual(await bound.ask(seed), seed, 'the free tier pins no effort at all')
  assert.deepEqual(
    await bound.ask({ ...seed, reasoningEffort: 'high' }),
    { ...seed, reasoningEffort: 'high' },
    'and it leaves the session\'s own effort untouched'
  )
})

test('a model that declares no reasoning capability is left untouched', async () => {
  const harness = fakeCtx({ modelInfo: { reasoning: undefined } })
  apply(harness.ctx, SHIPPED)
  const { bound } = await bindAgent(harness)
  const seed = { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' }
  assert.deepEqual(await bound.ask(seed), seed, 'an unsupported effort must be skipped rather than fail the turn')
})

test('a profile without the LLM service still applies no unvalidated effort', async () => {
  const harness = fakeCtx({ llm: false })
  apply(harness.ctx, SHIPPED)
  const { bound } = await bindAgent(harness)
  const seed = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }
  assert.deepEqual(await bound.ask(seed), seed)
})

test('reasoning capability is retried after failure and follows catalog updates', async () => {
  let info = new Error('catalog unavailable')
  const harness = fakeCtx({ resolveModelInfo: async () => {
    if (info instanceof Error) throw info
    return info
  } })
  apply(harness.ctx, SHIPPED)
  const { agent, bound } = await bindAgent(harness)
  const seed = { provider: 'test', model: 'model', reasoningEffort: 'medium' }
  assert.deepEqual(await bound.ask(seed), seed)
  info = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  assert.equal((await bound.ask(seed)).reasoningEffort, 'low')
  harness.throttle(agent, 'wide')
  assert.equal((await bound.ask(seed)).reasoningEffort, 'high')
  info = { reasoning: undefined }
  assert.deepEqual(await bound.ask(seed), seed)
  info = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  assert.equal((await bound.ask(seed)).reasoningEffort, 'high')
})

test('plugin reload attaches effort control to existing agents only once', async () => {
  const listeners = []
  let disposed = 0
  const harness = fakeCtx({ agents: { list: () => [agent] } })
  const agent = {
    session: harness.session,
    ctx: { on: (event, listener) => {
      assert.equal(event, 'agent/request')
      listeners.push(listener)
      return () => { disposed += 1 }
    } }
  }
  apply(harness.ctx, SHIPPED)
  await harness.emit('agent/created', { agent })
  assert.equal(listeners.length, 1)
  const seed = { provider: 'test', model: 'model', reasoningEffort: 'medium' }
  const ask = () => listeners[0]({}, async () => seed)
  assert.equal((await ask()).reasoningEffort, 'low')
  harness.throttle(agent, 'wide')
  assert.equal((await ask()).reasoningEffort, 'high')
  harness.throttle(agent, 'open')
  assert.deepEqual(await ask(), seed)
  for (const factory of harness.captured.effects) factory()()
  assert.equal(disposed, 1)
})

test('the guard only counts sessions the plugin has seen', () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const [guard] = harness.captured.guards
  assert.equal(guard({ agent: { session: { header: { id: 'session-unseen' } } } }), undefined)
  assert.equal(guard({}), undefined)
})

test('the guard refuses calls once the default step ceiling is reached, through the real plugin path', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  const [guard] = harness.captured.guards
  for (let step = 1; step <= 4; step += 1) {
    await harness.emit('agent/pre-step', { agent, turn: 3, step })
    for (let call = 1; call <= 3; call += 1) {
      assert.equal(guard({ agent }), undefined, `step ${step}, call ${call} is inside the ceiling`)
    }
  }
  await harness.emit('agent/pre-step', { agent, turn: 3, step: 5 })
  assert.match(guard({ agent }), /the 4-step ceiling is reached/, 'the over-limit step may not call tools')
  assert.match(guard({ agent }), /the 4-step ceiling is reached/, 'the refusal holds for the rest of the step')
  await harness.emit('agent/pre-step', { agent, turn: 4, step: 1 })
  assert.equal(guard({ agent }), undefined, 'a new turn opens a fresh ceiling')
})

test('a turn start opens the ceiling before the runtime context is rendered', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  const render = () => harness.captured.contexts[0].text({ agent })

  // Nothing to report before any turn: the record cannot be enforced yet.
  assert.ok(!render().includes('This turn:'))

  await harness.emit('agent/pre-step', { agent, turn: 1, step: 3 })
  assert.match(render(), /This turn: step 3\/4 · /, 'the step the loop is on is what the snapshot counts')

  // The Harness commits `turn/start` before it assembles this turn's prompt, so
  // the snapshot the new turn carries is already its own.
  harness.appendEvent(harness.session, { type: 'turn/start', data: { turn: 2 }, time: Date.now() })
  assert.match(render(), /This turn: step 1\/4 · 0\.0\/2 min\./)
  assert.ok(!render().includes('ceiling is reached'))
  const [guard] = harness.captured.guards
  assert.equal(guard({ agent }), undefined, 'and the new turn may use its tools')
})

test('the same guard never refuses in the free tier', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  harness.throttle(agent, ' off')
  const [guard] = harness.captured.guards
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    assert.equal(guard({ agent }), undefined, `free call ${attempt} must never be refused`)
  }
})

test('the tier survives a restart by replaying the log', async () => {
  const harness = fakeCtx({ preset: 'workspace-write' })
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  await harness.emit('agent/pre-step', { agent, turn: 1, step: 1 })
  harness.throttle(agent, ' deep')
  assert.equal(harness.service.preset, 'workspace-write')
  const log = harness.registry.logs.get('session-1')

  // A new process: the same log, a fresh plugin instance and projection.
  const restarted = fakeCtx({ preset: 'workspace-write', log })
  apply(restarted.ctx, SHIPPED)
  const { bound } = await bindAgent(restarted)
  const seed = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }
  assert.deepEqual(await bound.ask(seed), { ...seed, reasoningEffort: 'high' }, 'the resumed session is still deep')
  const agent2 = { session: restarted.session }
  assert.match(restarted.captured.sections[0].text({ agent: agent2 }), /current tier: Wide/, 'and it says so in the prompt')
  assert.match(restarted.captured.contexts[0].text({ agent: agent2 }), /\[throttle:state\] tier: Wide/)

  // The free tier replays too — that is the whole point of the third state.
  harness.throttle(agent, ' off')
  const restartedFree = fakeCtx({ preset: 'workspace-write', log: harness.registry.logs.get('session-1') })
  apply(restartedFree.ctx, SHIPPED)
  const freeAgent = { session: restartedFree.session }
  assert.match(restartedFree.captured.sections[0].text({ agent: freeAgent }), /current tier: Open/)
  assert.match(restartedFree.captured.contexts[0].text({ agent: freeAgent }), /\[throttle:state\] tier: Open/)
})

test('tier switching degrades gracefully without the permission service', () => {
  const harness = fakeCtx({ permissions: false })
  apply(harness.ctx, SHIPPED)
  const agent = { session: harness.session }
  const deep = harness.throttle(agent, ' deep')
  assert.equal(deep.kind, 'success')
  assert.match(deep.text, /preset restored \(kept as is\)/)
  const free = harness.throttle(agent, ' off')
  assert.equal(free.kind, 'success')
  assert.match(free.text, /^♾️ Open · no ceiling · no reasoning override · preset left alone \(kept as is\)/)
  const section = harness.captured.sections[0].text({ agent })
  assert.match(section, /current tier: Open/)
  assert.match(section, /unknown \(the permission service is unavailable\)/, 'a missing service is reported as unknown rather than guessed')
})

test('both model-facing channels decline to render without an agent', () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const [section] = harness.captured.sections
  const [context] = harness.captured.contexts
  assert.equal(section.text({}), '')
  assert.equal(section.name, 'throttle:policy')
  assert.equal(section.interpolate, false)
  assert.equal(context.text({}), '')
})

test('installer preserves custom reasoning declarations during dry run', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'throttle-install-'))
  try {
    const profile = join(fixture, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}')
    const patch = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      custom:',
      '        models:',
      '          - id: mapped',
      '            reasoningEfforts:',
      '              low: minimal',
      '              high: ultra',
      '          - id: inline',
      '            reasoningEfforts: { low: low, high: high }',
      '          - id: disabled',
      '            reasoningEfforts: false',
      '          - id: missing',
      ''
    ].join('\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../tools/install-dsh-throttle.mjs', import.meta.url))], {
      env: { ...process.env, DSH_HOME: fixture }, encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    for (const id of ['mapped', 'inline', 'disabled']) {
      assert.ok(result.stdout.includes(`model ${id}: keep existing reasoningEfforts`))
    }
    assert.match(result.stdout, /missing: declare reasoningEfforts/)
    assert.doesNotMatch(result.stdout, /rewrite reasoningEfforts/)
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patch)
  } finally {
    // 仅清理本测试由 mkdtemp 创建的隔离目录。
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('unloading the plugin detaches every agent listener', async () => {
  const harness = fakeCtx()
  apply(harness.ctx, SHIPPED)
  const disposed = []
  const agent = { session: harness.session, ctx: { on: () => () => disposed.push('agent') } }
  await harness.emit('agent/created', { agent })
  await harness.emit('agent/disposed', { agent })
  assert.deepEqual(disposed, ['agent'])
})
