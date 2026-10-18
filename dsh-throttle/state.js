/**
 * Pure state, configuration, and budget logic for the `/throttle` tiered mode.
 *
 * This module deliberately imports only `node:` builtins — in fact nothing at
 * all — so the plugin entry stays importable by a plain `node` process for unit
 * testing, and so the plugin cannot fail to load over a bare specifier.
 *
 * Three tiers, named after how far the throttle is open. The ids are the stable
 * contract — the log fold, the persisted projection state and the config block
 * keys all speak them — while the names a human reads (`Tight` / `Wide` /
 * `Open`) are registered by the browser half in this plugin's locale namespace:
 *
 * - `default` — **Tight**: the tier a session starts in. Reasoning pinned to the
 *   cheapest declared level, permissions confined to the configured view-only
 *   preset, and the tightest per-turn budget.
 * - `deep` — **Wide**: `/throttle`. A larger per-turn budget that still has a
 *   hard ceiling, the session's own permission preset restored, and a
 *   configurable reasoning effort.
 * - `free` — **Open**: `/throttle open`. The plugin stops constraining the
 *   session entirely — no budget, no effort override, permissions left to the
 *   session — which is the "as if the plugin were not installed" position.
 *
 * State model: the tier is a **session projection** folded from two event types
 * the Harness already persists — `command/run` and `command/done` for the
 * `throttle` command. Nothing new is written to the log, so restart and resume
 * recover the tier by replay and a fork inherits it.
 *
 * Two model-facing channels, split by what changes when:
 *
 * - {@link policySection} is the **system-prompt section** (`throttle:policy`).
 *   Its text changes only when the tier does, so the stable prompt prefix
 *   survives a step; it carries the tier's contract and the standing rules.
 * - {@link stateContext} is the **runtime-context snapshot** (`throttle:state`),
 *   ordered right after `sandbox:policy` so the model reads the cause next to
 *   the `Current DSH file policy` line it explains. It carries the live budget
 *   and, once the budget is spent, the fixed hand-back format. The Harness
 *   replaces the previous snapshot rather than appending, so a per-step change
 *   costs one line instead of rewriting the prompt head.
 *
 * Design record: `IMPLEMENTATION-throttle-mode.md` in the plugin's parent directory.
 *
 * @module dsh-throttle/state
 */

/** The three tiers, in the order a bare `/throttle` walks them. */
export const MODES = Object.freeze(['default', 'deep', 'free'])

/** Receipt prefixes fixed by PLAN-throttle-mode.md section 3. */
export const RECEIPT = Object.freeze({ default: '🍃 Tight', deep: '⚡ Wide', free: '♾️ Open' })

/** Display names used in receipts, notes, and the model-facing text. */
export const MODE_LABELS = Object.freeze({ default: 'Tight', deep: 'Wide', free: 'Open' })

/** The projection key this plugin owns. */
export const PROJECTION_KEY = 'throttleMode'

/**
 * The projection state version.
 *
 * 1 → 2: the two-state `active` boolean became the three-tier `mode` string.
 * 2 → 3: `commanded` was added, so a session can be told apart from one that
 * merely *folded* to the default tier. That distinction is what lets a
 * sub-session without a `/throttle` record of its own inherit the delegating
 * session's tier instead of being pinned to Tight.
 *
 * A persisted checkpoint carrying an older version is discarded and refolded
 * from the log, which is lossless because the fold derives everything from
 * already-persisted events.
 */
export const PROJECTION_VERSION = 3

/**
 * The standing rules from PLAN-throttle-mode.md section 4. They apply in every
 * tier and are rendered into every request's system prompt.
 */
export const STANDING_RULES = [
  '- **Start shallow, then go deeper**: offer 2-3 viable directions first; never work out every possibility and pour it all onto the user at once.',
  '- **Stop and ask when the details are missing**: do not move into implementation until the scenario, the requirements, the environment and the approach are settled.',
  '- **Execute directly only when the user has supplied every detail** and explicitly asked you to follow the plan.',
  '- **When something is uncertain, give a verification command** — do not search without end.',
  '- **Small talk takes no tool call**: answer a one-line "haha" with one line.'
].join('\n')

