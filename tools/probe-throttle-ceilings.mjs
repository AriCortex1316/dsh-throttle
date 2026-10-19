/**
 * Offline probe for two counting questions about `dsh-throttle`:
 *
 * A. **the ceiling unit and its legacy spelling** — `resolveConfig` reads
 *    `default.toolCalls` as an alias for `default.steps`, and that alias is only
 *    reachable because the `Config` schema declares no default for `steps`.
 *    Cordis resolves the row through that schema *before* `apply()` runs, so a
 *    schema default there would silently overwrite whatever the patch said.
 *    This section runs the real schema over the real config and shows which
 *    value survives.
 * B. **whose ceiling a step is charged to** — the plugin keys its ceiling by the
 *    session object, and a `subagent` child with no `/throttle` of its own
 *    inherits the tier of the session that delegated to it. This section drives
 *    the real plugin with a parent session and a child session and shows both.
 *
 * Usage:
 *
 *     node tools/probe-throttle-ceilings.mjs
 *     node tools/probe-throttle-ceilings.mjs <schemasteryDir> <zodDir>
 *
 * Without the two package arguments, section A reports itself as skipped (it
 * needs the real `@deepseek-ai/schemastery` to be meaningful); section B needs
 * no dependency at all. See the README's "offline checks" for how to extract
 * those packages from the installation.
 */
import { loadThrottleSchema } from './load-throttle-schema.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const [schemaDir, zodDir] = process.argv.slice(2)

/** Fail loudly with a labelled message. */
function check (label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`ok   ${label}`)
}

/** Print a finding that is a fact, not a pass/fail assertion. */
function note (label) {
  console.log(`     ${label}`)
}

// ── A. the ceiling unit: steps, and what the legacy alias really does ────────
console.log('\n── A. the ceiling unit (steps vs the legacy toolCalls alias) ──')

if (schemaDir === undefined) {
  note('skipped: pass <schemasteryDir> <zodDir> to run it against the real schema')
} else {
  const { schemastery, plugin, state } = await loadThrottleSchema(schemaDir, zodDir)
  const Config = plugin.Config

  // What a profile patch that predates the rename still says.
  const legacy = { default: { toolCalls: 6 }, deep: { steps: 7 } }
  const [resolved] = schemastery.resolve(legacy, Config)
  const asApplySeesIt = resolved.default.get()
  note(`schema output for default: ${JSON.stringify(asApplySeesIt)}`)
  check('the schema leaves the Tight step ceiling unfilled',
    asApplySeesIt.steps === undefined && asApplySeesIt.toolCalls === 6, JSON.stringify(asApplySeesIt))
  check('so the alias decides: the patch really means 6 steps',
    state.resolveConfig({ default: asApplySeesIt, deep: { steps: 7 } }).default.steps === 6,
    String(state.resolveConfig({ default: asApplySeesIt, deep: { steps: 7 } }).default.steps))
  const bare = schemastery.resolve({}, Config)[0].default.get()
  check('and a patch that says neither still gets the built-in 4',
    state.resolveConfig({ default: bare, deep: { steps: 7 } }).default.steps === 4,
    `${JSON.stringify(bare)} → ${state.resolveConfig({ default: bare, deep: { steps: 7 } }).default.steps}`)

  // The cross-field rule the schema cannot express. The form can write it, the
  // plugin refuses it, and `apply()` falls back to the built-in numbers — which
  // is why that fallback is now named in the model-facing snapshot.
  let accepted = null
  try { schemastery.resolve({ default: { steps: 6 }, deep: { steps: 5 } }, Config) } catch (error) { accepted = error }
  note(`schema verdict on default.steps 6 + deep.steps 5: ${accepted === null ? 'accepted' : 'refused'}`)
  let refused = null
  try { state.resolveConfig({ default: { steps: 6 }, deep: { steps: 5 } }) } catch (error) { refused = error }
  note(`plugin verdict on the same pair: ${refused === null ? 'accepted' : refused.message}`)
}

// ── B. the ceiling record: one per session, and a child inherits the tier ────
console.log('\n── B. the ceiling record: one per session, plus the inherited tier ──')

