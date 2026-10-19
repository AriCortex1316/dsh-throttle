/**
 * Headless render probe for `dsh-throttle`'s browser half.
 *
 * The client bundle is plain JavaScript with no build step, so it can be loaded
 * and driven here in Node: this script installs the `window.__ModuleLoader__`
 * facade the bundle expects, supplies a tiny React-compatible double (enough of
 * `createElement`/`useState`/`Fragment` to render a function component twice),
 * stubs the Host primitives, and then
 *
 * 1. calls `apply` and checks the two slot registrations and their inject faces,
 * 2. renders the tier chip and its panel, including a real tier switch,
 * 3. renders the configuration page over a fake settings form, stages an edit,
 *    and checks the exact operation a save would send.
 *
 * It is not a substitute for looking at the page in the app; it is what catches
 * a wrong slot key, a missing dictionary entry, a bad prop name, or an op the
 * settings service would refuse — before a restart.
 *
 * Usage: node tools/probe-throttle-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let failures = 0
/** Assert one behaviour. */
function check (label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── a React double with per-component hook state ─────────────────────────────
const FRAGMENT = Symbol('Fragment')
let instance = null
const React = {
  Fragment: FRAGMENT,
  createElement (type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) } }
  },
  useState (initial) {
    const record = instance
    const slot = record.index++
    if (record.states.length <= slot) record.states[slot] = typeof initial === 'function' ? initial() : initial
    return [record.states[slot], (next) => { record.states[slot] = typeof next === 'function' ? next(record.states[slot]) : next }]
  },
  useRef (value) {
    const record = instance
    const slot = record.index++
    if (record.refs[slot] === undefined) record.refs[slot] = { current: value }
    return record.refs[slot]
  },
  /**
   * Queue an effect, comparing dependencies the way React does. Both this and
   * `useRef` are keyed by hook slot: a ref rebuilt on every render would drop the
   * very things the panel holds across renders (its deadline timer, its unmount
   * flag), and a no-op `useEffect` would never exercise them at all.
   */
  useEffect (effect, deps) {
    const record = instance
    const slot = record.index++
    const previous = record.effects[slot]
    const changed = previous === undefined || deps === undefined || previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((dep, index) => !Object.is(dep, previous.deps[index]))
    if (changed) record.pending.push({ slot, effect, deps })
  },
  useMemo (factory) { return factory() },
  useCallback (fn) { return fn }
}
/** Hooks state per component function, so a second render resumes the first. */
const instances = new Map()

/**
 * Run the effects one component queued during its render, the way React does
 * after a commit: the previous run's cleanup first, then the effect itself.
 * @param record - the component's hook record.
 */
function flushEffects (record) {
  const queued = record.pending.splice(0, record.pending.length)
  for (const { slot, effect, deps } of queued) {
    const previous = record.effects[slot]
    if (previous !== undefined && previous.cleanup !== undefined) previous.cleanup()
    record.effects[slot] = { deps, cleanup: effect() }
  }
}

/** Let every pending microtask (and so the probe's promise chains) run. */
const settle = async () => { await new Promise((resolve) => { setImmediate(resolve) }) }
/** Every Host primitive the components rendered, in depth-first order. */
const stubs = []
const primitives = new Proxy({}, {
  get: (_target, name) => (props) => {
    stubs.push({ name: String(name), props })
    return { type: `stub:${String(name)}`, props }
  }
})

/** Text of a stub's children, however the React double wrapped them. */
const stubText = (stub) => [].concat(stub.props.children ?? []).join('')

/** Render an element tree to text, calling function components and recording stubs. */
function render (node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    const key = node.type
    const record = instances.get(key) ?? { index: 0, states: [], refs: [], effects: [], pending: [] }
    const previous = instance
    instance = record
    record.index = 0
    instances.set(key, record)
    try {
      const output = render(node.type({ ...node.props }))
      flushEffects(record)
      return output
    } finally {
      instance = previous
    }
  }
  // A Host primitive stub: the real components render these prop channels too,
  // so the probe walks them to reach buttons and text that ride props.
  return [node.props?.children, node.props?.footer, node.props?.description, node.props?.label].map(render).join('')
}