/** The fixed hand-back format from PLAN-throttle-mode.md section 2. */
export const SURRENDER_TEMPLATE = [
  '## What I found',
  '(the facts and conclusions confirmed so far — as far as they go)',
  '',
  '## What needs your confirmation (high impact)',
  '1. … (which information is missing, and why it changes the approach)',
  '',
  '## What I went with by default (low impact)',
  '- … (the default, plus one reason — change it if you disagree)',
  '',
  '## How you can verify',
  '(one command or one step the user can run, instead of searching on and on)'
].join('\n')

/** Minimum allowed value for the deep-state limits (PLAN section 5.5). */
export const DEEP_MINIMUM = 5

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
 * The arguments `/throttle` accepts, and the tier each one selects. A bare command
 * is the toggle handled by {@link nextMode}, not an entry here.
 */
const ARGUMENT_TARGETS = Object.freeze({
  tight: 'default',
  on: 'default',
  default: 'default',
  wide: 'deep',
  deep: 'deep',
  open: 'free',
  off: 'free',
  free: 'free',
  unlimited: 'free'
})

/**
 * The empty projection state, shared as a frozen value so an unregistered read
 * can still be answered without allocating.
 *
 * `commanded` is false until the session's own log carries a successful
 * `/throttle`: a session that has never run one is a candidate for inheriting
 * the delegating session's tier (see {@link applyThrottleEvent}).
 */
export const EMPTY_THROTTLE_STATE = Object.freeze({
  mode: 'default',
  running: null,
  original: null,
  chosenPreset: null,
  commanded: false
})

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
 * `effort` is the reasoning level the tier pins: the default tier's cheapest
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

/**
 * A fresh per-turn usage record.
 *
 * `active` is the turn latch: a record with `active: false` has seen no turn
 * boundary, so the budget is not yet enforceable and the elapsed time is not
 * yet meaningful. An explicit flag is used instead of a sentinel timestamp so
 * a clock reading of zero cannot be mistaken for "no turn".
 *
 * @returns zeroed counters with no turn observed yet.
 */
export function emptyUsage () {
  return { active: false, turn: null, step: 0, startedAt: 0 }
}

/**
 * Open a new turn's budget.
 * @param usage - the record to reset in place.
 * @param turn - the turn number, when the payload carries one.
 * @param step - the step number the turn starts at.
 * @param now - current epoch milliseconds.
 * @returns the same record.
 */
export function startTurn (usage, turn, step, now) {
  usage.active = true
  usage.turn = turn
  usage.step = step === undefined ? 1 : step
  usage.startedAt = now
  return usage
}

/**
 * Fold one accepted step boundary into the usage record.
 *
 * A turn boundary is detected from the step counter restarting or from the turn
 * number changing; the agent loop numbers steps per turn, so either signal is
 * enough and neither is required.
 *
 * @param usage - the record to advance.
 * @param boundary - `turn` and `step` from the `agent/pre-step` payload.
 * @param now - current epoch milliseconds.
 * @returns the same record.
 */
export function observeStep (usage, boundary, now) {
  const turn = boundary.turn === undefined ? null : boundary.turn
  const step = boundary.step === undefined ? undefined : boundary.step
  const turnChanged = turn !== null && usage.turn !== null && turn !== usage.turn
  const stepRestarted = step !== undefined && step <= usage.step
  if (!usage.active || turnChanged || stepRestarted) return startTurn(usage, turn, step, now)
  if (step !== undefined) usage.step = step
  else usage.step += 1
  return usage
}

