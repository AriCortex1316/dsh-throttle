/**
 * Offline probe for `dsh-throttle`'s settings schema.
 *
 * The plugin's `Config` is built from `@deepseek-ai/schemastery`, which the
 * plugin resolves only inside a running Harness (a linked profile plugin gets
 * installation packages through the profile-resolution router, gated on
 * `peerDependencies`). This probe reproduces that environment offline:
 *
 * 1. 通过 load-throttle-schema.mjs 复制完整运行源码到独立临时目录，
 *    将 schemas.js 的两个依赖入口指向调用方提供的真实包；
 * 2. it resolves configs through the real `Config` schema exactly as Cordis
 *    does, and checks the volatile references the settings form edits;
 * 3. it replays `dsh-settings`' own form algorithm (`volatileForm`, path
 *    validation, `strip`, `mergeLayers`) over that schema, so the shape this
 *    probe proves is the shape the Plugins page writes into the profile patch.
 *
 * Usage: node tools/probe-throttle-config.mjs <schemasteryDir> <zodDir>
 */
import { loadThrottleSchema } from './load-throttle-schema.mjs'
const schemaDir = process.argv[2]
const zodDir = process.argv[3]
if (schemaDir === undefined || zodDir === undefined) {
  throw new Error('usage: node tools/probe-throttle-config.mjs <schemastery package dir> <zod package dir>')
}

const { schemastery, plugin, state: { resolveConfig } } = await loadThrottleSchema(schemaDir, zodDir)

/** Fail loudly with a labelled message. */
function check (label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`ok   ${label}`)
}

check('schemastery resolved, so the settings form is available', plugin.settingsSchemaError() === null, String(plugin.settingsSchemaError()))
const Config = plugin.Config
check('the plugin exports a Config schema', Config !== undefined && typeof Config.toJSON === 'function')

// ── what dsh-settings reads: a volatile node per tier block ──────────────────
check('both tier blocks are volatile', Config.dict.default.meta?.volatile === true && Config.dict.deep.meta?.volatile === true, Object.keys(Config.dict).join(','))
check('volatility survives the JSON round-trip dsh-settings uses',
  JSON.stringify(Config.toJSON()).includes('"volatile":true'), 'plainSchema() rebuilds from toJSON()')

// ── what Cordis does on load: resolve the row config into references ─────────
const SHIPPED = {
  default: { steps: 4, minutes: 2, effort: 'low', permission: 'read-only' },
  deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' }
}
const [resolved] = schemastery.resolve(SHIPPED, Config)
check('the config blocks arrive as stable references', typeof resolved.default.get === 'function' && typeof resolved.deep.get === 'function')
check('a shipped block reads back unchanged', JSON.stringify(resolved.default.get()) === JSON.stringify(SHIPPED.default), JSON.stringify(resolved.default.get()))
// `default.steps` deliberately carries **no** schema default: the Loader runs
// this schema *before* `apply()`, so a default here would fill the key whenever
// a patch omitted it, and `resolveConfig`'s `steps ?? toolCalls` could never
// reach the legacy alias — a patch saying `toolCalls: 6` would mean 4 steps.
const absent = schemastery.resolve({}, Config)[0]
check('an absent block takes every default except the Tight step ceiling',
  JSON.stringify(absent.default.get()) === JSON.stringify({ minutes: 2, effort: 'low', permission: 'read-only' }),
  JSON.stringify(absent.default.get()))
check('the plugin itself still falls back to 4 Tight steps',
  resolveConfig({ default: absent.default.get() }).default.steps === 4,
  String(resolveConfig({ default: absent.default.get() }).default.steps))
const legacy = schemastery.resolve({ default: { toolCalls: 6 } }, Config)[0].default.get()
check('a patch that only says `toolCalls: 6` really means 6 steps',
  resolveConfig({ default: legacy, deep: { steps: 7 } }).default.steps === 6,
  String(resolveConfig({ default: legacy, deep: { steps: 7 } }).default.steps))
check('a partial block is completed by its own defaults',
  JSON.stringify(schemastery.resolve({ deep: { steps: 8 } }, Config)[0].deep.get()) === JSON.stringify({ ...SHIPPED.deep, steps: 8 }),
  JSON.stringify(schemastery.resolve({ deep: { steps: 8 } }, Config)[0].deep.get()))