// ── load the bundle exactly as the shell does ────────────────────────────────
const source = readFileSync(join(root, 'dsh-throttle', 'client.js'), 'utf8')
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load (entry) {
      loaded = entry
    }
  }
}
// The bundle is a browser script: run it with the facade in place.
new Function('window', `${source}\n`)(globalThis.window)
check('the bundle registers its factory', loaded !== null && loaded.id === 'dsh-throttle')
const module = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  return primitives
})
check('the factory exports inject + apply', Array.isArray(module.inject) && typeof module.apply === 'function', JSON.stringify(module.inject))
check('the factory declares the services its two surfaces use',
  JSON.stringify(module.inject) === JSON.stringify(['slots', 'locale', 'remote', 'remote.commands']),
  JSON.stringify(module.inject))
// An undeclared service is not a load-time failure: the Cordis guard answers the
// *read* with a synchronous throw, so a bundle that touches `ctx.remote.commands`
// without declaring it passes every activation check and then fails on the first
// click. That is exactly how the tier switch was broken once, so the requirement
// is derived from the source here rather than restated by hand.
const usedRemoteNamespaces = [...new Set([...source.matchAll(/\bctx\.remote\.([A-Za-z_$][\w$]*)/g)].map((match) => `remote.${match[1]}`))]
check('every remote namespace the bundle reads is declared in inject',
  usedRemoteNamespaces.every((name) => module.inject.includes(name)),
  `reads [${usedRemoteNamespaces.join(', ')}] · inject [${module.inject.join(', ')}]`)

// ── the dictionaries ─────────────────────────────────────────────────────────
const dictionaries = {}
const zh = {}
const t = (key, params) => {
  const template = zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}
const registrations = []
const executed = []
const opened = []
const injectedDeps = []
const requestedNamespaces = []
const servedNamespaces = []
const formState = {
  status: 'ready',
  value: { default: { steps: 4, minutes: 2, effort: 'low', permission: 'read-only' }, deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' } },
  user: { deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' } },
  writable: true,
  revision: 7
}
const writes = []
/** The `configForms` scope the settings domain would hand out for `throttle`. */
const scope = {
  getSnapshot: () => formState,
  subscribe: () => () => {},
  mutate: async (ops, revision) => { writes.push({ ops, revision }); return true }
}
const configForms = {
  get: (namespace) => { requestedNamespaces.push(namespace); return scope },
  whileServed: (namespaces, register) => {
    servedNamespaces.push(namespaces)
    register(new Set(namespaces))
    return () => {}
  }
}
const navigation = { openBundle: (name) => { opened.push(name) } }
const ctx = {
  locale: {
    bind: () => t,
    register: (ns, dicts) => {
      dictionaries[ns] = dicts
      Object.assign(zh, dicts.zh)
      return () => {}
    }
  },
  effect: (factory) => { factory() },
  get: (key) => (key === 'pluginNavigation' ? navigation : undefined),
  configForms,
  inject: (deps, callback) => { injectedDeps.push(deps); callback(ctx) },
  slots: {
    inject: (key, callback) => { callback() },
    register: (options, Component) => { registrations.push({ options, Component }); return () => {} }
  },
  // The Cordis service accessor, faithfully: `remote.commands` is a service of its
  // own, and reading a namespace this bundle did not declare throws right there.
  // A plain object would hide exactly the defect this probe has to catch — an
  // undeclared service used to pass every check and then break the first click.
  remote: new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined
      if (!module.inject.includes(`remote.${name}`)) {
        throw new Error(`cannot get property "remote.${name}" without inject`)
      }
      return {
        execute: async (sessionId, line) => {
          executed.push({ sessionId, line })
          return { ok: true, value: { commandId: 'c1' } }
        }
      }
    }
  })
}
module.apply(ctx)
// Prove the accessor above really enforces declarations: without this, "the switch
// works" could pass on a ctx that never checked the inject list at all.
let guardRefusal = null
try { void ctx.remote.session } catch (error) { guardRefusal = error }
check('the service accessor refuses a remote namespace this bundle did not declare',
  guardRefusal !== null && /without inject/.test(String(guardRefusal.message)) &&
  module.inject.includes('remote.commands'),
  String(guardRefusal))
