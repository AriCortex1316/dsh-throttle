/** 配置校验、历史字段兼容与档位上限。 */
import { DEEP_MINIMUM } from './constants.js'

/**
 * Config keys accepted in a mode's block.
 *
 * `toolCalls` is the name the Tight ceiling used before the unit became the
 * step. It stays listed here as a **legacy alias** rather than an unknown key:
 * when the rename first shipped, a profile patch still saying `toolCalls: 4`
 * made `resolveConfig` throw, and the throw took the whole plugin row down
 * mid-session. A name this plugin used to accept must not be able to do that.
 *
 * The alias is only reachable because the `Config` schema deliberately does
 * **not** declare a default for `steps`: the Loader resolves the row through
 * that schema before `apply()` runs, so a schema default would silently fill
 * `steps` and make `defaults.steps ?? defaults.toolCalls` always take the first
 * branch — a patch saying `toolCalls: 6` would quietly mean 4 steps. The
 * built-in 4 lives here, in the one place that can see both keys.
 */
const DEFAULT_KEYS = ['steps', 'toolCalls', 'minutes', 'effort', 'permission']
const DEEP_KEYS = ['steps', 'minutes', 'effort', 'permission']
/** Top-level config keys. */
const ROOT_KEYS = ['default', 'deep']

/**
 * Validate one positive number, failing loud rather than clamping.
 * @param value - raw configured value.
 * @param label - dotted path used in the error message.
 * @param minimum - smallest accepted value.
 * @returns the validated number.
 */
function requireNumber (value, label, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`dsh-throttle: ${label} must be a finite number, got ${JSON.stringify(value)}`)
  }
  if (value < minimum) {
    throw new Error(`dsh-throttle: ${label} must be >= ${minimum}, got ${value}`)
  }
  return value
}

/**
 * Validate one non-empty string.
 * @param value - raw configured value.
 * @param label - dotted path used in the error message.
 * @returns the validated string.
 */
function requireString (value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-throttle: ${label} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Reject unknown keys so a typo cannot silently keep the default value.
 * @param object - the block being validated.
 * @param allowed - the keys the block may carry.
 * @param label - dotted path used in the error message.
 */
function rejectUnknown (object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`dsh-throttle: ${label} has unknown key(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`)
  }
}

/**
 * Validate the plugin row's config, applying the plan's defaults.
 *
 * The deep-state limits keep a hard floor of {@link DEEP_MINIMUM}: a deep tier
 * that is not deeper than the default tier is a misconfiguration, not a
 * preference, so it fails at plugin load (PLAN section 5.5). The `free` tier has
 * no config block on purpose — "unlimited" is not a number a user could get
 * wrong, and the way back to a usable session must not depend on configuration.
 *
 * @param raw - the row's `config` value; `undefined` uses every default.
 * @returns a detached, validated config.
 * @throws {Error} when any value is missing, mistyped, unknown, or below its floor.
 */
export function resolveConfig (raw) {
  const source = raw === undefined ? {} : raw
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`dsh-throttle: config must be a mapping, got ${JSON.stringify(source)}`)
  }
  rejectUnknown(source, ROOT_KEYS, 'config')

  const defaults = source.default === undefined ? {} : source.default
  const deep = source.deep === undefined ? {} : source.deep
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('dsh-throttle: config.default must be a mapping')
  }
  if (deep === null || typeof deep !== 'object' || Array.isArray(deep)) {
    throw new Error('dsh-throttle: config.deep must be a mapping')
  }
  rejectUnknown(defaults, DEFAULT_KEYS, 'config.default')
  rejectUnknown(deep, DEEP_KEYS, 'config.deep')

  const defaultBlock = Object.freeze({
    // The previous version's key, still honoured so an unmigrated patch loads.
    steps: requireNumber(defaults.steps ?? defaults.toolCalls ?? 4, 'config.default.steps', 1),
    minutes: requireNumber(defaults.minutes ?? 2, 'config.default.minutes', 1),
    effort: requireString(defaults.effort ?? 'low', 'config.default.effort'),
    permission: requireString(defaults.permission ?? 'read-only', 'config.default.permission')
  })
  const deepBlock = Object.freeze({
    steps: requireNumber(deep.steps ?? DEEP_MINIMUM, 'config.deep.steps', DEEP_MINIMUM),
    minutes: requireNumber(deep.minutes ?? DEEP_MINIMUM, 'config.deep.minutes', DEEP_MINIMUM),
    effort: requireString(deep.effort ?? 'high', 'config.deep.effort'),
    permission: requireString(deep.permission ?? 'restore', 'config.deep.permission')
  })
  // Both limited tiers count the same unit now, so "the Wide tier must be wider
  // than the Tight tier" is a comparison rather than an assumption: a deep tier
  // tighter than the default one is a misconfiguration, not a preference.
  if (deepBlock.steps <= defaultBlock.steps) {
    throw new Error(`dsh-throttle: config.deep.steps (${deepBlock.steps}) must be greater than config.default.steps (${defaultBlock.steps}) — the Wide tier must be wider than the Tight tier`)
  }
  return Object.freeze({ default: defaultBlock, deep: deepBlock })
}

/**
 * Per-tier limits, normalized to one shape.
 *
 * `effort` is the reasoning level the tier pins: the default tier's lowest
 * declared level, the deep tier's configured level, and `null` for the free
 * tier, which means "this plugin does not choose an effort at all".
 *
 * @param config - validated config.
 * @param mode - `default`, `deep`, or `free`.
 * @returns the limit kind, its maximum, the minutes ceiling, and the effort.
 */
export function limitsFor (config, mode) {
  if (mode === 'free') return { kind: 'unlimited', max: Infinity, minutes: Infinity, effort: null }
  const block = mode === 'deep' ? config.deep : config.default
  return { kind: 'steps', max: block.steps, minutes: block.minutes, effort: block.effort }
}