/**
 * Fold one committed session event into the usage record.
 *
 * `agent/pre-step` alone is too late to open a turn's budget. The loop renders
 * the runtime context **before** it runs the `agent/pre-step` waterfall
 * (`AgentLoop.preStep()`: `systemPrompt.assemble()` and
 * `runtimeContext.project()` precede the waterfall), so a record only advanced
 * from `agent/pre-step` is always the record the *previous* pre-step left
 * behind. Within one turn that is invisible; on the **first step of a turn** the
 * snapshot still held the previous turn's `startedAt`, and because elapsed time
 * is wall clock, the idle gap between the two turns was charged to the new turn:
 * a session left alone for 88 minutes opened its next turn already "exhausted",
 * against a 2-minute ceiling, having spent nothing — and the model obeyed the
 * snapshot and surrendered instead of working.
 *
 * `turn/start` and `turn/end` are appended to the log before that assembly, so
 * folding them here is what keeps the snapshot honest. `turn/start` opens at
 * step 1 (the step about to enter, which is what the deep tier's step line
 * shows); the step's own {@link observeStep} then re-anchors the clock to the
 * pre-step, milliseconds later and on the same record. `turn/end` marks the
 * record inert, so no snapshot rendered between two turns can claim a budget
 * the closed turn did not have.
 *
 * @param usage - the record to advance.
 * @param event - one committed session event.
 * @param now - the event's own commit time, or current epoch milliseconds.
 * @returns the same record.
 */
export function observeSessionEvent (usage, event, now) {
  switch (event?.type) {
    case 'turn/start': {
      const turn = event.data?.turn
      return startTurn(usage, typeof turn === 'number' ? turn : null, 1, now)
    }
    case 'turn/end':
      usage.active = false
      return usage
    default:
      return usage
  }
}

/**
 * Minutes elapsed inside the current turn.
 * @param usage - the usage record.
 * @param now - current epoch milliseconds.
 * @returns elapsed minutes, or 0 before the first turn boundary.
 */
export function elapsedMinutes (usage, now) {
  return usage.active ? (now - usage.startedAt) / 60000 : 0
}

/**
 * Cost of the current turn, as numbers fit for a status line.
 * @param usage - the usage record.
 * @param now - current epoch milliseconds.
 * @returns the step the turn has reached and elapsed minutes.
 */
export function usageSummary (usage, now) {
  return { step: usage.step, minutes: elapsedMinutes(usage, now) }
}

/**
 * Whether the turn has reached its limit.
 *
 * Both limited tiers count **steps**, never tool calls: one step is one model
 * response, however many calls that response makes in parallel, so a wide
 * fan-out is free and only the walk forward is bounded. The step form trips at
 * the first step beyond the ceiling, which is the tool-free closing step the
 * plan asks for. The free tier has no ceiling at all, so this can never be
 * exhausted there.
 *
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param usage - the usage record.
 * @param now - current epoch milliseconds.
 * @returns `{ exhausted, reason }`, where `reason` names the limit that tripped.
 */
export function budgetState (config, mode, usage, now) {
  const limits = limitsFor(config, mode)
  if (limits.kind === 'unlimited') return { exhausted: false, reason: '' }
  const minutes = elapsedMinutes(usage, now)
  if (minutes > limits.minutes) {
    return { exhausted: true, reason: `the ${limits.minutes}-minute ceiling is reached (${minutes.toFixed(1)} min spent)` }
  }
  if (usage.step > limits.max) {
    return { exhausted: true, reason: `the ${limits.max}-step ceiling is reached (now on step ${usage.step})` }
  }
  return { exhausted: false, reason: '' }
}

/**
 * The model-facing reason a call was refused, which also carries the order to
 * stop exploring so the model hands back instead of retrying.
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param reason - the limit that tripped.
 * @returns the denial text.
 */
export function denialText (config, mode, reason) {
  const limits = limitsFor(config, mode)
  const ceiling = `≤${limits.max} steps`
  return [
    `throttle: this turn's ceiling is spent (${ceiling} / ≤${limits.minutes} min) — ${reason}.`,
    'This is the dsh-throttle plugin\'s tier ceiling (the Tight / Wide tier), not the DSH sandbox refusing.',
    'Stop calling tools and do not retry. Give your conclusions, and hand back in exactly this order:',
    '## What I found / ## What needs your confirmation (high impact) / ## What I went with by default (low impact) / ## How you can verify.',
    'For a wider ceiling, ask the user to run /throttle (Wide) or /throttle open (Open).'
  ].join('\n')
}