const { apply } = await import(pathToFileURL(join(root, 'dsh-throttle', 'index.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'dsh-throttle', 'state.js')).href)

/** The live profile's numbers (Tight 4/2, Wide 10/15). */
const CONFIG = resolveConfig({
  default: { steps: 4, minutes: 2, effort: 'low', permission: 'read-only' },
  deep: { steps: 10, minutes: 15, effort: 'high', permission: 'restore' }
})

/**
 * A Cordis double: per-session permission presets, a projection registry that
 * folds each session's own log, the plugin's registrations captured so the
 * probe can drive them like the Harness does, and a delegating parent.
 * @param parentPreset - the preset the delegating session holds.
 * @param childPreset - the preset the child session derives before the plugin sees it.
 */
function harness (parentPreset, childPreset) {
  const presets = ['read-only', 'workspace-write', 'danger-full-access']
  const captured = { commands: [], contexts: [], guards: [], events: new Map() }
  const logs = new Map()
  const folded = new Map()
  const cache = new Map()
  const byPreset = new Map()
  let definition = null

  const idOf = (session) => String(session.header.id)
  const parent = { header: { id: 'parent' } }
  const child = { header: { id: 'child', origin: 'subagent', parentSession: 'parent' } }
  // The Harness pinned the parent's preset at publish time, and the delegation
  // seeded the child with a scope and no preset of its own.
  append(parent, { type: 'permission/preset', data: { preset: parentPreset } })
  append(child, { type: 'sandbox/mode', data: { mode: 'workspace-write', source: 'delegation' } })
  append(child, { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } })
  byPreset.set(parent, parentPreset)
  byPreset.set(child, childPreset)

  function append (session, event) {
    const id = idOf(session)
    const log = logs.get(id) ?? []
    log.push(event)
    logs.set(id, log)
  }
  /** Commit one event the way the Harness does: log first, then broadcast. */
  function commit (session, event) {
    const committed = { time: Date.now(), ...event }
    append(session, committed)
    for (const listener of captured.events.get('session/event') ?? []) listener(session, committed)
    return committed
  }

  const service = {
    names: presets,
    current: (session) => byPreset.get(session) ?? 'custom',
    set: (session, next) => {
      if (!presets.includes(next)) throw new Error(`permission: unknown preset "${next}"`)
      if (service.current(session) !== next) append(session, { type: 'permission/preset', data: { preset: next } })
      byPreset.set(session, next)
    }
  }
  // The agent service is how a child resolves the session that delegated to it.
  const agents = { get: (id) => (id === 'parent' ? { session: parent } : undefined) }

  const ctx = {
    logger: { info () {}, warn (...args) { console.log(`     [warn] ${args.map(String).join(' ')}`) } },
    systemPrompt: {
      section: (section) => { captured.section = section; return () => {} },
      context: (entry) => { captured.contexts.push(entry); return () => {} },
      getContextOrder: (slot) => (slot === 'SANDBOX_POLICY' ? 110 : undefined)
    },
    commands: { register: (row) => { captured.commands.push(row); return () => {} } },
    tools: { guard: (guard) => { captured.guards.push(guard); return () => {} } },
    sessionProjections: {
      register (row) { definition = row; return () => { definition = null } },
      stateOf (session, key) {
        if (definition === null || key !== definition.key) return undefined
        const id = idOf(session)
        const log = logs.get(id) ?? []
        let value = cache.get(id) ?? definition.init()
        let index = folded.get(id) ?? 0
        for (; index < log.length; index += 1) value = definition.apply(value, log[index])
        cache.set(id, value)
        folded.set(id, log.length)
        return value
      }
    },
    on: (event, listener) => {
      const list = captured.events.get(event) ?? []
      list.push(listener)
      captured.events.set(event, list)
      return () => {}
    },
    effect: () => {},
    get: (key) => {
      if (key === 'permissionPresets') return service
      if (key === 'agents') return agents
      return undefined
    }
  }

  const emit = async (event, payload) => {
    for (const listener of captured.events.get(event) ?? []) {
      await listener(payload, async () => ({ kind: 'continue', messages: [] }))
    }
  }
  /** Run one /throttle line through the command pipeline's event order. */
  let counter = 0
  const throttle = (session, rawInput) => {
    const commandId = `cmd-${++counter}`
    append(session, { type: 'command/run', data: { commandId, name: 'throttle', args: rawInput, source: { kind: 'user' } } })
    const result = captured.commands[0].handler({ agent: { session }, rawInput, attachments: [], signal: new AbortController().signal })
    append(session, { type: 'command/done', data: { commandId, kind: result.kind === 'success' ? 'success' : 'error', text: result.text } })
    return result
  }

  apply(ctx, CONFIG)
  return {
    parent,
    child,
    service,
    emit,
    throttle,
    commit,
    owner: (session) => session === parent ? 'parent' : 'child',
    contextOf: (session) => captured.contexts[0].text({ agent: { session } }),
    guard: (session) => captured.guards[0]({ agent: { session } }),
    modeOf: (session) => ctx.sessionProjections.stateOf(session, 'throttleMode').mode,
    writes: (session) => (logs.get(idOf(session)) ?? []).filter((event) => event.type === 'permission/preset').length
  }
}

/** Step one session the way the loop does, with an optional clock reading. */
async function step (h, session, turn, stepNumber, at) {
  h.commit(session, { type: 'turn/start', data: { turn }, time: at })
  await h.emit('agent/pre-step', { agent: { session }, turn, step: stepNumber })
}

// Scenario 1: a Tight delegator keeps its child Tight and view-only.
{
  const h = harness('workspace-write', 'custom')
  await step(h, h.parent, 1, 1)
  await step(h, h.child, 1, 1)
  const text = h.contextOf(h.child)
  check('the child of a Tight session runs Tight', /tier: Tight/.test(text), text.split('\n')[0])
  check('and says the tier is inherited', /inherited from the session that delegated/.test(text))
  check('Tight still means view-only for a delegated child', h.service.current(h.child) === 'read-only', String(h.service.current(h.child)))
  let allowed = 0
  for (let n = 1; n <= 4; n += 1) {
    await step(h, h.child, 1, n)
    if (h.guard(h.child) === undefined) allowed += 1
  }
  check('the child may use tools on steps 1-4', allowed === 4, String(allowed))
  await step(h, h.child, 1, 5)
  check('its step 5 is refused by its own Tight ceiling',
    /the 4-step ceiling is reached/.test(h.guard(h.child) ?? ''), String(h.guard(h.child)))
}

// Scenario 2: a Wide delegator's child runs Wide, with a ceiling of its own.
{
  const h = harness('workspace-write', 'workspace-write')
  await step(h, h.parent, 1, 1)
  await step(h, h.child, 1, 1)
  const wide = h.throttle(h.parent, '')
  check('the delegator enters Wide', h.modeOf(h.parent) === 'deep' && /^⚡ Wide/.test(wide.text), wide.text.split('\n')[0])

  await step(h, h.child, 1, 2)
  const text = h.contextOf(h.child)
  check('the child follows it into Wide, with no record of its own',
    /tier: Wide/.test(text) && /≤10 steps/.test(text) && h.modeOf(h.child) === 'default',
    text.split('\n').slice(0, 2).join(' | '))
  check('and the plugin releases only the read-only pin it had written, twice in all',
    h.service.current(h.child) === 'workspace-write' && h.writes(h.child) === 2,
    `${String(h.service.current(h.child))} / ${h.writes(h.child)} writes`)
  check('the inherited scope is named as the delegation\'s, not the session\'s',
    /the scope this delegated sub-session was started with/.test(text), text.split('\n').find((line) => line.includes('scope')) ?? '')

  // The child's ceiling is Wide's, counted on the child's own record. Its first
  // step ran under Tight and was allowed; its second is the first Wide step.
  let allowed = 2
  check('the child could call tools on that first inherited Wide step',
    h.guard(h.child) === undefined, String(h.guard(h.child)))
  for (let n = 3; n <= 10; n += 1) {
    await step(h, h.child, 1, n)
    if (h.guard(h.child) === undefined) allowed += 1
  }
  check('the child may use tools on steps 1-10', allowed === 10, String(allowed))
  await step(h, h.child, 1, 11)
  check('and its step 11 is refused by the Wide ceiling',
    /the 10-step ceiling is reached/.test(h.guard(h.child) ?? ''), String(h.guard(h.child)))

  // Separation: eleven child steps never moved the delegator's own counter.
  await step(h, h.parent, 1, 2)
  check('the delegator is still inside its own ceiling after eleven child steps',
    h.guard(h.parent) === undefined, String(h.guard(h.parent)))
  check('and its snapshot counts only its own steps',
    /This turn: step 2\/10 ·/.test(h.contextOf(h.parent)),
    h.contextOf(h.parent).split('\n').filter((line) => line.includes('This turn')).join(''))
}

// 原始只读或无法按名称恢复的委派预设，不得兜底提升为可写。
for (const original of ['read-only', 'custom']) {
  const h = harness('workspace-write', original)
  await step(h, h.child, 1, 1)
  h.throttle(h.parent, 'open')
  await step(h, h.child, 1, 2)
  check(`继承 Open 不把 ${original} 委派权限提升为可写`,
    h.service.current(h.child) === 'read-only', String(h.service.current(h.child)))
}

// Scenario 3: the clock is shared, the step counter is not.
{
  const h = harness('workspace-write', 'custom')
  const opened = Date.now()
  h.commit(h.parent, { type: 'turn/start', data: { turn: 1 }, time: opened })
  await h.emit('agent/pre-step', { agent: { session: h.parent }, turn: 1, step: 1 })
  // The delegator sits inside the `subagent` call while the child works: its own
  // step counter does not move, but its turn's wall clock does.
  await step(h, h.child, 1, 1)
  const rightAfter = h.contextOf(h.parent)
  const realNow = Date.now
  try {
    Date.now = () => opened + 3 * 60_000
    check('the delegator is still on step 1 after a delegation it has not answered yet',
      /This turn: step 1\/4 ·/.test(rightAfter), rightAfter.split('\n').filter((line) => line.includes('This turn')).join(''))
    check('but three idle-for-it minutes are charged to its own Tight clock, so its tools are refused',
      /2-minute ceiling is reached/.test(h.guard(h.parent) ?? ''), String(h.guard(h.parent)))
  } finally {
    Date.now = realNow
  }
}

console.log('\nall checks passed')