let rejected = null
try { schemastery.resolve({ deep: { steps: 3 } }, Config) } catch (error) { rejected = error }
check('the deep floor is enforced by the schema itself', rejected !== null, 'a form write of deep.steps: 3 must be refused before it lands')
// The cross-field rule the schema cannot express, and the reason the refused
// fallback has to be visible: the form accepts this pair, the plugin refuses it.
let formAccepted = null
try { schemastery.resolve({ default: { steps: 6 }, deep: { steps: 5 } }, Config) } catch (error) { formAccepted = error }
check('the Tight/Wide ordering rule is not expressible in the schema', formAccepted === null, 'the plugin refuses it at load instead, loudly')
let crossRefused = null
try { resolveConfig({ default: { steps: 6 }, deep: { steps: 5 } }) } catch (error) { crossRefused = error }
check('and the plugin does refuse it', crossRefused !== null && /must be greater than/.test(crossRefused.message), crossRefused?.message)

// ── what `dsh-settings` does with that schema (its own algorithm, replayed) ──
/** Strip volatility so a volatile subtree becomes an ordinary parseable form. */
function plainSchema (schema) {
  const result = new schemastery(schema.toJSON())
  const walk = (node) => {
    if (node.meta !== undefined) delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
  }
  walk(result)
  return result
}
/** The editable projection of a plugin Config: only volatile subtrees. */
function volatileForm (schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type !== 'object') return undefined
  const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
    const field = volatileForm(child)
    return field === undefined ? [] : [[key, field]]
  }))
  return Object.keys(dict).length === 0 ? undefined : schemastery.object(dict)
}
/** Project raw config onto the form's shape. */
const projectForm = (form, raw) => schemastery.resolve(raw ?? {}, form)[0]
/** Whether a path lies under a volatile node. */
function isVolatilePath (schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
/** Keep a raw config's ordinary fields, dropping the volatile (form) ones. */
function strip (schema, form, value, path = []) {
  if (isVolatilePath(schema, path)) return {}
  const result = { ...value }
  for (const [key, field] of Object.entries(form.dict ?? {})) {
    const target = [...path, key]
    if (isVolatilePath(schema, target)) delete result[key]
    else if (result[key] !== null && typeof result[key] === 'object') result[key] = strip(schema, field, result[key], target)
  }
  return result
}
const mergeLayers = (base, next) => ({ ...(base ?? {}), ...(next ?? {}) })

const form = volatileForm(Config)
check('the form exposes exactly the two tier blocks', form !== undefined && Object.keys(form.dict).join(',') === 'default,deep', form === undefined ? 'undefined' : Object.keys(form.dict).join(','))
check('every editable field path is volatile',
  ['default', 'deep'].every((block) => Object.keys(form.dict[block].dict).every((field) => isVolatilePath(Config, [block, field]))))
check('an unlisted field would be refused as non-volatile', isVolatilePath(Config, ['free', 'steps']) === false)

// One save: raise the deep step ceiling, the way the page's mutate() does.
const raw = SHIPPED
const next = projectForm(form, raw)
next.deep = { ...next.deep, steps: 9 }
const written = mergeLayers(strip(Config, form, raw), next)
check('a save writes the whole volatile subtree into the profile patch',
  written.deep.steps === 9 && written.default.steps === 4,
  JSON.stringify(written))
check('the written document re-resolves to the same values',
  JSON.stringify(schemastery.resolve(written, Config)[0].deep.get()) === JSON.stringify({ ...SHIPPED.deep, steps: 9 }),
  JSON.stringify(schemastery.resolve(written, Config)[0].deep.get()))
check('the Open tier still owns no config block', written.free === undefined)

// ── the plugin still registers a client view with a real schema ──────────────
const captured = { projections: [] }
const fake = {
  logger: { info () {}, warn () {} },
  systemPrompt: { section: () => () => {}, context: () => () => {}, getContextOrder: () => 110 },
  commands: { register: () => () => {} },
  tools: { guard: () => () => {} },
  sessionProjections: { register: (definition) => { captured.projections.push(definition); return () => {} }, stateOf: () => undefined },
  on: () => () => {},
  effect: () => {},
  get: () => undefined
}
plugin.apply(fake, resolved)
const definition = captured.projections[0]
check('the projection is registered with a wire block', definition !== undefined && definition.wire !== undefined)
const viewPath = definition.wire.viewSchema
check('the wire view schema speaks Zod, the projection wire contract',
  typeof viewPath.safeParse === 'function', `schema methods: ${Object.keys(viewPath).slice(0, 6).join(',')}`)
const view = viewPath.parse(definition.wire.view(definition.init()))
check('the wire view parses through the real schema', view.mode === 'default' && view.tiers.deep.max === 5, JSON.stringify(view))
check('the Open tier crosses as null, never Infinity', view.tiers.free.max === null && view.tiers.free.minutes === null)
let refused = null
try { viewPath.parse({ mode: 'default', running: false, tiers: { default: {}, deep: {}, free: {} } }) } catch (error) { refused = error }
check('a malformed view is refused rather than published', refused !== null)

console.log('\nall checks passed')