/**
 * Decide one tool call against the turn's step ceiling.
 *
 * This guard is deliberately **read-only**: the step counter is advanced by
 * {@link observeStep} from the agent loop's own step numbering, so the guard
 * cannot drift from the loop and cannot be spent by fan-out. Every call issued
 * inside one step passes or fails together — the ceiling bounds how far a turn
 * walks, not how wide a single step spreads — and the denial is recomputed
 * rather than accumulated, so the over-limit step keeps failing consistently
 * until the model hands back. The Open tier never denies.
 *
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param usage - the usage record.
 * @param now - current epoch milliseconds.
 * @returns the denial reason, or `undefined` to allow the call.
 */
export function guardDecision (config, mode, usage, now) {
  if (!usage.active) return undefined
  const limits = limitsFor(config, mode)
  if (limits.kind === 'unlimited') return undefined
  const state = budgetState(config, mode, usage, now)
  return state.exhausted ? denialText(config, mode, state.reason) : undefined
}

/**
 * The per-tier status line for one tier (PLAN sections 2 and 5.1).
 *
 * The two limited tiers name the reasoning level they pin; the free tier names
 * that it pins none.
 *
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param detail - the permission text for this tier.
 * @returns the single status line.
 */
export function statusLine (config, mode, detail) {
  const limits = limitsFor(config, mode)
  if (mode === 'free') {
    return `${RECEIPT.free} · no ceiling · no reasoning override · preset left alone (${detail === undefined ? 'kept as is' : detail})`
  }
  const scope = `≤${limits.max} steps`
  if (mode === 'deep') {
    return `${RECEIPT.deep} · reasoning ${limits.effort} · ${scope} · ≤${limits.minutes} min · preset restored (${detail === undefined ? 'kept as is' : detail})`
  }
  return `${RECEIPT.default} · reasoning ${limits.effort} (cheapest) · ${scope} · ≤${limits.minutes} min · ${detail === undefined ? 'view-only' : detail}`
}

/**
 * The model-facing phrase for the permission fact of the current tier.
 *
 * This is the sentence that answers "why is the file policy what it is": it
 * names whether the plugin wrote the preset or the session owns it, so the
 * model never has to guess whether a read-only policy is the plugin's tier or
 * the user's own configuration.
 *
 * `pending` is not a failure state: the first prompt assembly of a session runs
 * before the first `agent/pre-step`, where the plugin asserts its preset, so a
 * mismatch also means "just switched tier" or "the user just changed it".
 *
 * @param permission - `{ preset, source, target }` from the plugin entry.
 * @returns one clause, without a trailing period.
 */
export function permissionPhrase (permission) {
  const preset = permission?.preset
  const target = permission?.target
  switch (permission?.source) {
    case 'plugin':
      return `set by this plugin to ${preset} (this tier's definition, not the user's choice)`
    case 'delegated':
      // A sub-session the Harness started with a fixed permission scope: an
      // inherited tier never narrows it, and only releases Tight's read-only pin.
      return preset === undefined
        ? 'the scope this delegated sub-session was started with (this plugin only releases it from the Tight tier\'s read-only pin)'
        : `the scope this delegated sub-session was started with (${preset}); an inherited tier never narrows it`
    case 'pending':
      if (preset === undefined) return `this plugin targets ${target}, but the current preset cannot be read (the permission service is unavailable)`
      if (target === undefined) return `this plugin wants to restore the session's own preset, and the current one is ${preset} (the permission service is unavailable, or the preset is not selectable)`
      return `this plugin targets ${target} while the current preset is ${preset} (the tier was just entered, the user just changed it by hand, or the permission service is unavailable; it is reconciled on the next step)`
    case 'session':
      return `the session's own preset ${preset} (this tier honours it and adds no further limit)`
    default:
      return 'unknown (the permission service is unavailable)'
  }
}

