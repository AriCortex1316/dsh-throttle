/**
 * `/throttle` — a three-tier mode for one Harness session.
 *
 * Default tier (the tier a session starts in): reasoning pinned to the cheapest
 * level the model declares, permissions limited to viewing, and a tight
 * per-turn budget. Deep tier (`/throttle`): a configurable reasoning effort, the
 * session's own permission preset restored, and a larger budget that still has
 * a ceiling. Free tier (`/throttle off`): the plugin stops constraining the
 * session altogether — no budget at all, no effort override, permissions left
 * to the session — which is the "as if the plugin were not installed" tier the
 * plan originally lacked, and the way out of the default tier's read-only trap.
 *
 * Two model-facing channels keep the model informed about which tier it is in
 * and *why* the file policy looks the way it does (see `IMPLEMENTATION-throttle-mode.md`):
 *
 * 1. `throttle:policy` — a system-prompt section whose text changes only with the
 *    tier, so a normal step never rewrites the cached prompt head.
 * 2. `throttle:state` — a runtime-context snapshot ordered right after the
 *    first-party `sandbox:policy` contribution. The Harness replaces the
 *    previous snapshot when the text changes, so this is where the live budget
 *    and the spent-budget hand-back format belong; sitting next to the
 *    `Current DSH file policy` line is what lets the model connect "read-only"
 *    to "the plugin's default tier wrote that preset".
 *
 * The plugin is an `apply`-form plugin whose only static import is its own
 * `state.js`, so it stays importable by a plain `node` process for unit testing
 * and cannot fail to load over a bare specifier. The two schema libraries it
 * needs are therefore loaded through optional **dynamic** imports — schemastery
 * for the settings form's `Config`, Zod for the projection's `wire.viewSchema`
 * (the wire contract's schema language) — and each degrades to a documented
 * fallback instead of failing the row. See the `schemastery` / `zod` bindings
 * below for why those are the right two.
 *
 * The browser half (`client.js`) draws the tier chip beside the model selector in
 * the composer bar and the row's configuration page on the Plugins page; it reads
 * the tier from this projection's published view and switches tiers by executing
 * the same `/throttle …` lines a human types, so the log stays the only source of
 * truth.
 *
 * Deviations from the plan and their reasons are recorded in
 * `../IMPLEMENTATION-throttle-mode.md`. The three that shape this file:
 *
 * 1. The tier is a session projection folded from `command/run` and
 *    `command/done` — event types the Harness already persists — instead of a
 *    plugin-owned `throttle/mode` event. A live `Session.append()` cannot set the
 *    `ignorable` marker that the persistence read path requires of a type
 *    outside `KNOWN_SESSION_EVENT_TYPES`, so a `throttle/mode` event would make
 *    every session containing it refuse to reopen. The projection keeps the
 *    plan's durability property — replay on restart and resume, inherited by a
 *    fork — without inventing log vocabulary.
 * 2. Reasoning effort is applied on the agent-scoped `agent/request` waterfall
 *    rather than by writing `model/selection`. That channel is per-session and
 *    never touches the profile's global default model, which the plan forbids;
 *    it also cannot clobber the provider/model the user picked in the selector,
 *    because this listener only ever replaces `reasoningEffort`. The free tier
 *    replaces nothing at all.
 * 3. The budget is enforced with `ctx.tools.guard()` rather than a
 *    `tools/pre-execute` listener: a guard is monotonic, so no later listener
 *    can turn a spent budget back into permission, and it still returns a
 *    model-facing reason.
 *
 * @module dsh-throttle
 */

import {
  EMPTY_THROTTLE_STATE,
  MODE_LABELS,
  MODES,
  createThrottleProjection,
  emptyUsage,
  guardDecision,
  limitsFor,
  modeOfState,
  nextMode,
  observeSessionEvent,
  observeStep,
  policySection,
  throttleView,
  receiptText,
  resolveConfig,
  restoreTarget,
  stateContext,
  statusLine,
  wantedPreset
} from './state.js'

/** Cordis plugin name. */
export const name = 'dsh-throttle'

