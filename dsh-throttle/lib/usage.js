/** 每轮计数、墙钟检查与工具守卫；守卫只读取计数。 */
import { limitsFor } from './config.js'

/**
 * A fresh per-turn usage record.
 *
 * `active` is the turn latch: a record with `active: false` has seen no turn
 * boundary, so the ceiling is not yet enforceable and the elapsed time is not
 * yet meaningful. An explicit flag is used instead of a sentinel timestamp so
 * a clock reading of zero cannot be mistaken for "no turn".
 *
 * @returns zeroed counters with no turn observed yet.
 */
export function emptyUsage () {
  return { active: false, turn: null, step: 0, startedAt: 0 }
}

/**
 * Open a new turn's ceiling.
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
 * `agent/pre-step` alone is too late to open a turn's ceiling. The loop renders
 * the runtime context **before** it runs the `agent/pre-step` waterfall
 * (`AgentLoop.preStep()`: `systemPrompt.assemble()` and
 * `runtimeContext.project()` precede the waterfall), so a record only advanced
 * from `agent/pre-step` is always the record the *previous* pre-step left
 * behind. Within one turn that is invisible; on the **first step of a turn** the
 * snapshot still held the previous turn's `startedAt`, and because elapsed time
 * is wall clock, the idle gap between the two turns was charged to the new turn:
 * a session left alone for 88 minutes opened its next turn already "exhausted",
 * against a 2-minute ceiling, having used nothing — and the model obeyed the
 * snapshot and surrendered instead of working.
 *
 * `turn/start` and `turn/end` are appended to the log before that assembly, so
 * folding them here is what keeps the snapshot honest. `turn/start` opens at
 * step 1 (the step about to enter, which is what the deep tier's step line
 * shows); the step's own {@link observeStep} then re-anchors the clock to the
 * pre-step, milliseconds later and on the same record. `turn/end` marks the
 * record inert, so no snapshot rendered between two turns can claim a ceiling
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
export function ceilingState (config, mode, usage, now) {
  const limits = limitsFor(config, mode)
  if (limits.kind === 'unlimited') return { exhausted: false, reason: '' }
  const minutes = elapsedMinutes(usage, now)
  if (minutes > limits.minutes) {
    return { exhausted: true, reason: `the ${limits.minutes}-minute ceiling is reached (${minutes.toFixed(1)} min elapsed)` }
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
    `throttle: this turn's ceiling is reached (${ceiling} / ≤${limits.minutes} min) — ${reason}.`,
    'This is the dsh-throttle plugin\'s tier ceiling (the Tight / Wide tier), not the DSH sandbox refusing.',
    'Stop calling tools and do not retry. Give your conclusions, and hand back in exactly this order:',
    '## What I found / ## What needs your confirmation (high impact) / ## What I went with by default (low impact) / ## How you can verify / ## Suggested next stage.',
    'Write None for absent questions or assumptions. Suggest one bounded next action, or say Complete; wait for a reply before starting another stage.',
    'For a wider ceiling, ask the user to run /throttle (Wide) or /throttle open (Open).'
  ].join('\n')
}

/**
 * Decide one tool call against the turn's step ceiling.
 *
 * This guard is deliberately **read-only**: the step counter is advanced by
 * {@link observeStep} from the agent loop's own step numbering, so the guard
 * cannot drift from the loop and cannot be exhausted by fan-out. Every call issued
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
  const state = ceilingState(config, mode, usage, now)
  return state.exhausted ? denialText(config, mode, state.reason) : undefined
}