/**
 * The system-prompt section for the current tier.
 *
 * Stable per tier on purpose: it changes only when the tier changes, so an
 * ordinary step never rewrites the cached prompt head. The volatile facts (the
 * live budget and the spent-budget hand-back format) live in
 * {@link stateContext}, which the Harness replaces in place.
 *
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param permission - `{ preset, source }` for this step.
 * @param inherited - true when this session has no `/throttle` of its own and
 * the tier comes from the session that delegated to it.
 * @returns the prompt section text; never empty.
 */
export function policySection (config, mode, permission, inherited = false) {
  const limits = limitsFor(config, mode)
  const lines = []
  if (inherited) {
    // A sub-session reads the same tier contract as its delegator, so it has to
    // know the contract is not its own decision — and that its route out is the
    // reply, not a command it cannot run for itself.
    lines.push('This tier is **inherited from the session that delegated to this one**, which owns the decision: if the ceiling or the scope blocks the task, say so in your reply so the delegating session can widen it. Running `/throttle …` here would instead pin a tier of this session\'s own.')
  }
  if (mode === 'free') {
    lines.push(
      '[throttle] current tier: Open (tier 3 — /throttle open)',
      'This tier sets no limit at all: no tool or step ceiling, no time ceiling, and no reasoning level is sent — exactly as if this plugin were not installed.',
      `Permissions: ${permissionPhrase(permission)}; the plugin only puts a preset back when it finds the session pinned to the Tight tier's read-only preset.`,
      'Switch: `/throttle` or `/throttle on` returns to Tight; `/throttle wide` goes straight to Wide.'
    )
  } else if (mode === 'deep') {
    lines.push(
      '[throttle] current tier: Wide (tier 2 — opened by /throttle)',
      `This tier's ceiling: reasoning ${limits.effort} · ≤${limits.max} steps · ≤${limits.minutes} min (a hard ceiling: at the limit you stop).`,
      `Permissions: ${permissionPhrase(permission)}.`,
      'Exploration widens, but the ceiling still holds; when it is reached, stop and hand back in the fixed format.',
      'Switch: `/throttle` returns to Tight; `/throttle open` releases every limit.'
    )
  } else {
    lines.push(
      '[throttle] current tier: Tight (tier 1 — what every session starts in, enforced by the dsh-throttle plugin)',
      `This tier's limits: reasoning held at ${limits.effort} (the cheapest level) · ≤${limits.max} steps · ≤${limits.minutes} min · the permission preset pinned to ${config.default.permission}.`,
      `Permissions: ${permissionPhrase(permission)}.`,
      'Writes, and scripts that land files, are refused by the sandbox: that is this tier\'s definition, not a mistake of yours. Do not retry, and do not switch the permission preset yourself.',
      'When a file has to be written, tell the user to run `/throttle` for the Wide tier (writable, ≥5 steps) or `/throttle open` for the Open tier (no ceiling, writable).',
      'When the ceiling is reached, stop and hand back in the fixed format.'
    )
  }
  lines.push('', '## Standing rules (in force in every tier)', STANDING_RULES)
  return lines.join('\n')
}

/**
 * The runtime-context snapshot: the tier, the cause of the current file policy,
 * the live budget, and — once the budget is spent — the fixed hand-back format.
 *
 * The Harness orders this right after `sandbox:policy` and replaces the previous
 * snapshot when the text changes, so the model reads "why read-only" beside the
 * `Current DSH file policy: read-only` line that prompted the question, and a
 * per-step budget change costs one replaced line rather than a prompt rewrite.
 *
 * @param config - validated config.
 * @param mode - the session's tier.
 * @param usage - the usage record.
 * @param now - current epoch milliseconds.
 * @param permission - `{ preset, source }` for this step.
 * @param options - `{ inherited, issue }`: whether the tier comes from the
 * delegating session, and the reason the row config was refused (or `null`).
 * @returns the snapshot text; never empty.
 */