/**
 * Services this plugin cannot work without. The permission and LLM services are
 * read opportunistically through `ctx.get()` instead, so `/throttle` still exists
 * — minus the capability that is missing — in a profile that omits them.
 */
export const inject = ['commands', 'systemPrompt', 'tools', 'sessionProjections']

/**
 * Schemastery, loaded through a **dynamic** import.
 *
 * Two reasons this is not a plain `import`:
 *
 * 1. The unit tests import this module from a bare `node` process in the
 *    plugin's own directory, where no `node_modules` resolves
 *    `@deepseek-ai/schemastery` at all. A static import would make the whole
 *    test file fail to load.
 * 2. A linked profile plugin resolves bare specifiers through the Harness's
 *    profile-resolution router, which hands out an installation package only
 *    when the plugin's own manifest lists it as a peer dependency (see
 *    `dsh-app-boot`'s linked-layer routing, and `@moguiyu/dsh-tavily`'s
 *    manifest for the same convention). If that ever stops holding, a static
 *    import fails the plugin row outright; here it degrades to "no settings
 *    form" with a logged warning.
 */
let schemastery = null
let schemasteryError = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch (error) {
  schemasteryError = error instanceof Error ? error.message : String(error)
}

/**
 * Zod, loaded the same way and for the same reasons.
 *
 * This is the schema language of the **projection wire contract**: the
 * session-projection registry validates every published view with
 * `wire.viewSchema.parse(...)`, and the first-party domains declare those
 * schemas with `import { z } from 'zod'` (`dsh-plan-mode`,
 * `dsh-permission-presets`), not with schemastery. Config schemas are the other
 * way round — `dsh-settings` reads a schemastery `Config` — so the two live
 * side by side here.
 *
 * Zod is optional: {@link viewSchema} falls back to a hand-written validator,
 * because the view is produced by this plugin and the registry only ever calls
 * `parse`.
 */
let zod = null
try {
  zod = (await import('zod')).z
} catch (_noZod) {
  zod = null
}

/**
 * Why the settings form is unavailable, or `null` when it is available.
 * @returns a printable reason, or `null`.
 */
export function settingsSchemaError () {
  return schemastery === null ? (schemasteryError ?? 'unknown reason') : null
}

/**
 * The row's config schema, derived into the *live* settings form the browser
 * renders (`dsh-settings` + `dsh-config-editor`).
 *
 * Both tier blocks are declared `.volatile()`, which is what makes them
 * editable in place: a write to the profile's `cordis.patch.yml` re-resolves
 * the config and updates these stable references through
 * `loader/volatile-update` **without remounting the plugin**. A non-volatile
 * field would force a full row reload on every edit instead.
 *
 * The bounds restate the floors `resolveConfig` enforces, so a form write is
 * refused at the settings boundary with a schema message rather than landing
 * and failing the plugin on the next reload. `resolveConfig` stays as the
 * belt-and-braces check for hand-edited YAML.
 */
export const Config = schemastery === null
  ? undefined
  : schemastery.object({
      default: schemastery
        .object({
          // **No `.default()` here, deliberately.** The Loader resolves this
          // schema *before* `apply()` runs, so a schema default for `steps`
          // would fill the key whenever the patch omitted it — and then
          // `resolveConfig`'s `defaults.steps ?? defaults.toolCalls` could never
          // reach the legacy alias, silently turning a patch that says
          // `toolCalls: 6` into 4 steps. The built-in 4 lives in `resolveConfig`,
          // the only place that can see both keys. The form still shows 4: its
          // controls carry their own fallback for a value the layer omits.
          steps: schemastery.number().min(1),
          // The pre-rename key, kept in the schema so a profile patch that still
          // carries it validates instead of failing the row before `apply` runs.
          toolCalls: schemastery.number().min(1),
          minutes: schemastery.number().min(1).default(2),
          effort: schemastery.string().default('low'),
          permission: schemastery.string().default('read-only')
        })
        .default({})
        .volatile(),
      deep: schemastery
        .object({
          steps: schemastery.number().min(5).default(5),
          minutes: schemastery.number().min(5).default(5),
          effort: schemastery.string().default('high'),
          permission: schemastery.string().default('restore')
        })
        .default({})
        .volatile()
    })