check('both dictionaries are registered', dictionaries.dshThrottle !== undefined && Object.keys(dictionaries.dshThrottle).length === 2)
// `en` is the source of truth and `zh` its translation, so a key on one side and
// not the other is a bug: everything below renders through whichever dictionary
// this probe bound, and would silently pass in the other locale.
const en = dictionaries.dshThrottle.en
const missingInZh = Object.keys(en).filter((key) => zh[key] === undefined)
const extraInZh = Object.keys(zh).filter((key) => en[key] === undefined)
check('the zh dictionary covers every en key and adds none',
  missingInZh.length === 0 && extraInZh.length === 0,
  `missing in zh: [${missingInZh.join(', ')}] | only in zh: [${extraInZh.join(', ')}]`)
check('two slot entries are registered', registrations.length === 2, registrations.map((r) => r.options.name).join(', '))
const chip = registrations.find((r) => r.options.name === 'conversation.input.right')
const page = registrations.find((r) => r.options.name === 'plugins.bundle.config')
check('the chip registers into the composer bar, immediately before the model selector',
  chip !== undefined && chip.options.id === 'throttle-tier',
  registrations.map((r) => r.options.name).join(', '))
check('the config page claims the bundle card', page !== undefined && page.options.key === 'dsh-throttle' && page.options.id === 'dsh-throttle')
check('the config page is registered behind the settings service', JSON.stringify(injectedDeps) === JSON.stringify([['configForms']]), JSON.stringify(injectedDeps))
check('it edits the throttle entry', JSON.stringify(requestedNamespaces) === JSON.stringify(['throttle']), JSON.stringify(requestedNamespaces))
check('and only while the Host serves that namespace', JSON.stringify(servedNamespaces) === JSON.stringify([['throttle']]), JSON.stringify(servedNamespaces))

// ── a deployment without the settings service registers no page ──────────────
const bareRegistrations = []
const bareCtx = {
  ...ctx,
  configForms: undefined,
  inject: () => {},
  slots: { inject: (key, callback) => { callback() }, register: (options, Component) => { bareRegistrations.push({ options, Component }); return () => {} } }
}
module.apply(bareCtx)
check('a composition without dsh-settings keeps the chip and drops the page',
  bareRegistrations.length === 1 && bareRegistrations[0].options.id === 'throttle-tier',
  bareRegistrations.map((r) => r.options.name).join(', '))

// ── the chip and its panel ───────────────────────────────────────────────────
const view = {
  mode: 'deep',
  running: false,
  tiers: {
    default: { kind: 'steps', max: 4, minutes: 2, effort: 'low' },
    deep: { kind: 'steps', max: 5, minutes: 5, effort: 'high' },
    free: { kind: 'unlimited', max: null, minutes: null, effort: null }
  }
}
const sessionId = 'session-1'
let projected = view
stubs.length = 0
const chipFace = chip.options.inject(sessionId)
const chipText = render(React.createElement(chip.Component, {
  t,
  useProjection: () => projected,
  ...chipFace
}))
check('the chip shows the current tier', chipText.includes('放宽'), chipText)
check('the chip tooltip carries the ceiling', stubs.some((s) => s.name === 'Tooltip' && String(s.props.label).includes('≤5 步 · ≤5 分钟')), JSON.stringify(stubs.find((s) => s.name === 'Tooltip')?.props.label))
// The chip lives in the composer at the bottom of the window: a tooltip opening
// downwards would be clipped, which is why the model selector's opens upwards too.
check('and it opens upwards, out of the bottom bar',
  stubs.some((s) => s.name === 'Tooltip' && s.props.side === 'top'),
  String(stubs.find((s) => s.name === 'Tooltip')?.props.side))
check('the chip renders nothing before the first projection frame',
  render(React.createElement(chip.Component, { t, useProjection: () => undefined, ...chipFace })) === '')