export function stateContext (config, mode, usage, now, permission, options = {}) {
  const limits = limitsFor(config, mode)
  const inherited = options.inherited === true
  const issue = options.issue ?? null
  const lines = []
  if (inherited) {
    lines.push('This tier is **inherited from the session that delegated to this one** (this session has run no `/throttle` of its own). Its budget, its reasoning level and its permissions below are the ones actually enforced here; a ceiling that blocks the task belongs in your reply to the delegating session.')
  }
  if (mode === 'free') {
    lines.push(
      '[throttle:state] tier: Open (dsh-throttle tier 3, /throttle open)',
      `No ceiling and no reasoning override in this tier; permissions: ${permissionPhrase(permission)}.`
    )
    if (permission?.source === 'session') {
      lines.push(`If a write is still refused right now, that is the session's own permission preset (${permission.preset}) or the sandbox settings — it has nothing to do with this plugin. Point the user at the permissions selector instead of retrying.`)
    } else if (permission?.source === 'pending') {
      lines.push('This plugin is putting the permission preset back to the session\'s own, so the current file policy may still come from the plugin; if it never settles, change it with the permissions selector.')
    }
  } else if (mode === 'deep') {
    lines.push(
      '[throttle:state] tier: Wide (dsh-throttle tier 2, opened by /throttle)',
      `This tier's ceiling: reasoning ${limits.effort} · ≤${limits.max} steps · ≤${limits.minutes} min; permissions: ${permissionPhrase(permission)}.`,
      'At the ceiling you must stop and hand back; for no limits at all use `/throttle open`.'
    )
  } else {
    lines.push(
      '[throttle:state] tier: Tight (dsh-throttle tier 1, what every session starts in)',
      `The plugin's Tight tier pins the session permission preset to ${config.default.permission}; the file-policy line you can see (Current DSH file policy) is where that preset lands — it is not DSH's deployment default and not something the user changed on the spot.`,
      `This tier's limits: reasoning ${limits.effort} (the cheapest level) · ≤${limits.max} steps · ≤${limits.minutes} min; permissions: ${permissionPhrase(permission)}.`,
      'A refused write is expected: do not retry and do not switch the permission preset yourself; tell the user about `/throttle` (Wide) or `/throttle open` (Open).'
    )
  }

  // A refused row config is never silent: the logged warning is invisible to
  // the model, and the built-in fallback otherwise looks exactly like a
  // deliberate configuration. Naming it here is what lets the model tell the
  // user what to fix instead of reporting the numbers as configured ones.
  if (issue !== null) {
    lines.push(
      '',
      `**The numbers in force are this plugin's built-in defaults, because the row config was refused** — ${issue}`,
      'The configured values stay ignored until that is fixed (Plugins page → the dsh-throttle card, or the profile\'s cordis.patch.yml). Report this to the user rather than treating the numbers above as theirs.'
    )
  }

  const state = budgetState(config, mode, usage, now)
  if (limits.kind !== 'unlimited' && state.exhausted) {
    lines.push(
      '',
      `**This turn's ceiling is spent** (${state.reason}). Stop, do not call any more tools, and hand back in the fixed format below:`,
      '',
      SURRENDER_TEMPLATE
    )
  } else if (limits.kind !== 'unlimited' && usage.active) {
    const used = usageSummary(usage, now)
    lines.push(`This turn: step ${used.step}/${limits.max} · ${used.minutes.toFixed(1)}/${limits.minutes} min.`)
  }
  return lines.join('\n')
}

/**
 * The `/throttle` receipt line the conversation keeps (PLAN section 3).
 * @param config - validated config.
 * @param mode - the tier now in effect.
 * @param detail - the permission text.
 * @param note - an extra sentence appended after the receipt.
 * @returns the receipt text.
 */
export function receiptText (config, mode, detail, note) {
  return note === undefined ? statusLine(config, mode, detail) : `${statusLine(config, mode, detail)}\n${note}`
}