/**
 * Read one config field that a volatile schema turns into a stable reference.
 * A plain value stays itself, so the plugin keeps working in a composition
 * that never resolved the schema.
 * @param value - the config field.
 * @returns its current plain value.
 */
function plainValue (value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * The client-facing `viewSchema` for the tier projection.
 *
 * The registry validates each published view with `viewSchema.parse`, and the
 * projection wire contract speaks Zod — so a Zod schema is the primary form
 * here, with a hand-written validator for a composition where Zod does not
 * resolve. The fallback is safe by construction: the view is produced by this
 * plugin, so it cannot admit foreign data either way.
 * @returns a `{ parse }` validator.
 */
function viewSchema () {
  if (zod !== null) {
    const tier = zod.object({
      kind: zod.string(),
      max: zod.number().nullable(),
      minutes: zod.number().nullable(),
      effort: zod.string().nullable()
    })
    return zod.object({
      mode: zod.string(),
      running: zod.boolean(),
      tiers: zod.object({ default: tier, deep: tier, free: tier })
    })
  }
  return {
    parse: (value) => {
      const tiers = value === null ? undefined : value.tiers
      if (value === null || typeof value !== 'object' ||
        typeof value.mode !== 'string' || typeof value.running !== 'boolean' ||
        tiers === null || typeof tiers !== 'object') {
        throw new TypeError('dsh-throttle: throttleMode view must be { mode: string, running: boolean, tiers: object }')
      }
      for (const mode of MODES) {
        const entry = tiers[mode]
        if (entry === null || typeof entry !== 'object' || typeof entry.kind !== 'string') {
          throw new TypeError(`dsh-throttle: throttleMode view tiers.${mode} must be { kind, max, minutes, effort }`)
        }
      }
      return value
    }
  }
}

/** The prompt section's order: after `PLAN_POLICY` (500), before `TEAM_POLICY` (600). */
const SECTION_ORDER = 520

/**
 * The first-party `sandbox:policy` runtime-context order, used as the fallback
 * when the prompt service cannot be asked for the allocated slot.
 */
const SANDBOX_POLICY_CONTEXT_ORDER = 110

/** Preset ids that are never selectable by name. */
const RESERVED_PRESETS = ['custom', 'auto']

/**
 * The runtime-context slot for `throttle:state`.
 *
 * Two orders after `sandbox:policy`, so the model reads the cause next to the
 * `Current DSH file policy: …` line it explains rather than in a separate place.
 *
 * @param ctx - the plugin's context.
 * @returns the numeric order.
 */
function contextOrder (ctx) {
  const sandbox = ctx.systemPrompt.getContextOrder?.('SANDBOX_POLICY')
  return (typeof sandbox === 'number' ? sandbox : SANDBOX_POLICY_CONTEXT_ORDER) + 2
}

/**
 * Read an error's message without trusting its shape.
 * @param error - the thrown value.
 * @returns a printable message.
 */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the `/throttle` plugin on one Cordis context.
 * @param ctx - the plugin's context.
 * @param config - the row's `config`, validated here (a refusal falls back to
 * the built-in defaults instead of failing the row — see {@link initialSettings}).
 */
