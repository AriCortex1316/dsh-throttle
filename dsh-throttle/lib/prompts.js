/** 档位说明、阶段总结格式和模型运行时上下文。 */
import { RECEIPT } from './constants.js'
import { limitsFor } from './config.js'
import { ceilingState, usageSummary } from './usage.js'

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

/** 阶段交接格式：无待确认事项时如实写 None，并给出下一阶段建议。 */
export const SURRENDER_TEMPLATE = [
  '## What I found',
  '(the facts and conclusions confirmed so far — as far as they go)',
  '',
  '## What needs your confirmation (high impact)',
  '(only unresolved questions that change the approach, and why; write None if there are none)',
  '',
  '## What I went with by default (low impact)',
  '(defaults actually used, plus one reason each; write None if there are none)',
  '',
  '## How you can verify',
  '(one relevant command or check; distinguish checks already run from suggested checks, and say if verification is unavailable)',
  '',
  '## Suggested next stage',
  '(one concrete, bounded next action and any confirmation it needs; if complete, say Complete; wait for a reply before starting another stage)'
].join('\n')

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
  return `${RECEIPT.default} · reasoning ${limits.effort} (lowest) · ${scope} · ≤${limits.minutes} min · ${detail === undefined ? 'view-only' : detail}`
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
 * live ceiling and the reached-ceiling hand-back format) live in
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
      'This tier sets no tool, step or time ceiling and does not override the request\'s reasoning level. The plugin\'s standing collaboration rules still apply.',
      `Permissions: ${permissionPhrase(permission)}; the plugin only puts a preset back when it finds the session pinned to the Tight tier's read-only preset.`,
      'Switch: `/throttle` or `/throttle on` returns to Tight; `/throttle wide` goes straight to Wide.'
    )
  } else if (mode === 'deep') {
    lines.push(
      '[throttle] current tier: Wide (tier 2 — opened by /throttle)',
      `This tier's ceiling: reasoning ${limits.effort} · ≤${limits.max} steps · ≤${limits.minutes} min (further tool calls are refused after a step or time limit is exceeded).`,
      `Permissions: ${permissionPhrase(permission)}.`,
      'Use the runtime checkpoint to finish or hand back early. After a limit is exceeded, stop calling tools and summarize in the fixed format.',
      'Switch: `/throttle` returns to Tight; `/throttle open` releases every limit.'
    )
  } else {
    lines.push(
      '[throttle] current tier: Tight (tier 1 — what every session starts in, enforced by the dsh-throttle plugin)',
      `This tier's limits: reasoning held at ${limits.effort} (the lowest level) · ≤${limits.max} steps · ≤${limits.minutes} min · the permission preset pinned to ${config.default.permission}.`,
      `Permissions: ${permissionPhrase(permission)}.`,
      'Writes, and scripts that land files, are refused by the sandbox: that is this tier\'s definition, not a mistake of yours. Do not retry, and do not switch the permission preset yourself.',
      'When a file has to be written, tell the user to run `/throttle` for the Wide tier (writable, ≥5 steps) or `/throttle open` for the Open tier (no ceiling, writable).',
      'Use the runtime checkpoint to finish or hand back early. After a limit is exceeded, stop calling tools and summarize in the fixed format.'
    )
  }
  lines.push('', '## Standing rules (in force in every tier)', STANDING_RULES)
  return lines.join('\n')
}

/**
 * The runtime-context snapshot: the tier, the cause of the current file policy,
 * the live ceiling, and — once the ceiling is reached — the fixed hand-back format.
 *
 * The Harness orders this right after `sandbox:policy` and replaces the previous
 * snapshot when the text changes, so the model reads "why read-only" beside the
 * `Current DSH file policy: read-only` line that prompted the question, and a
 * per-step ceiling change costs one replaced line rather than a prompt rewrite.
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
    lines.push('This tier is **inherited from the session that delegated to this one** (this session has run no `/throttle` of its own). Its ceiling, its reasoning level and its permissions below are the ones actually enforced here; a ceiling that blocks the task belongs in your reply to the delegating session.')
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
      'After the ceiling is exceeded, further tools are refused and you must summarize. `/throttle open` removes the plugin\'s step and time ceilings.'
    )
  } else {
    lines.push(
      '[throttle:state] tier: Tight (dsh-throttle tier 1, what every session starts in)',
      `The plugin's Tight tier pins the session permission preset to ${config.default.permission}; the file-policy line you can see (Current DSH file policy) is where that preset lands — it is not DSH's deployment default and not something the user changed on the spot.`,
      `This tier's limits: reasoning ${limits.effort} (the lowest level) · ≤${limits.max} steps · ≤${limits.minutes} min; permissions: ${permissionPhrase(permission)}.`,
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

  const state = ceilingState(config, mode, usage, now)
  if (limits.kind !== 'unlimited' && state.exhausted) {
    lines.push(
      '',
      `**This turn's ceiling is reached** (${state.reason}). Stop, do not call any more tools, and hand back in the fixed format below:`,
      '',
      SURRENDER_TEMPLATE
    )
  } else if (limits.kind !== 'unlimited' && usage.active) {
    const used = usageSummary(usage, now)
    lines.push(`This turn: step ${used.step}/${limits.max} · ${used.minutes.toFixed(1)}/${limits.minutes} min.`)
    // 软检查点随上下文装配刷新，不改变工具守卫，也不创建计时器。
    if (used.step >= limits.max * 0.75 || used.minutes >= limits.minutes * 0.75) {
      lines.push(
        '',
        '**Stage checkpoint: at least 75% of this turn\'s step or time allowance has been observed.** This is an advisory checkpoint; tools are still permitted within the tier ceiling.',
        'If the task is already answered or complete, give the result now. If a high-impact unknown blocks the approach, hand back the confirmed findings and the key question now. Otherwise, use the remaining allowance only for the most important focused check; avoid starting new branches or delegating new exploration just to use the allowance.',
        `For a partial hand-back, use the format below and wait for a reply from ${inherited ? 'the delegating session' : 'the user'} before starting the suggested next stage. Do not invent questions or assumptions to fill the format:`,
        '',
        SURRENDER_TEMPLATE
      )
    }
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
