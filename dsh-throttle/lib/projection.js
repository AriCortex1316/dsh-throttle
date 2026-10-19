/** 从已持久化的命令与权限事件恢复档位，并生成浏览器视图。 */
import { MODES, PROJECTION_KEY, PROJECTION_VERSION } from './constants.js'
import { limitsFor } from './config.js'

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