/**
 * Which tier `/throttle` selects next.
 *
 * A bare command toggles the two limited tiers and re-engages the plugin from
 * the free tier, so the free tier is never a state a user can fall into by
 * pressing the same key twice. Every other accepted argument names its tier
 * outright.
 *
 * @param current - the session's current tier.
 * @param argument - the trimmed, lower-cased command argument (`''` for a bare toggle).
 * @returns the target tier, or `undefined` when the argument is not accepted.
 */
export function nextMode (current, argument) {
  if (argument === '') return current === 'default' ? 'deep' : 'default'
  return ARGUMENT_TARGETS[argument]
}

/**
 * Validate one persisted projection state.
 *
 * The projection cache calls this with a checkpointed document on a cold read,
 * so it must reject anything that is not the exact shape this unit folds.
 *
 * @param value - the persisted state.
 * @returns the same state.
 * @throws {Error} when the value cannot be trusted.
 */
export function parseThrottleState (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-throttle: throttleMode state must be an object')
  }
  if (typeof value.mode !== 'string' || !MODES.includes(value.mode)) {
    throw new Error(`dsh-throttle: throttleMode state.mode must be one of ${MODES.join(', ')}`)
  }
  const running = value.running
  if (running !== null && (typeof running !== 'object' || Array.isArray(running) || typeof running.commandId !== 'string' || typeof running.wanted !== 'string')) {
    throw new Error('dsh-throttle: throttleMode state.running must be null or { commandId, wanted }')
  }
  for (const key of ['original', 'chosenPreset']) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(`dsh-throttle: throttleMode state.${key} must be null or a string`)
    }
  }
  if (typeof value.commanded !== 'boolean') {
    throw new Error('dsh-throttle: throttleMode state.commanded must be a boolean')
  }
  return value
}

/**
 * Fold one committed session event into the tier state.
 *
 * Two event types the Harness already writes carry everything:
 *
 * - `command/run` records the requested target (or the bare toggle), before
 *   the handler runs. A bare `/throttle` resolves against whatever the fold says
 *   the tier is at that point in the log, so replay is deterministic.
 * - `command/done` commits the requested tier, but only when the command
 *   actually succeeded.
 *
 * `permission/preset` is folded too, to remember the session's own preset: the
 * first one in the log is the session's original (the Harness pins it when the
 * session is published), and a later change made while the session is *not* in
 * the default tier is the user's manual choice. The plugin's own takeover
 * appends are told apart by comparing against the default tier's configured
 * preset.
 *
 * @param config - validated config.
 * @param state - the state before this event.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is unrelated.
 */
export function applyThrottleEvent (config, state, event) {
  if (event === null || typeof event !== 'object') return state
  switch (event.type) {
    case 'permission/preset': {
      const preset = event.data?.preset
      if (typeof preset !== 'string' || preset === '') return state
      if (state.mode !== 'default') {
        // A change made outside the default tier is the user's choice — unless
        // it is the plugin's own takeover preset, which is not a preference.
        if (preset === config.default.permission) return state
        return state.chosenPreset === preset ? state : { ...state, chosenPreset: preset }
      }
      // The first preset in the log is the session's original; every later one
      // is the plugin re-asserting the tier, so it must not overwrite it.
      if (state.original !== null) return state
      return { ...state, original: preset }
    }
    case 'command/run': {
      if (event.data?.name !== 'throttle') return state
      const argument = typeof event.data.args === 'string' ? event.data.args.trim().toLowerCase() : ''
      const wanted = nextMode(state.mode, argument)
      if (wanted === undefined) return state
      const running = { commandId: String(event.data.commandId), wanted }
      return { ...state, running }
    }
    case 'command/done': {
      const running = state.running
      if (running === null || String(event.data?.commandId) !== running.commandId) return state
      // A command that errored settles the run without deciding anything.
      if (event.data.kind !== 'success') return { ...state, running: null }
      // A successful `/throttle` is this session's own tier decision, and it is
      // the only thing that stops the session from inheriting its delegating
      // session's tier (a `subagent` child has no such record, a
      // `subagent_fork` inherits the parent's — see the plugin entry).
      return { ...state, mode: running.wanted, running: null, commanded: true }
    }
    default:
      return state
  }
}