stubs.length = 0
const chipElement = React.createElement(chip.Component, { t, useProjection: () => view, ...chipFace })
render(chipElement)
const chipButton = stubs.find((s) => s.name === 'Button')
check('the chip is a button', chipButton !== undefined)
// Open the panel the way the user does, then render the component again: the
// probe's React double keeps hook state per component, so the second pass sees
// the panel the click opened.
chipButton.props.onClick()
stubs.length = 0
const panelText = render(chipElement)
const segmented = stubs.find((s) => s.name === 'SegmentedControl')
check('the panel offers a three-way tier switch',
  segmented !== undefined && segmented.props.options.map((option) => option.label).join(',') === '收紧,放宽,放开',
  segmented === undefined ? 'no SegmentedControl rendered' : JSON.stringify(segmented.props.options.map((o) => o.label)))
check('the panel marks the current tier', segmented.props.value === 'deep')
check('the panel states the current tier facts',
  panelText.includes('≤5 步 · ≤5 分钟') && panelText.includes('high') && panelText.includes('/throttle wide') &&
  panelText.includes('恢复会话预设') && panelText.includes('继承档子会话仅释放有来源记录的插件限制'),
  panelText)
check('the panel is a modal', stubs.some((s) => s.name === 'Modal'))
const configureButton = stubs.find((s) => s.name === 'Button' && stubText(s) === '配置上限…')
check('the panel offers the plugin page', configureButton !== undefined)
configureButton.props.onClick()
check('which opens the bundle page on the Plugins page', opened.join(',') === 'dsh-throttle', JSON.stringify(opened))
// Switch away from the current tier through the control the user clicks.
await segmented.props.onChange('free')
await settle()
check('switching executes the matching /throttle line', executed.length === 1 && executed[0].line === '/throttle open' && executed[0].sessionId === sessionId, JSON.stringify(executed))

// ── the switch must never be able to strand the panel ────────────────────────
/**
 * Open the panel over a fresh projection and report the switch's state after a
 * click. A modal that cannot be released is worse than a switch that failed, so
 * each way the request can go wrong is exercised here.
 * @param changeTier - the injected switch verb to drive.
 * @returns the opened panel, with `click` and a re-render `frame`.
 */
function openPanel (changeTier) {
  instances.clear()
  stubs.length = 0
  let current = view
  const element = React.createElement(chip.Component, { t, ...chipFace, changeTier, useProjection: () => current })
  render(element)
  stubs.find((s) => s.name === 'Button').props.onClick()
  /**
   * Re-render the panel, optionally as a frame carrying a new projection value.
   * @param projection - the projection value this frame carries.
   * @returns the switch control, its disabled flag, and the panel's text.
   */
  const frame = (projection) => {
    if (projection !== undefined) current = projection
    stubs.length = 0
    const text = render(element)
    const control = stubs.find((s) => s.name === 'SegmentedControl')
    return { control, disabled: control === undefined ? undefined : control.props.disabled, text }
  }
  const opened = frame()
  return { opened, frame, click: (next) => { opened.control.props.onChange(next) } }
}

const threw = openPanel(() => { throw new Error('changeTier is not a function') })
threw.click('free')
const afterThrow = threw.frame()
check('a switch that throws synchronously releases the panel instead of greying it',
  afterThrow.disabled === false && afterThrow.text.includes('changeTier is not a function'),
  `disabled=${String(afterThrow.disabled)} text=${afterThrow.text.slice(0, 140)}`)

const rejected = openPanel(() => Promise.reject(new Error('channel closed')))
rejected.click('free')
await settle()
const afterReject = rejected.frame()
check('a rejected switch reports itself and releases the panel',
  afterReject.disabled === false && afterReject.text.includes('channel closed'),
  `disabled=${String(afterReject.disabled)} text=${afterReject.text.slice(0, 140)}`)

const lostReply = openPanel(() => new Promise(() => {}))
lostReply.click('free')
check('a switch still in flight keeps the control disabled', lostReply.frame().disabled === true)
// The Host writes `command/run` and then `command/done`, so those two frames are
// what a real lost reply is followed by — the second one must free the switch.
check('and the Host frame releases it even though the reply never arrived',
  lostReply.frame({ ...view, running: true }).disabled === true &&
  lostReply.frame({ ...view, running: false }).disabled === false)

