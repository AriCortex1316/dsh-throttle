/**
 * Cordis Host 入口：连接命令、会话投影、工具守卫与模型请求。
 * 纯逻辑位于 lib/，schema 位于 schemas.js，浏览器入口为 client.js。
 */

import {
  EMPTY_THROTTLE_STATE,
  MODE_LABELS,
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

import { settingsSchemaError, viewSchema } from './schemas.js'
export { Config, settingsSchemaError } from './schemas.js'

/** Cordis plugin name. */
export const name = 'dsh-throttle'

/**
 * Services this plugin cannot work without. The permission and LLM services are
 * read opportunistically through `ctx.get()` instead, so `/throttle` still exists
 * — minus the capability that is missing — in a profile that omits them.
 */
export const inject = ['commands', 'systemPrompt', 'tools', 'sessionProjections']

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

  /** Per-session in-memory ceiling, keyed by the session object. */
  const ceilings = new WeakMap()
  // 只凭本进程实际写入的 pin 恢复委派权限，预设同名不代表插件拥有它。
  const delegatedPins = new WeakMap()
  /** Per-agent effort-listener disposers, so plugin unload removes them all. */
  const agentDisposers = new Map()

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
   * The session's ceiling record, created on first use.
   * @param session - the session to read.
   * @returns the mutable ceiling record.
   */
  const ceilingOf = (session) => {
    let ceiling = ceilings.get(session)
    if (ceiling === undefined) {
      ceiling = emptyUsage()
      ceilings.set(session, ceiling)
    }
    return ceiling
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
    const pin = delegatedPins.get(session)
    return pin !== undefined && currentPreset(session) === pin.preset && selectable(pin.original)
      ? pin.original
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
    const current = currentPreset(session)
    if (current === wanted) return wanted
    const applied = applyPreset(session, wanted)
    if (!applied.ok) {
      ctx.logger.warn('dsh-throttle: could not put the session into its %s-tier preset: %s', tier.mode, applied.detail)
      return undefined
    }
    if (tier.child && tier.inherited) {
      if (tier.mode === 'default') {
        const pin = delegatedPins.get(session)
        delegatedPins.set(session, {
          preset: wanted,
          original: pin !== undefined && current === pin.preset ? pin.original : current
        })
      } else {
        delegatedPins.delete(session)
      }
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
   * failing the turn with `UNSUPPORTED_REASONING_EFFORT`.
   * @param provider - the provider route.
   * @param model - the model id.
   * @param effort - the effort id to look for.
   * @returns true when the effort is advertised.
   */
  const supportsEffort = async (provider, model, effort) => {
    // 能力可能随服务就绪或模型配置更新而改变，不缓存缺失、失败或旧目录。
    const service = ctx.get('llm')
    if (typeof service?.resolveModelInfo !== 'function') return false
    try {
      const info = await service.resolveModelInfo(provider, model)
      return (info?.reasoning?.efforts ?? []).some((entry) => entry.id === effort)
    } catch (error) {
      ctx.logger.warn('dsh-throttle: could not read the reasoning capability of %s/%s: %s', provider, model, messageOf(error))
      return false
    }
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
      return stateContext(settings, tier.mode, ceilingOf(session), Date.now(), permissionFacts(session, tier), {
        inherited: tier.inherited,
        issue: configIssue
      })
    }
  })

  // ── 2. per-turn ceiling accounting and tier/permission convergence ─────────
  // The turn boundary is folded from the log, not from `agent/pre-step`: the
  // loop assembles the prompt — and therefore renders the `throttle:state` snapshot
  // — *before* it runs the pre-step waterfall, so a record opened only there is
  // still the previous turn's when a turn's first snapshot is written. Elapsed
  // time is wall clock, so that stale record charged the idle gap between two
  // turns to the new one (88 minutes of sitting idle read as "88.0 min elapsed"
  // against a 2-minute ceiling). `turn/start` and `turn/end` are committed
  // before the assembly, so the two of them are folded here to keep the snapshot
  // honest; `agent/pre-step` below stays as the in-turn accounting and as the
  // fallback for a log whose turn boundary this listener never saw.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start' && event?.type !== 'turn/end') return
    observeSessionEvent(ceilingOf(session), event, event.time ?? Date.now())
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (agent !== undefined) {
      observeStep(ceilingOf(agent.session), { turn, step }, Date.now())
      reconcile(agent.session)
    }
    return next()
  })

  // 守卫在 tools/pre-execute 瀑布之后单调拒绝，每次执行前读取本轮步数与时间。
  // 计数由 pre-step 更新，工具调用本身不增加步数。
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const session = agent.session
    if (!ceilings.has(session)) return undefined
    return guardDecision(settings, modeFor(session), ceilingOf(session), Date.now())
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
  // 重载插件时已有会话不会再次发出 created，需要补挂请求监听。
  for (const agent of ctx.get('agents')?.list?.() ?? []) attachAgent(agent)

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
      else if (target === 'free') note = '(Open tier: no step or time ceiling, no reasoning override; preset restoration and standing collaboration rules still apply; /throttle or /throttle on returns to Tight)'
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
