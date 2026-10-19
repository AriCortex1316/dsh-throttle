/** Host 配置与投影视图的 schema；依赖缺失时保留纯 Node 可加载性。 */
import { MODES } from './lib/constants.js'

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
 * The client-facing `viewSchema` for the tier projection.
 *
 * The registry validates each published view with `viewSchema.parse`, and the
 * projection wire contract speaks Zod — so a Zod schema is the primary form
 * here, with a hand-written validator for a composition where Zod does not
 * resolve. The fallback is safe by construction: the view is produced by this
 * plugin, so it cannot admit foreign data either way.
 * @returns a `{ parse }` validator.
 */
export function viewSchema () {
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