// ── a deployment without the command transport says so ───────────────────────
const noTransport = {
  ...ctx,
  remote: undefined,
  get: () => undefined,
  slots: { inject: (key, callback) => { callback() }, register: (options, Component) => { noTransportRegistrations.push({ options, Component }); return () => {} } }
}
const noTransportRegistrations = []
module.apply(noTransport)
const bareFace = noTransportRegistrations.find((r) => r.options.id === 'throttle-tier').options.inject(sessionId)
check('a missing command channel becomes a readable message, not a crash',
  (await bareFace.changeTier('off')) === '这个部署没有提供命令通道，请直接在输入框里打 /throttle。')
check('the bundle navigation verb is absent without the plugin manager', bareFace.configure === undefined)

// ── the configuration page ───────────────────────────────────────────────────
const pageFace = page.options.inject()
const useThrottleConfig = (selector) => selector(formState)
const pageProps = { t, view: 'page', useThrottleConfig, save: pageFace.save }
const pageElement = React.createElement(page.Component, pageProps)
instances.clear()
stubs.length = 0
const pageText = render(pageElement)
const fieldIds = ['default-steps', 'default-minutes', 'default-effort', 'default-permission', 'deep-steps', 'deep-minutes', 'deep-effort', 'deep-permission']
const fields = stubs.filter((s) => s.name === 'SettingsValueField')
check('the page renders one control per editable field', fields.length === 8, fields.map((f) => f.props.id).join(', '))
check('every control is the field the Host declares',
  fieldIds.every((id) => fields.some((f) => f.props.id === `dsh-throttle-${id}`)), JSON.stringify(fields.map((f) => f.props.id)))
check('each control carries the current value and its explanation',
  fields.find((f) => f.props.id === 'dsh-throttle-deep-steps')?.props.text === '5' &&
  String(fields.find((f) => f.props.id === 'dsh-throttle-default-effort')?.props.help?.content).includes('模型真实声明过'),
  JSON.stringify(fields.find((f) => f.props.id === 'dsh-throttle-deep-steps')?.props))
check('the page explains how a save takes effect', pageText.includes('改完怎么生效') && pageText.includes('后续检查'), pageText.slice(0, 200))
// The introduction sits at the very top of the page, above the form it introduces
// and above the paragraph that explains the two editable blocks.
check('the page opens with the plugin introduction',
  pageText.includes('简介') && pageText.includes('dsh-throttle（DSH 节流器）') &&
  pageText.includes('通过不同档位，对 DSH 的深度探索进行强制节流。') &&
  pageText.indexOf('通过不同档位') < pageText.indexOf('下面两组数字'),
  pageText.slice(0, 200))
check('the introduction lists the five situations and states its goal',
  ['补充缺失细节后再继续', '中途调整任务方向', '检查当前结论是否符合预期', '在一轮跑得过久或跑偏时提前收手',
    '防止简单问题演变成没完没了的深度探索', '核心目标不是降低 DSH 的能力'].every((line) => pageText.includes(line)),
  pageText.slice(0, 400))
// The last line of the block is the one line of usage, and it stays inside the
// block: the goal paragraph precedes it, the form's own explanation follows it.
check('the introduction closes with one line of usage',
  pageText.includes('用法：点模型选择器旁边的档位徽章切档') &&
  pageText.indexOf('核心目标不是降低 DSH 的能力') < pageText.indexOf('用法：点模型选择器旁边的档位徽章切档') &&
  pageText.indexOf('用法：点模型选择器旁边的档位徽章切档') < pageText.indexOf('下面两组数字'),
  pageText.slice(0, 600))