/**
 * The session projection unit that carries the tier.
 *
 * The unit is checkpointed by the projection cache whether or not a `wire`
 * block is supplied. Passing one publishes {@link throttleView} to the browser,
 * which is what the Web UI's tier chip reads; omitting it keeps the unit
 * host-only (the shape the unit tests pin).
 *
 * @param config - validated config, read by the fold.
 * @param wire - optional `{ viewSchema, view }` client projection.
 * @returns the projection registration for `ctx.sessionProjections.register()`.
 */
export function createThrottleProjection (config, wire) {
  return {
    key: PROJECTION_KEY,
    stateVersion: PROJECTION_VERSION,
    stateSchema: { parse: parseThrottleState },
    init: () => ({ ...EMPTY_THROTTLE_STATE }),
    apply: (state, event) => applyThrottleEvent(config, state, event),
    ...(wire === undefined ? {} : { wire })
  }
}

/**
 * The client-visible value of the tier projection: which tier the session is in,
 * whether a `/throttle` command is mid-flight, and every tier's ceiling.
 *
 * The ceilings ride along so the browser never re-derives them: `kind` and `max`
 * are the same normalized pair the guard enforces, and the panel that shows them
 * is the same panel that switches tiers — so a switch republishes this value and
 * the numbers follow. `Infinity` is published as `null` because the value
 * crosses the wire as JSON, where `Infinity` has no representation.
 *
 * The returned object is fresh per call, which is safe by construction: the
 * registry only calls `view` after the folded state changed.
 *
 * @param config - validated config, read at view time.
 * @param state - the projection state.
 * @returns `{ mode, running, tiers }`.
 */
export function throttleView (config, state) {
  const tiers = {}
  for (const mode of MODES) {
    const limits = limitsFor(config, mode)
    tiers[mode] = {
      kind: limits.kind,
      max: Number.isFinite(limits.max) ? limits.max : null,
      minutes: Number.isFinite(limits.minutes) ? limits.minutes : null,
      effort: limits.effort
    }
  }
  return { mode: modeOfState(state), running: Boolean(state.running), tiers }
}

/**
 * The tier a projection state means.
 * @param state - the projection state.
 * @returns `default`, `deep`, or `free`.
 */
export function modeOfState (state) {
  return state.mode ?? 'default'
}

/**
 * The permission preset a non-default tier restores.
 *
 * Preference order: the preset the user chose while outside the default tier,
 * then the session's original preset, then the configured `deep.permission`
 * when it names a real preset, and finally the first writable preset the
 * deployment offers. The default tier's own preset is never a restore target —
 * restoring it would make the other tiers as confined as the default one, which
 * would strand the session in the read-only trap this version exists to fix.
 *
 * @param config - validated config.
 * @param state - the projection state.
 * @param isSelectable - predicate reporting whether a preset name is offered.
 * @returns the preset to select, or `undefined` when nothing selectable exists.
 */
export function restoreTarget (config, state, isSelectable) {
  for (const candidate of [state.chosenPreset, state.original]) {
    if (typeof candidate === 'string' && candidate !== config.default.permission && isSelectable(candidate)) return candidate
  }
  if (config.deep.permission !== 'restore' && isSelectable(config.deep.permission)) return config.deep.permission
  for (const candidate of ['workspace-write', 'danger-full-access']) {
    if (candidate !== config.default.permission && isSelectable(candidate)) return candidate
  }
  return undefined
}

/**
 * The permission preset a tier wants the session to hold.
 * @param config - validated config.
 * @param mode - the target tier.
 * @param state - the projection state.
 * @param isSelectable - predicate reporting whether a preset name is offered.
 * @returns the preset name, or `undefined` when the tier has no opinion.
 */
export function wantedPreset (config, mode, state, isSelectable) {
  return mode === 'default' ? config.default.permission : restoreTarget(config, state, isSelectable)
}