export function apply (ctx, config) {
  const source = config ?? {}

  /**
   * Resolve the row's config without ever failing the plugin load.
   *
   * A refused config is a bug in the *patch*, not a reason to remove the only
   * throttle a session has. The first version of the step-counting rename made
   * `default.toolCalls` an unknown key, and the resulting throw removed the
   * whole plugin row from a live session — the tier, the chip and the guard all
   * vanished at once. The refusal is logged in full and the built-in defaults
   * stand in, so the plugin stays mounted and the user can see and fix the
   * cause. `resolveConfig` itself still fails loud: this is the outermost
   * boundary, where failing means losing the plugin.
   *
   * @returns the resolved config, or the built-in defaults when it is refused.
   */
  const initialSettings = () => {
    try {
      const resolved = resolveConfig({ default: plainValue(source.default), deep: plainValue(source.deep) })
      configIssue = null
      return resolved
    } catch (error) {
      ctx.logger.warn('dsh-throttle: the row config was refused, so the built-in defaults are in force until it is fixed: %s', messageOf(error))
      configIssue = messageOf(error)
      return resolveConfig(undefined)
    }
  }

  /**
   * Why the row config was last refused, or `null` while it resolves.
   *
   * The fallback keeps the plugin mounted, but a fallback nobody can see is
   * indistinguishable from a deliberate configuration: the model would report
   * the built-in numbers as the user's own. This is rendered into the
   * `throttle:state` snapshot and into every `/throttle` receipt, so both the
   * model and the user are told what was refused and why.
   */
  let configIssue = null

  let settings = initialSettings()

  /** Per-session in-memory budget, keyed by the session object. */
  const budgets = new WeakMap()
  /** Per-agent effort-listener disposers, so plugin unload removes them all. */
  const agentDisposers = new Map()
  /** Whether one `provider/model` advertises one effort, cached per process. */
  const effortSupport = new Map()

  // The live config: the settings form edits the profile patch, the Loader
  // re-resolves the config and updates the volatile references in place, then
  // announces the change to this fiber. Nothing remounts, so the model-facing
  // text, the ceilings and the guard all follow the new numbers from the next
  // step and the next request onward. A rejected candidate leaves the running
  // values untouched.
  ctx.on('loader/volatile-update', () => {
    try {
      settings = resolveConfig({ default: plainValue(source.default), deep: plainValue(source.deep) })
      configIssue = null
      ctx.logger.info('dsh-throttle: configuration updated — %s', statusLine(settings, 'default', 'view-only'))
    } catch (error) {
      // The previous values stay in force, and the refusal is published to the
      // model with them: the edit landed in the patch but not in this session.
      configIssue = messageOf(error)
      ctx.logger.warn('dsh-throttle: the configuration update was refused, so the previous values stay in force: %s', configIssue)
    }
  })

  // The fold keeps the config it was registered with (a tier's meaning must not
  // depend on when it is replayed), while the published view reads the live one
  // so an edited ceiling shows up at the next publish — which a tier switch
  // itself performs.
  const liveSettings = () => {
    try {
      return resolveConfig({ default: plainValue(source.default), deep: plainValue(source.deep) })
    } catch (error) {
      return settings
    }
  }
  ctx.sessionProjections.register(createThrottleProjection(settings, {
    viewSchema: viewSchema(),
    view: (state) => throttleView(liveSettings(), state)
  }))

  /**
   * The session's tier state, falling back to the empty state when the
   * registry has been torn down underneath this plugin.
   * @param session - the session to read.
   * @returns the projection state.
   */
  const throttleState = (session) => ctx.sessionProjections.stateOf(session, 'throttleMode') ?? EMPTY_THROTTLE_STATE

  /**
   * The session id that delegated to this one, when this session is a
   * `subagent` child. A forked child carries the same header, but its log
   * inherits the parent's `/throttle` records, so it decides its own tier.
   * @param session - the session to read.
   * @returns the delegating session id, or `undefined`.
   */
  const delegatorIdOf = (session) => {
    const header = session?.header
    if (header === undefined || header.origin !== 'subagent') return undefined
    return typeof header.parentSession === 'string' ? header.parentSession : undefined
  }

  /**
   * The last tier computed for a session id.
   *
   * A delegator is normally live while its children run, but it can be disposed
   * (a finished parent, a resumed child); remembering the computed tier keeps
   * such a child on the tier its delegator actually had instead of silently
   * dropping it back to Tight.
   */
  const knownTiers = new Map()

  /**
   * The tier in force for one session, and where it comes from.
   *
   * A session with a successful `/throttle` in its own log owns its tier. A
   * session without one — the shape every `subagent` child has, since no
   * command was ever run in it — follows the session that delegated to it,
   * transitively for nested delegation. This is what keeps a delegated
   * sub-session from being silently pinned to Tight while the session that
   * started it works in Wide or Open.
   *
   * The lookup is deliberately live rather than a copy taken at creation: the
   * tier a delegator is in *now* is the tier its children run under, so
   * switching the parent is what widens or narrows its children.
   *
   * @param session - the session to resolve.
   * @param chain - the sessions already visited, so a corrupt lineage cannot loop.
   * @returns `{ mode, inherited, child }`.
   */
  const tierOf = (session, chain = new Set()) => {
    const state = throttleState(session)
    const own = modeOfState(state)
    const child = delegatorIdOf(session) !== undefined
    const id = session?.header?.id
    const key = id === undefined ? undefined : String(id)
    // The session's own log decides, and a reused id in `knownTiers` must not
    // outlive that decision.
    if (!child || state.commanded === true) {
      if (key !== undefined) knownTiers.set(key, own)
      return { mode: own, inherited: false, child }
    }
    if (key !== undefined && chain.has(key)) return { mode: own, inherited: false, child }
    if (key !== undefined) chain.add(key)
    const delegatorId = delegatorIdOf(session)
    const delegator = ctx.get('agents')?.get(delegatorId)?.session
    const inherited = delegator === undefined
      ? knownTiers.get(delegatorId)
      : tierOf(delegator, chain).mode
    if (inherited === undefined) {
      // The delegator is neither live nor remembered: this session's own fold
      // is all there is, which is the pre-inheritance behaviour.
      if (key !== undefined) knownTiers.set(key, own)
      return { mode: own, inherited: false, child }
    }
    if (key !== undefined) knownTiers.set(key, inherited)
    return { mode: inherited, inherited: true, child }
  }

  /** The tier in force for one session, without the provenance. */
  const modeFor = (session) => tierOf(session).mode

  /**
   * The session's budget record, created on first use.
   * @param session - the session to read.
   * @returns the mutable budget record.
   */
  const budgetOf = (session) => {
    let budget = budgets.get(session)
    if (budget === undefined) {
      budget = emptyUsage()
      budgets.set(session, budget)
    }
    return budget
  }

  /** The permission-preset service, when this profile mounts one. */
  const permissions = () => ctx.get('permissionPresets')

  /**
   * Whether a name is a preset this session could switch to.
   * @param preset - the candidate name.
   * @returns true when the preset service offers it.
   */
  const selectable = (preset) => {
    if (typeof preset !== 'string' || preset === '' || RESERVED_PRESETS.includes(preset)) return false
    const names = permissions()?.names
    return Array.isArray(names) && names.includes(preset)
  }

  /**
   * The session's effective preset, without throwing when the projection that
   * backs it is absent.
   * @param session - the session to read.
   * @returns the preset name, or `undefined`.
   */
  const currentPreset = (session) => {
    const service = permissions()
    if (service === undefined) return undefined
    try {
      return service.current(session)
    } catch (error) {
      ctx.logger.warn('dsh-throttle: could not read the permission preset: %s', messageOf(error))
      return undefined
    }
  }

  /**
   * Switch one session's permission preset, reporting instead of throwing.
   * @param session - the session to switch.
   * @param preset - the preset to select.
   * @returns `{ ok, detail }`, where `detail` is the receipt text for the preset.
   */
  const applyPreset = (session, preset) => {
    const service = permissions()
    if (service === undefined) return { ok: false, detail: 'the permission service is unavailable' }
    if (!selectable(preset)) return { ok: false, detail: `the preset "${preset}" is not selectable` }
    try {
      service.set(session, preset)
      return { ok: true, detail: preset }
    } catch (error) {
      return { ok: false, detail: `the switch failed: ${messageOf(error)}` }
    }
  }

  /**
   * The permission preset this session's tier wants, or `undefined` when the
   * tier has no opinion here.
   *
   * A delegated sub-session is the special case: the Harness fixed its scope
   * when it started it ("your permission scope was fixed when you were started",
   * the subagent runtime's own words), so the only thing the plugin may do with
   * it is put back what this plugin itself took away — the Tight tier's
   * read-only pin. A Tight tier still means view-only for a child; an inherited
   * Wide or Open tier never narrows the delegated scope, and never widens it
   * beyond releasing that pin.
   *
   * @param session - the session to read.
   * @param tier - `{ mode, inherited, child }` for the session.
   * @returns the preset to select, or `undefined` for no opinion.
   */
  const wantedPresetFor = (session, tier) => {
    const state = throttleState(session)
    if (!tier.child || !tier.inherited) return wantedPreset(settings, tier.mode, state, selectable)
    if (tier.mode === 'default') return settings.default.permission
    return currentPreset(session) === settings.default.permission
      ? restoreTarget(settings, state, selectable)
      : undefined
  }

  /**
   * Put a session into the permission state its tier requires, if it is not
   * already there.
   *
   * This runs before every step, which is what makes the default tier "on from
   * the first request" without a record of its own: a session that never ran
   * `/throttle` folds to the default tier, and a session the user manually
   * un-confines is put back. Both directions are idempotent —
   * `permissionPresets.set()` appends nothing when the preset already matches —
   * so this converges instead of churning the log. It is also the escape hatch
   * out of the read-only trap: the moment the session is in deep or free, the
   * next step restores the session's own writable preset — or, for a delegated
   * sub-session, releases the pin without touching the scope it was started with
   * (see {@link wantedPresetFor}).
   *
   * @param session - the session to reconcile.
   * @returns the preset the session should hold, or `undefined` when unknown.
   */
  const reconcile = (session) => {
    const tier = tierOf(session)
    const wanted = wantedPresetFor(session, tier)
    if (wanted === undefined) return undefined
    if (currentPreset(session) === wanted) return wanted
    const applied = applyPreset(session, wanted)
    if (!applied.ok) {
      ctx.logger.warn('dsh-throttle: could not put the session into its %s-tier preset: %s', tier.mode, applied.detail)
      return undefined
    }
    return wanted
  }

  /**
   * The permission facts to show the model for one session's tier.
   *
   * `source` is what makes the model-facing text answer "why is it read-only":
   * `plugin` means this plugin wrote the preset for the tier, `session` means
   * the preset is the session's own and the plugin is not touching it,
   * `delegated` means this is a sub-session whose scope the Harness fixed when
   * it started (an inherited tier never rewrites it), and `pending` means the
   * tier's target preset is not in effect yet — the first prompt assembly of a
   * session runs before the first pre-step, and a user can change the preset
   * between steps, so this is a normal transient rather than a failure.
   *
   * @param session - the session to read.
   * @param tier - `{ mode, inherited, child }` for the session.
   * @returns `{ preset, source, target }`.
   */
  const permissionFacts = (session, tier) => {
    const current = currentPreset(session)
    const target = wantedPresetFor(session, tier)
    // An inherited Wide/Open tier with no target is the delegated scope itself:
    // neither this plugin's choice nor the session's own.
    if (tier.child && tier.inherited && tier.mode !== 'default' && target === undefined) {
      return { preset: current, source: 'delegated', target: undefined }
    }
    if (current === undefined) {
      return { preset: undefined, source: target === undefined ? 'unknown' : 'pending', target }
    }
    if (current === target) {
      // The plugin put the delegated scope back after its own Tight pin; the
      // scope is still the delegation's, not the session's own preference.
      if (tier.child && tier.inherited && tier.mode !== 'default') return { preset: current, source: 'delegated', target }
      return { preset: current, source: tier.mode === 'default' ? 'plugin' : 'session', target }
    }
    return { preset: current, source: 'pending', target }
  }

  /**
   * Apply a tier's permission intent immediately, instead of waiting for the
   * next pre-step.
   * @param session - the session to switch.
   * @param target - the tier being entered.
   * @param state - the projection state before the command commits.
   * @returns the receipt detail, or `undefined` to let the status line default.
   */
  const applyTarget = (session, target, state) => {
    if (target === 'default') {
      const applied = applyPreset(session, settings.default.permission)
      return applied.ok ? undefined : applied.detail
    }
    const wanted = restoreTarget(settings, state, selectable)
    if (wanted === undefined) return undefined
    const applied = applyPreset(session, wanted)
    return applied.ok ? wanted : applied.detail
  }

  /**
   * Ask the LLM service whether one model advertises one reasoning effort, so a
   * model that declares no reasoning capability is left untouched instead of
   * failing the turn with `UNSUPPORTED_REASONING_EFFORT`. Cached per model.
   * @param provider - the provider route.
   * @param model - the model id.
   * @param effort - the effort id to look for.
   * @returns true when the effort is advertised.
   */
  const supportsEffort = async (provider, model, effort) => {
    const key = `${provider}\u0000${model}`
    let advertised = effortSupport.get(key)
    if (advertised === undefined) {
      advertised = new Set()
      const service = ctx.get('llm')
      if (service !== undefined && typeof service.resolveModelInfo === 'function') {
        try {
          const info = await service.resolveModelInfo(provider, model)
          for (const entry of info?.reasoning?.efforts ?? []) advertised.add(entry.id)
        } catch (error) {
          ctx.logger.warn('dsh-throttle: could not read the reasoning capability of %s/%s: %s', provider, model, messageOf(error))
        }
      }
      effortSupport.set(key, advertised)
    }
    return advertised.has(effort)
  }

  /**
   * Bind one agent's request-time effort control.
   *
   * Registered with `prepend` so this listener stays outermost in the
   * `agent/request` waterfall: `installModelSelection` re-applies its own
   * effort after the inner chain resolves, so only an outermost listener can
   * decide the value the request finally carries.
   * @param agent - the agent to bind.
   */
  const attachAgent = (agent) => {
    if (agentDisposers.has(agent)) return
    const listener = async (_payload, next) => {
      const resolved = await next()
      if (resolved === undefined || resolved === null) return resolved
      if (resolved.provider === undefined || resolved.model === undefined) return resolved
      const effort = limitsFor(settings, modeFor(agent.session)).effort
      // The free tier pins no effort: whatever the session or the model
      // selector chose stays exactly as it is.
      if (effort === null) return resolved
      if (resolved.reasoningEffort === effort) return resolved
      if (!(await supportsEffort(resolved.provider, resolved.model, effort))) return resolved
      return { ...resolved, reasoningEffort: effort }
    }
    agentDisposers.set(agent, agent.ctx.on('agent/request', listener, { prepend: true }))
  }

  // ── 1. the model-facing policy: stable prompt section + live context ───────
  // The section changes only with the tier, so the cached prompt head survives
  // an ordinary step; the context carries the volatile facts and sits next to
  // `sandbox:policy` so "read-only" and "why read-only" are read together.
  ctx.systemPrompt.section({
    name: 'throttle:policy',
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const session = agent.session
      const tier = tierOf(session)
      return policySection(settings, tier.mode, permissionFacts(session, tier), tier.inherited)
    }
  })

  ctx.systemPrompt.context({
    name: 'throttle:state',
    order: contextOrder(ctx),
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const session = agent.session
      const tier = tierOf(session)
      return stateContext(settings, tier.mode, budgetOf(session), Date.now(), permissionFacts(session, tier), {
        inherited: tier.inherited,
        issue: configIssue
      })
    }
  })

  // ── 2. per-turn budget accounting and tier/permission convergence ─────────
  // The turn boundary is folded from the log, not from `agent/pre-step`: the
  // loop assembles the prompt — and therefore renders the `throttle:state` snapshot
  // — *before* it runs the pre-step waterfall, so a record opened only there is
  // still the previous turn's when a turn's first snapshot is written. Elapsed
  // time is wall clock, so that stale record charged the idle gap between two
  // turns to the new one (88 minutes of sitting idle read as "88.0 min spent"
  // against a 2-minute ceiling). `turn/start` and `turn/end` are committed
  // before the assembly, so the two of them are folded here to keep the snapshot
  // honest; `agent/pre-step` below stays as the in-turn accounting and as the
  // fallback for a log whose turn boundary this listener never saw.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start' && event?.type !== 'turn/end') return
    observeSessionEvent(budgetOf(session), event, event.time ?? Date.now())
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (agent !== undefined) {
      observeStep(budgetOf(agent.session), { turn, step }, Date.now())
      reconcile(agent.session)
    }
    return next()
  })

  // A guard denies after the extensible `tools/pre-execute` waterfall and
  // cannot be overridden by a later listener, which is what "stop at the
  // ceiling" needs. It runs once per attempted execution, which is the unit the
  // budget counts.
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const session = agent.session
    if (!budgets.has(session)) return undefined
    return guardDecision(settings, modeFor(session), budgetOf(session), Date.now())
  })

  // ── 3. reasoning effort per session ──────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => {
    if (agent !== undefined) attachAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = agentDisposers.get(agent)
    if (dispose !== undefined) {
      agentDisposers.delete(agent)
      dispose()
    }
  })
  ctx.effect(() => () => {
    for (const dispose of agentDisposers.values()) dispose()
    agentDisposers.clear()
  }, 'dsh-throttle: detach agent listeners')

  // ── 4. the human command ─────────────────────────────────────────────────
  // The projection folds this command's own `command/run` / `command/done`
  // pair, so the durable tier is derived from the log rather than written by
  // this handler. The handler only has to agree with the fold and apply the
  // permission immediately, instead of waiting for the next step.
  ctx.commands.register({
    definitionId: 'dsh-throttle',
    name: 'throttle',
    description: 'Switch the /throttle tier (Tight / Wide / Open): a bare command toggles Tight ⇄ Wide, open releases every limit',
    input: { hint: '[tight|wide|open]' },
    handler: ({ agent, rawInput, attachments, signal }) => {
      if (attachments.length > 0) return { kind: 'error', text: '/throttle takes no attachments.' }
      const argument = rawInput.trim().toLowerCase()
      const state = throttleState(agent.session)
      const tier = tierOf(agent.session)
      const from = modeOfState(state)
      const target = nextMode(from, argument)
      if (target === undefined) {
        return {
          kind: 'error',
          text: `Usage: /throttle (Tight ⇄ Wide) · /throttle wide · /throttle open · /throttle tight; got "${rawInput.trim()}"`
        }
      }
      if (signal.aborted) return { kind: 'error', text: '/throttle was cancelled.' }
      const detail = applyTarget(agent.session, target, state)
      let note
      if (from === target) note = `(already in the ${MODE_LABELS[target]} tier)`
      else if (target === 'deep') note = '(a second /throttle returns to Tight; /throttle open releases every limit)'
      else if (target === 'free') note = '(Open tier: this plugin sets no ceiling, changes no permission and pins no reasoning level; /throttle or /throttle on returns to Tight)'
      else note = from === 'free' ? '(the Open tier is closed; back to Tight)' : '(the Wide tier is closed; back to Tight)'
      // A sub-session that was following its delegator has just been given a
      // tier of its own; say so instead of letting the receipt read as if the
      // inherited tier had been this session's all along.
      if (tier.inherited) note = `${note} (this session had no tier of its own and was following the delegating session\'s; it now owns the one above, and only the delegating session can widen it again)`
      // A refused row config is the one case where the numbers in the receipt
      // are not the user's: name it rather than let it pass as configured.
      if (configIssue !== null) note = `${note}\n⚠ the row config was refused, so the numbers above are the plugin's built-in defaults until it is fixed — ${configIssue}`
      return { kind: 'success', text: receiptText(settings, target, detail, note) }
    }
  })

  const schemaError = settingsSchemaError()
  if (schemaError === null) {
    ctx.logger.info('dsh-throttle: the settings form is ready (edit it on the dsh-throttle card of the Plugins page)')
  } else {
    ctx.logger.warn('dsh-throttle: the settings form is unavailable (@deepseek-ai/schemastery did not load: %s) — edit the profile\'s cordis.patch.yml to change the numbers instead', schemaError)
  }
  ctx.logger.info('dsh-throttle: %s', statusLine(settings, 'default', 'view-only'))
}