check('the overridden block is marked as such', stubs.some((s) => s.name === 'Tag' && stubText(s) === '已覆盖'))
check('the untouched block is marked as the built-in default', stubs.some((s) => s.name === 'Tag' && stubText(s) === '内置默认'))
// A Chinese UI is what this probe bound, but the page also runs under `en`, and
// the key-parity check above only proves the keys exist — not that the English
// half reads as the introduction it is meant to be.
stubs.length = 0
const englishPageText = render(React.createElement(page.Component, {
  ...pageProps,
  t: (key, params) => {
    const template = en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
  }
}))
check('the same page renders the English introduction under an English UI',
  englishPageText.includes('A throttling layer for DSH that limits excessive deep exploration') &&
  englishPageText.includes('Preventing simple requests from turning into endless deep exploration') &&
  englishPageText.includes('The goal is not to reduce DSH’s capability') &&
  englishPageText.includes('How to use it: switch tiers from the chip beside the model selector'),
  englishPageText.slice(0, 240))

// Stage one edit the way the control reports it, then render the SAME component
// again: the probe's React double keeps hook state per component across passes.
fields.find((f) => f.props.id === 'dsh-throttle-deep-steps').props.onEdit('9')
stubs.length = 0
render(pageElement)
const staged = stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-deep-steps')
check('a staged edit stays on screen', staged.props.text === '9', String(staged.props.text))
check('a staged edit is marked unsaved', staged.props.overridden === true && staged.props.overriddenLabel === '待保存', JSON.stringify(staged.props.overriddenLabel))
const saveButton = stubs.filter((s) => s.name === 'Button').find((s) => s.props.variant === 'primary')
check('save becomes available with a staged edit', saveButton !== undefined && saveButton.props.disabled === false)
await saveButton.props.onClick()
check('save sends one nested operation with the revision it read',
  writes.length === 1 && writes[0].revision === 7 &&
  JSON.stringify(writes[0].ops) === JSON.stringify([{ op: 'set', path: ['deep', 'steps'], value: 9 }]),
  JSON.stringify(writes))

// A draft below the Host floor blocks the save instead of being sent.
stubs.length = 0
render(pageElement)
check('a saved edit is cleared from the form',
  stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-deep-steps').props.text === '5')
stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-deep-steps').props.onEdit('3')
stubs.length = 0
render(pageElement)
const invalid = stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-deep-steps')
const blocked = stubs.filter((s) => s.name === 'Button').find((s) => s.props.variant === 'primary')
check('a draft below the Host floor is shown as invalid', invalid.props.invalid === true, JSON.stringify(invalid.props.invalid))
check('and the save is blocked', blocked.props.disabled === true)
check('no write is sent for it', writes.length === 1, JSON.stringify(writes.map((w) => w.ops)))

// The cross-field rule no single field's schema can state: raising the Tight
// ceiling onto the Wide one is a pair the Host refuses and answers by falling
// back to its built-in numbers, so the form must block it before it lands.
stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-deep-steps').props.onReset()
stubs.length = 0
render(pageElement)
stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-default-steps').props.onEdit('5')
stubs.length = 0
const orderText = render(pageElement)
const orderBlocked = stubs.filter((s) => s.name === 'Button').find((s) => s.props.variant === 'primary')
check('raising the Tight ceiling onto the Wide one blocks the save', orderBlocked.props.disabled === true)
check('and the page names the refused pair', orderText.includes('放宽档步数（5）必须大于收紧档步数（5）'), orderText.slice(-400))
check('no write is sent for that either', writes.length === 1, JSON.stringify(writes.map((w) => w.ops)))
stubs.filter((s) => s.name === 'SettingsValueField').find((f) => f.props.id === 'dsh-throttle-default-steps').props.onReset()
check('the summary view is a one-liner', render(React.createElement(page.Component, { ...pageProps, view: 'summary' })) === '三档档位，以及每轮的上限、思考等级与权限。')
const unavailable = render(React.createElement(page.Component, { ...pageProps, useThrottleConfig: (selector) => selector(undefined) }))
check('a form the Host does not serve says so', unavailable.includes('没有提供插件设置表单'), unavailable)
const loading = render(React.createElement(page.Component, { ...pageProps, useThrottleConfig: (selector) => selector({ status: 'loading' }) }))
check('a form still loading says so instead of showing empty boxes', loading.includes('正在读取当前配置'), loading)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
