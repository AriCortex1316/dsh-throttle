/**
 * Browser half of `dsh-throttle`: the tier chip beside the model selector in the
 * composer bar (with the switch panel) and the row's configuration page on the
 * sidebar's Plugins page.
 *
 * Two surfaces, one contract each:
 *
 * 1. **`conversation.input.right`** — the persistent status chip, in the
 *    composer's trailing group immediately before the model selector. That slot
 *    is a `list` the conversation's own composer bar renders at
 *    `conversation.composer.bar`, declared by the same client module the chip
 *    already injects, so no additional dependency is involved. It reads the tier
 *    from the `throttleMode` session projection (the Host's `wire.view`, so the
 *    tier and every ceiling are computed on the Host and never re-folded here),
 *    and it switches tiers by executing the same `/throttle …` lines a human
 *    would type. The switch is not client optimism: the command writes the log,
 *    the projection folds it, and the chip follows the frame — which is what
 *    keeps a refused switch from showing a tier that never happened.
 *
 *    The mode chips the same row already carries are the neighbours this belongs
 *    with: `conversation.input.permission` (the permission preset) sits in the
 *    leading group, the model selector in the trailing one, and this chip renders
 *    immediately before it. The tooltip opens upwards because the composer sits at
 *    the bottom of the window.
 *
 * 2. **`plugins.bundle.config`** keyed `dsh-throttle` — the plugin's page on the
 *    Plugins page, rendered on the bundle's card between its description and its
 *    rows: first the plugin's own introduction (`intro.*`, written in the active
 *    locale like every other string here), then the editable form for the
 *    plugin's own configuration. The form is the Host's own
 *    settings form (`ctx.configForms`, the same service the shipped configuration
 *    pages use) for the `throttle` entry, and the registration is gated with
 *    `whileServed` so a composition without `dsh-settings` shows no page at all
 *    rather than a page nothing would accept.
 *
 * What the form says about *how* an edit takes effect is copy, not mechanism:
 * the write path is `dsh-settings` → `dsh-config-editor` → the profile's
 * `cordis.patch.yml` → the Loader's volatile update, with no remount and no
 * restart.
 *
 * Styling: only `--dsw-*` theme tokens and Host primitives, so both surfaces
 * follow light/dark and never read as a bolted-on page. `require` resolves
 * against the shell's frozen static module table — React and
 * `@deepseek-ai/dsh-client-ui-primitives` are both baseline entries — so
 * nothing has to be declared under `dsh.client.external`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-throttle',
  factory (require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** This bundle's locale namespace. */
    const NS = 'dshThrottle'

    /** The three tiers, in the order the receipt prefixes walk them. */
    const TIERS = ['default', 'deep', 'free']

    /** Receipt glyphs, identical to the `/throttle` receipts the Host prints. */
    const GLYPH = { default: '🍃', deep: '⚡', free: '♾️' }

    /** The argument each tier is entered with. */
    const ENTER = { default: 'tight', deep: 'wide', free: 'open' }

    /** Shallow style helpers: theme tokens only, no stylesheet is injected. */
    const note = { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' }
    const stack = { display: 'flex', flexDirection: 'column', gap: 4 }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const blockTitle = { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
    const grid = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 12, lineHeight: '18px', margin: '2px 0 0' }
    const gridKey = { color: 'var(--dsw-alias-label-tertiary)' }
    const gridValue = { color: 'var(--dsw-alias-label-primary)' }
    const errorText = { margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }
    const okText = { margin: 0, color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 }
    const list = { margin: 0, paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '19px' }
    const paragraph = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '19px' }
    const introName = { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 12, fontWeight: 500, lineHeight: '18px' }
    const introBlock = { display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 12, borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }

    /**
     * One ceiling as a line. The Host publishes `null` for the tiers with no
     * ceiling, because JSON cannot carry `Infinity`.
     * @param t - the namespace translator.
     * @param tier - one `tiers[mode]` entry, or `undefined` before the first frame.
     * @returns the budget line.
     */
    function budgetText (t, tier) {
      if (tier === undefined || tier === null) return t('budget.unknown')
      if (tier.kind === 'unlimited') return t('budget.unlimited')
      return t('budget.steps', {
        max: String(tier.max),
        minutes: String(tier.minutes)
      })
    }

    /**
     * The reasoning level a tier pins, as a line.
     * @param t - the namespace translator.
     * @param tier - one `tiers[mode]` entry.
     * @returns the effort line.
     */
    function effortText (t, tier) {
      const effort = tier === undefined || tier === null ? null : tier.effort
      return effort === null || effort === undefined ? t('effort.none') : effort
    }

    /**
     * Execute one `/throttle` line for one session.
     * @param commands - the generated `remote.commands` face.
     * @param sessionId - the session the chip belongs to.
     * @param argument - `tight`, `wide`, or `open`.
     * @returns a failure message, or `null` on success.
     */
    async function runThrottle (commands, sessionId, argument) {
      const result = await commands.execute(sessionId, `/throttle ${argument}`, [])
      if (!result.ok) return `${result.error.message} (${result.error.code})`
      if (result.value === undefined) return `/throttle ${argument}: no such command`
      return null
    }

    /**
     * The tier chip: the current tier, its ceiling, and the switching panel.
     *
     * Renders nothing until the projection's first frame, so it never asserts a
     * tier the Host has not published.
     *
     * @param props - standard kit plus the injected verbs.
     * @returns the chip, or `null`.
     */
    function TierChip (props) {
      const { t, useProjection, changeTier, configure } = props
      const view = useProjection('throttleMode')
      const [open, setOpen] = React.useState(false)
      if (view === undefined) return null
      const mode = view.mode
      const label = t(`tier.${mode}.name`)
      return h(React.Fragment, null,
        h(primitives.Tooltip, {
          label: t('chip.tooltip', { tier: label, budget: budgetText(t, (view.tiers ?? {})[mode]) }),
          // The chip sits in the composer bar at the bottom of the window, so its
          // tooltip has to open upwards — the same side the model selector's uses.
          side: 'top',
          delayMs: 300,
          maxWidth: 320,
          portal: true
        },
        h(primitives.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => { setOpen(true) },
          'aria-label': t('chip.aria', { tier: label })
        },
        h('span', { 'aria-hidden': true, style: { fontSize: 13, lineHeight: '1' } }, GLYPH[mode]),
        h('span', { style: { fontSize: 12 } }, t(`tier.${mode}.short`)))),
        open
          ? h(TierPanel, { t, view, mode, changeTier, configure, onClose: () => { setOpen(false) } })
          : null)
    }

    /**
     * How long the panel waits for the Host to answer a switch before it lets go.
     *
     * The command handler is synchronous and the channel is local, so an answer
     * normally lands in milliseconds. This is only the backstop: without it, a
     * request that never reaches the Host leaves a modal — over the whole app —
     * with its switch disabled and nothing saying why.
     */
    const ANSWER_DEADLINE_MS = 5000

    /**
     * Render an unknown thrown value as a printable message.
     * @param error - the caught value.
     * @returns the message.
     */
    function messageOf (error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * The switching panel: every tier, what it does, its ceiling, and the exact
     * command it stands for.
     *
     * Every way out of "the switch is disabled while a request is outstanding" is
     * covered, because a modal that cannot be released is worse than a switch
     * that failed: a synchronous throw reports itself instead of stranding the
     * latch, the Host's own projection is the real done signal (it folds
     * `command/run` / `command/done`, so a reply lost in transit still releases
     * it), and a deadline catches a request that never arrived at all.
     *
     * @param props - the copy, the projection value, and the panel's verbs.
     * @returns the modal.
     */
    function TierPanel (props) {
      const { t, view, mode, changeTier, configure, onClose } = props
      const [asking, setAsking] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const alive = React.useRef(true)
      const deadline = React.useRef(null)
      const tiers = view.tiers ?? {}
      /** A throttle command the Host has recorded and not yet settled. */
      const running = view.running === true
      const busy = asking || running

      /** Let go of the outstanding switch, whichever way it ends. */
      const release = () => {
        if (deadline.current !== null) {
          clearTimeout(deadline.current)
          deadline.current = null
        }
        if (alive.current) setAsking(false)
      }

      React.useEffect(() => () => {
        alive.current = false
        release()
      }, [])

      // A new frame from the projection means the command did reach the Host and
      // the log moved, so the panel is usable again whatever the reply did.
      React.useEffect(() => {
        if (asking) release()
      }, [mode, running])

      const switchTo = (next) => {
        if (busy || next === mode) return
        setFailure(null)
        // Build the request *before* disabling anything: a synchronous throw then
        // reports itself instead of leaving the switch greyed out forever.
        let pending
        try {
          pending = Promise.resolve(changeTier(ENTER[next]))
        } catch (error) {
          setFailure(messageOf(error))
          return
        }
        setAsking(true)
        const settle = (message) => {
          release()
          if (message !== null && message !== undefined) setFailure(message)
        }
        pending.then(settle, (reason) => { settle(messageOf(reason)) })
        deadline.current = setTimeout(() => {
          deadline.current = null
          if (!alive.current) return
          setAsking(false)
          setFailure(t('panel.noAnswer', { seconds: String(ANSWER_DEADLINE_MS / 1000) }))
        }, ANSWER_DEADLINE_MS)
      }
      const facts = [
        [t('panel.budget'), budgetText(t, tiers[mode])],
        [t('panel.effort'), effortText(t, tiers[mode])],
        [t('panel.permission'), t(`tier.${mode}.permission`)],
        [t('panel.command'), mode === 'default'
          ? t('panel.command.toggle', { command: `/throttle ${ENTER[mode]}` })
          : `/throttle ${ENTER[mode]}`]
      ]
      const footer = []
      if (configure !== undefined) {
        footer.push(h(primitives.Button, {
          key: 'configure',
          variant: 'outline',
          size: 'sm',
          onClick: () => { configure() }
        }, t('panel.configure')))
      }
      footer.push(h(primitives.Button, {
        key: 'close',
        variant: 'primary',
        size: 'sm',
        onClick: onClose
      }, t('panel.close')))
      return h(primitives.Modal, {
        open: true,
        onClose,
        title: t('panel.title'),
        description: t('panel.description'),
        closeLabel: t('panel.close'),
        footer: h('div', { style: row }, footer)
      },
      h('div', { style: stack },
        h(primitives.SegmentedControl, {
          id: 'dsh-throttle-tier',
          value: mode,
          label: t('panel.tierLabel'),
          disabled: busy,
          options: TIERS.map((id) => ({
            value: id,
            label: t(`tier.${id}.short`),
            title: `${t(`tier.${id}.name`)} — ${t(`tier.${id}.position`)}`
          })),
          onChange: (next) => { switchTo(next) }
        }),
        h('div', { style: { ...stack, marginTop: 8 } },
          h('span', { style: blockTitle }, t(`tier.${mode}.name`)),
          h('p', { style: note }, t(`tier.${mode}.position`))),
        h('div', { style: grid }, facts.flatMap(([key, value]) => [
          h('span', { key: `${key}-k`, style: gridKey }, key),
          h('span', { key: `${key}-v`, style: gridValue }, value)
        ])),
        busy ? h('p', { style: { ...note, marginTop: 8 } }, t('panel.switching')) : null,
        failure === null ? null : h('p', { style: errorText }, t('panel.failed', { reason: failure })),
        configure === undefined ? null : h('p', { style: { ...note, marginTop: 8 } }, t('panel.configureHint'))))
    }

    /** Field spec factories: the client-side mirror of the Host schema's bounds. */
    const specs = {
      /**
       * A whole-number field.
       * @param min - the floor the Host schema enforces as well.
       * @returns the field spec.
       */
      number: (min) => ({
        min,
        format: (value) => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          const trimmed = String(text).trim()
          if (trimmed === '') return { kind: 'clear' }
          const parsed = Number(trimmed)
          if (!Number.isFinite(parsed) || parsed < min) return undefined
          return { kind: 'set', value: parsed }
        }
      }),
      /**
       * A free-text field.
       * @returns the field spec.
       */
      text: () => ({
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => {
          const trimmed = String(text).trim()
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
        }
      })
    }

    /**
     * The two editable blocks. Each is a `config.<block>` object the Host
     * declares volatile, so writing it never remounts the plugin.
     *
     * `fallback` is the display value for a field the profile layer does not
     * carry yet: it mirrors the Host schema's default, so the form always shows
     * the numbers in force instead of empty boxes.
     */
    const BLOCKS = [
      {
        key: 'default',
        fields: [
          { path: ['default', 'steps'], spec: specs.number(1), fallback: '4' },
          { path: ['default', 'minutes'], spec: specs.number(1), fallback: '2' },
          { path: ['default', 'effort'], spec: specs.text(), fallback: 'low' },
          { path: ['default', 'permission'], spec: specs.text(), fallback: 'read-only' }
        ]
      },
      {
        key: 'deep',
        fields: [
          { path: ['deep', 'steps'], spec: specs.number(5), fallback: '5' },
          { path: ['deep', 'minutes'], spec: specs.number(5), fallback: '5' },
          { path: ['deep', 'effort'], spec: specs.text(), fallback: 'high' },
          { path: ['deep', 'permission'], spec: specs.text(), fallback: 'restore' }
        ]
      }
    ]

    /**
     * The situations the introduction names, in the order it lists them. Each one
     * is an `intro.use.<key>` entry in both dictionaries.
     */
    const INTRO_USES = ['missing', 'direction', 'review', 'cost', 'simple']

    /**
     * Read one path out of a form value.
     * @param value - the form's effective value.
     * @param path - the config path.
     * @returns the value at that path, or `undefined`.
     */
    function fieldValue (value, path) {
      let node = value
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    /**
     * Whether the user layer carries a block, i.e. a save leaves an override.
     * @param user - the form's user layer.
     * @param key - the block key.
     * @returns true when the profile patch already carries the block.
     */
    function blockOverridden (user, key) {
      return user !== null && typeof user === 'object' && user[key] !== undefined
    }

    /**
     * The bundle's configuration page: the plugin's own introduction at the top,
     * then one labelled control per editable field, each carrying what it does
     * and how a save takes effect, plus one save that writes every staged edit as
     * a single revision-fenced mutation.
     *
     * The form state comes from the Host's settings form for the `throttle` entry
     * (`ctx.configForms`), bound here through the injected `useThrottleConfig`
     * selector hook; `save` is that form's own serialized write, so the page
     * never touches the wire itself.
     *
     * @param props - `view`, the bound form snapshot, and the form's verbs.
     * @returns the summary line, or the form.
     */
    function ConfigPage (props) {
      const { t, view, useThrottleConfig, save } = props
      const [drafts, setDrafts] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      // Hooks run before any branch: the page renders as a one-liner in one host
      // view and as the full form in the other.
      const snapshot = useThrottleConfig((value) => value)
      if (view === 'summary') return h('span', null, t('cfg.summary'))

      const state = snapshot
      const value = state === undefined ? undefined : state.value
      if (state === undefined || state.status !== 'ready' || value === undefined || value === null) {
        return h('p', { style: note }, state !== undefined && state.status === 'loading' ? t('cfg.loading') : t('cfg.unavailable'))
      }
      const disabled = state.writable !== true
      const idOf = (path) => path.join('.')

      /**
       * What one control shows: the staged draft, or the Host's effective value
       * with the schema default standing in for a field the layer omits.
       */
      const readField = (field) => {
        const draft = drafts[idOf(field.path)]
        if (draft !== undefined) return draft
        return field.spec.format(fieldValue(value, field.path)) || field.fallback
      }
      /** What a save would do for one field: nothing, an op, or a rejected draft. */
      const planField = (field) => {
        const draft = drafts[idOf(field.path)]
        if (draft === undefined) return { dirty: false, invalid: false, op: undefined }
        const parsed = field.spec.parse(draft)
        if (parsed === undefined) return { dirty: true, invalid: true, op: undefined }
        if (parsed.kind === 'clear') {
          const stored = field.spec.format(fieldValue(value, field.path))
          if (stored === '') return { dirty: true, invalid: false, op: undefined }
          return { dirty: true, invalid: false, op: { op: 'unset', path: field.path } }
        }
        return { dirty: true, invalid: false, op: { op: 'set', path: field.path, value: parsed.value } }
      }
      const plans = new Map()
      for (const block of BLOCKS) for (const field of block.fields) plans.set(idOf(field.path), planField(field))
      const ops = []
      let invalid = false
      for (const plan of plans.values()) {
        if (plan.invalid) invalid = true
        if (plan.op !== undefined) ops.push(plan.op)
      }

      /**
       * What one control currently shows, as a number.
       * @param path - the config path.
       * @returns the staged or effective value, or NaN.
       */
      const numberAt = (path) => {
        const field = BLOCKS.flatMap((block) => block.fields).find((candidate) => idOf(candidate.path) === idOf(path))
        return Number(readField(field))
      }
      /**
       * The Tight/Wide ordering rule, which no single field's schema can state:
       * the Host refuses a Wide ceiling at or below the Tight one and falls back
       * to its built-in numbers, so the form must not let that pair land in the
       * profile patch. Without this the save succeeds and the values are
       * silently not the ones in force.
       */
      const outOfOrder = numberAt(['default', 'steps']) >= numberAt(['deep', 'steps'])

      const edit = (field, text) => {
        setSaved(false)
        setDrafts({ ...drafts, [idOf(field.path)]: text })
      }
      const discard = (field) => {
        setSaved(false)
        const next = { ...drafts }
        delete next[idOf(field.path)]
        setDrafts(next)
      }
      /** Write one batch of ops, keeping the drafts when the Host refuses. */
      const write = async (batch) => {
        if (saving || disabled || batch.length === 0) return
        setSaving(true)
        setFailure(null)
        setSaved(false)
        try {
          const ok = await save(batch, state.revision)
          if (ok) {
            setDrafts({})
            setSaved(true)
          } else setFailure(t('cfg.saveFailed'))
        } catch (reason) {
          setFailure(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setSaving(false)
        }
      }

      return h('div', { style: stack },
        h('section', { key: 'intro', style: introBlock },
          h('span', { style: blockTitle }, t('intro.title')),
          h('p', { style: introName }, t('intro.name')),
          h('p', { style: paragraph }, t('intro.lead')),
          h('p', { style: paragraph }, t('intro.mechanism')),
          h('p', { style: paragraph }, t('intro.rationale')),
          h('p', { style: paragraph }, t('intro.uses')),
          h('ul', { style: list }, ...INTRO_USES.map((key) => h('li', { key }, t(`intro.use.${key}`)))),
          h('p', { style: paragraph }, t('intro.goal')),
          h('p', { style: note }, t('intro.usage'))),
        h('p', { style: { ...note, marginTop: 12 } }, t('cfg.intro')),
        ...BLOCKS.map((block) => h('section', { key: block.key, style: { ...stack, marginTop: 12 } },
          h('div', { style: row },
            h('span', { style: blockTitle }, t(`cfg.${block.key}.title`)),
            blockOverridden(state.user, block.key)
              ? h(primitives.Tag, { tone: 'neutral' }, t('cfg.overridden'))
              : h(primitives.Tag, { tone: 'quiet' }, t('cfg.inherited')),
            h(primitives.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled,
              onClick: () => { write([{ op: 'unset', path: [block.key] }]) }
            }, t('cfg.reset'))),
          h('p', { style: note }, t(`cfg.${block.key}.note`)),
          ...block.fields.map((field) => {
            const plan = plans.get(idOf(field.path))
            return h(primitives.SettingsValueField, {
              key: idOf(field.path),
              id: `dsh-throttle-${idOf(field.path).replace(/\./g, '-')}`,
              label: t(`cfg.${idOf(field.path)}.label`),
              hint: t(`cfg.${idOf(field.path)}.hint`),
              help: { label: t('cfg.help'), content: t(`cfg.${idOf(field.path)}.help`) },
              numeric: field.spec.min !== undefined,
              text: readField(field),
              disabled,
              invalid: plan.invalid,
              invalidLabel: t('cfg.invalid', { min: String(field.spec.min ?? 1) }),
              overridden: plan.dirty,
              overriddenLabel: t('cfg.pending'),
              resetLabel: t('cfg.discard'),
              onEdit: (text) => { edit(field, text) },
              onReset: () => { discard(field) }
            })
          }))),
        h('div', { style: { ...row, marginTop: 16 } },
          h(primitives.Button, {
            variant: 'primary',
            size: 'sm',
            disabled: disabled || saving || invalid || outOfOrder || ops.length === 0,
            onClick: () => { write(ops) }
          }, saving ? t('cfg.saving') : t('cfg.save')),
          saved ? h('span', { style: okText }, t('cfg.saved')) : null,
          disabled ? h('span', { style: note }, t('cfg.readOnly')) : null),
        outOfOrder
          ? h('p', { style: errorText }, t('cfg.outOfOrder', { tight: String(numberAt(['default', 'steps'])), wide: String(numberAt(['deep', 'steps'])) }))
          : null,
        failure === null ? null : h('p', { style: errorText }, failure),
        h('div', { style: { ...stack, marginTop: 16 } },
          h('span', { style: blockTitle }, t('cfg.howto.title')),
          h('ul', { style: list },
            ...['scope', 'round', 'effort', 'floor', 'restore', 'yaml'].map((key) =>
              h('li', { key }, t(`cfg.howto.${key}`))))))
    }

       /**
     * en dictionary — the source of truth for the key set.
     *
     * Every key here must exist in `zh` too: `zh` is a translation of this
     * dictionary, never the origin of a string. Text that has no localization
     * channel at all (the Host-side command copy, the receipts, the model-facing
     * prompt and context) is English in the plugin's own source.
     */
    const en = {
      'chip.aria': 'Throttle tier: {tier}. Open the tier and ceiling panel.',
      'chip.tooltip': '{tier} · {budget} — click to review or switch tiers',
      'tier.default.name': 'Tight tier',
      'tier.default.short': 'Tight',
      'tier.default.position': 'Everyday questions: cheapest reasoning, view-only, tightest ceiling.',
      'tier.default.permission': 'view-only (read-only), written by this plugin',
      'tier.deep.name': 'Wide tier',
      'tier.deep.short': 'Wide',
      'tier.deep.position': 'Real work: writing and reasoning widen, but the ceiling is hard — at the limit the model hands back.',
      'tier.deep.permission': 'the session’s own preset restored (writable)',
      'tier.free.name': 'Open tier',
      'tier.free.short': 'Open',
      'tier.free.position': 'The throttle wide open: no ceiling, no reasoning override, permissions left to the session.',
      'tier.free.permission': 'the session’s own preset, left alone',
      'budget.steps': '≤{max} steps · ≤{minutes} min',
      'budget.unlimited': 'no ceiling, no clock',
      'budget.unknown': 'reading the ceiling…',
      'effort.none': 'not sent (the session keeps its own level)',
      'panel.title': 'Throttle tiers',
      'panel.description': 'Switching runs the matching /throttle command and leaves one receipt line in the conversation.',
      'panel.tierLabel': 'Current tier',
      'panel.budget': 'Per-turn ceiling',
      'panel.effort': 'Reasoning level',
      'panel.permission': 'Permissions',
      'panel.command': 'Same as',
      'panel.command.toggle': '{command} (a bare /throttle toggles Tight ⇄ Wide)',
      'panel.switching': 'Switching…',
      'panel.failed': 'Switch failed: {reason}',
      'panel.noAnswer': 'The switch never reached the Host ({seconds}s without an answer). Reload the page and try again, or type /throttle in the composer.',
      'panel.noCommands': 'This deployment serves no command channel; type /throttle in the composer instead.',
      'panel.configure': 'Edit the ceilings…',
      'panel.configureHint': 'The ceilings sit on the dsh-throttle card of the Plugins page, between its description and its rows.',
      'panel.close': 'Close',
      'intro.title': 'About',
      'intro.name': 'dsh-throttle',
      'intro.lead': 'A throttling layer for DSH that limits excessive deep exploration through configurable operating levels.',
      'intro.mechanism': 'It enforces limits on execution steps and runtime for each turn. Once a limit is reached, DSH is forced to stop expanding its reasoning and return the current findings, unresolved questions, and suggested next steps.',
      'intro.rationale': 'This creates more frequent checkpoints for summarization and user interaction, making it easier to provide missing details, correct the direction, review intermediate results, or abandon an unproductive path before the agent continues too far.',
      'intro.uses': 'Useful for:',
      'intro.use.missing': 'Filling in missing details before continuing',
      'intro.use.direction': 'Adjusting direction during a task',
      'intro.use.review': 'Reviewing intermediate conclusions',
      'intro.use.cost': 'Stopping early when time or cost becomes excessive',
      'intro.use.simple': 'Preventing simple requests from turning into endless deep exploration',
      'intro.goal': 'The goal is not to reduce DSH’s capability, but to keep its exploration bounded and make complex tasks progress through shorter, more controllable stages.',
      'intro.usage': 'How to use it: switch tiers from the chip beside the model selector (or type /throttle); the ceilings are edited in the form below.',
      'cfg.summary': 'The three tiers, with each one’s per-turn ceiling, reasoning level, and permissions.',
      'cfg.intro': 'These two groups are every ceiling the two bounded tiers have. Save writes them into this profile’s cordis.patch.yml; the plugin is not restarted and the change is live.',
      'cfg.help': 'What this option does',
      'cfg.overridden': 'Overridden',
      'cfg.inherited': 'Built-in default',
      'cfg.pending': 'Unsaved',
      'cfg.discard': 'Discard',
      'cfg.reset': 'Reset to default',
      'cfg.save': 'Save',
      'cfg.saving': 'Saving…',
      'cfg.saved': 'Applied',
      'cfg.loading': 'Reading the current configuration…',
      'cfg.saveFailed': 'The deployment did not accept these values; your edits were kept.',
      'cfg.invalid': 'Enter a number of at least {min}.',
      'cfg.outOfOrder': 'The Wide tier’s steps ({wide}) must be above the Tight tier’s ({tight}). The Host refuses this pair and falls back to its built-in numbers, so this save is blocked here instead.',
      'cfg.readOnly': 'This deployment stores settings read-only.',
      'cfg.unavailable': 'This deployment serves no plugin settings form; edit the profile’s cordis.patch.yml instead.',
      'cfg.default.title': 'Tight tier (what a session starts in)',
      'cfg.default.note': 'New sessions and every session that has run no /throttle of its own: view-only, cheapest reasoning, tightest ceiling. A session started by subagent follows the tier of the session that started it, so it is Tight exactly while that session is.',
      'cfg.deep.title': 'Wide tier (opened by /throttle)',
      'cfg.deep.note': 'Writing and reasoning widen, but the ceiling still holds: past it, the step that follows gets no tools and the model must hand back in the fixed format.',
      'cfg.default.steps.label': 'Steps per turn',
      'cfg.default.steps.hint': 'How many steps one turn may take, from 1; it must stay below the Wide tier’s steps.',
      'cfg.default.steps.help': 'The Tight tier counts steps, not tool calls: one step is one model response, so several tools called in parallel inside one step still cost exactly one. Past the ceiling the over-limit step’s tool calls are refused, the refusal names the dsh-throttle tier as the reason, and the model is told to hand back in the fixed format (what I found / what needs your confirmation / what I went with by default / how you can verify) instead of retrying. One closing step without tool calls is what lets the model still write that hand-back.',
      'cfg.default.minutes.label': 'Minutes per turn',
      'cfg.default.minutes.hint': 'The wall-clock ceiling of one turn, from 1.',
      'cfg.default.minutes.help': 'Counted from this turn’s start to the current step, so waiting for an approval or a download inside a turn counts, while sitting idle between two turns does not (that was the rev.3.1 fix: 88 idle minutes are no longer charged to the next turn).',
      'cfg.default.effort.label': 'Reasoning level',
      'cfg.default.effort.hint': 'Defaults to low; must be a level the current model declares (low / high here).',
      'cfg.default.effort.help': 'The Tight tier pins every request’s reasoning level to this value. It must be a level the model really advertises, otherwise the plugin sends none (the model keeps its own default) rather than failing the turn. This gateway rejects “thinking off”, so this is the cheapest level it accepts instead of none.',
      'cfg.default.permission.label': 'Permission preset',
      'cfg.default.permission.hint': 'Defaults to read-only.',
      'cfg.default.permission.help': 'The Tight tier re-asserts this preset before every step, so changing the session’s preset by hand is corrected back to read-only — that is what this tier means. To write files, switch to the Wide or Open tier instead of editing this option.',
      'cfg.deep.steps.label': 'Steps per turn',
      'cfg.deep.steps.hint': 'Minimum 5, and it must exceed the Tight tier’s steps; anything smaller is refused.',
      'cfg.deep.steps.help': 'The Wide tier counts steps the same way, only further out. The floor of 5 is hard, and the Host also refuses a Wide ceiling that is not above the Tight tier’s — a “Wide” tier no wider than Tight is a misconfiguration, not a preference. A spent ceiling still allows one final step without tool calls, so the model can read what it just found.',
      'cfg.deep.minutes.label': 'Minutes per turn',
      'cfg.deep.minutes.hint': 'Minimum 5; anything smaller is refused.',
      'cfg.deep.minutes.help': 'The same wall-clock rule as the Tight tier with a wider ceiling — and still a hard one: at the limit the model must hand back.',
      'cfg.deep.effort.label': 'Reasoning level',
      'cfg.deep.effort.hint': 'Defaults to high; must be a level the current model declares.',
      'cfg.deep.effort.help': 'The reasoning level the Wide tier sends. A level the model does not advertise is skipped (nothing is sent), so a typo costs the setting rather than the turn.',
      'cfg.deep.permission.label': 'Permissions',
      'cfg.deep.permission.hint': 'Defaults to restore (the session’s own preset).',
      'cfg.deep.permission.help': 'restore brings back whatever preset the session held before it entered this tier (recommended). You may name a preset instead, for example workspace-write or danger-full-access. Read-only is never a restore target: a session pinned read-only here could never write again.',
      'cfg.howto.title': 'How a change takes effect',
      'cfg.howto.scope': 'Save writes both blocks into this profile’s cordis.patch.yml (only the fields that can change live) and the Loader updates the plugin’s config references in place — no plugin restart, no page reload.',
      'cfg.howto.round': 'The turn already running keeps the old ceilings; the next turn starts from the new numbers. Switching tiers runs /throttle…, which republishes the chip beside the model selector immediately.',
      'cfg.howto.effort': 'A reasoning level must be one the current model declares (low / high here; see the profile’s llm-pi-ai row). An unknown level means “send none” rather than an error.',
      'cfg.howto.floor': 'The Wide tier’s step and minute floors are 5, and its step ceiling must be above the Tight tier’s: a value that breaks either rule is refused by the Host instead of being quietly accepted.',
      'cfg.howto.restore': '“Reset to default” returns that block to the built-in defaults (Tight tier 4 steps / 2 minutes / low / read-only; Wide tier 5 steps / 5 minutes / high / restore).',
      'cfg.howto.yaml': 'This page is not the only entry point: editing the entry’s config in the profile’s cordis.patch.yml works too, but a hand-edited ordinary field needs a Harness restart to take effect.'
    }

    /** zh dictionary — a translation kept in step with the source key set. */
    const zh = {
      'chip.aria': '节流档位：{tier}。打开档位与额度面板。',
      'chip.tooltip': '{tier} · {budget} — 点击查看与切换档位',
      'tier.default.name': '收紧档',
      'tier.default.short': '收紧',
      'tier.default.position': '日常问答：思考压到最低档、只读不写，额度最紧。',
      'tier.default.permission': '仅可查看（read-only），由本插件写入',
      'tier.deep.name': '放宽档',
      'tier.deep.short': '放宽',
      'tier.deep.position': '正经干活：可写、思考放开，但额度是硬上限 —— 到点模型必须收手交回。',
      'tier.deep.permission': '恢复该会话自己的预设（可写）',
      'tier.free.name': '放开档',
      'tier.free.short': '放开',
      'tier.free.position': '节流全开：不限额、不下发思考等级、权限交回会话自己。',
      'tier.free.permission': '恢复会话自己的预设，且不再干预',
      'budget.steps': '≤{max} 步 · ≤{minutes} 分钟',
      'budget.unlimited': '不限额 · 不限时',
      'budget.unknown': '额度读取中…',
      'effort.none': '不下发（保持会话自己的等级）',
      'panel.title': '节流档位',
      'panel.description': '切换会执行对应的 /throttle 命令，并在对话里留一行回执。',
      'panel.tierLabel': '当前档位',
      'panel.budget': '每轮额度',
      'panel.effort': '思考等级',
      'panel.permission': '权限',
      'panel.command': '等价命令',
      'panel.command.toggle': '{command}（裸 /throttle 在收紧 ⇄ 放宽之间互切）',
      'panel.switching': '切换中…',
      'panel.failed': '切换失败：{reason}',
      'panel.noAnswer': '这次切换没有送到 Host（{seconds} 秒没有回音）。刷新页面后重试，或直接在输入框里打 /throttle。',
      'panel.noCommands': '这个部署没有提供命令通道，请直接在输入框里打 /throttle。',
      'panel.configure': '配置额度…',
      'panel.configureHint': '额度就在 Plugins 页 → dsh-throttle 卡片上（描述与插件行之间）。',
      'panel.close': '关闭',
      'intro.title': '简介',
      'intro.name': 'dsh-throttle（DSH 节流器）',
      'intro.lead': '通过不同档位，对 DSH 的深度探索进行强制节流。',
      'intro.mechanism': '插件会限制单轮任务的执行步数与持续时间，在达到上限后强制 DSH 停止继续扩散式思考，并返回当前结论、待确认信息与下一步建议。',
      'intro.rationale': '这样可以增加任务过程中的总结与用户交互频率，避免 Agent 在信息不足、方向未确认或任务已经偏移时仍持续探索。',
      'intro.uses': '适合用于：',
      'intro.use.missing': '补充缺失细节后再继续',
      'intro.use.direction': '中途调整任务方向',
      'intro.use.review': '检查当前结论是否符合预期',
      'intro.use.cost': '在成本或时间过高时提前结束',
      'intro.use.simple': '防止简单问题演变成没完没了的深度探索',
      'intro.goal': '核心目标不是降低 DSH 的能力，而是限制它一次性探索过深，让复杂任务以更短、更可控的阶段逐步推进。',
      'intro.usage': '用法：点模型选择器旁边的档位徽章切档（或直接输入 /throttle），额度在下面的表单里改。',
      'cfg.summary': '三档档位，以及每轮的额度、思考等级与权限。',
      'cfg.intro': '下面两组数字就是两个「有限档」的全部额度。改完点「保存」：写入本 profile 的 cordis.patch.yml，插件不重启、立即生效。',
      'cfg.help': '这一项的作用',
      'cfg.overridden': '已覆盖',
      'cfg.inherited': '内置默认',
      'cfg.pending': '待保存',
      'cfg.discard': '撤销',
      'cfg.reset': '恢复默认',
      'cfg.save': '保存',
      'cfg.saving': '保存中…',
      'cfg.saved': '已生效',
      'cfg.loading': '正在读取当前配置…',
      'cfg.saveFailed': '这个部署没有接受这些值，已保留你的修改。',
      'cfg.invalid': '请填不小于 {min} 的数字。',
      'cfg.outOfOrder': '放宽档步数（{wide}）必须大于收紧档步数（{tight}）。Host 会拒绝这种组合并回落到内置默认值，所以这里直接拦住这次保存。',
      'cfg.readOnly': '本部署的设置为只读。',
      'cfg.unavailable': '这个部署没有提供插件设置表单，请直接编辑 profile 的 cordis.patch.yml。',
      'cfg.default.title': '收紧档（会话开机默认就是这一档）',
      'cfg.default.note': '新会话，以及自己没打过 /throttle 的会话都在这一档：只读、思考最低、额度最紧。由 subagent 启动的子会话跟随启动它的那个会话的档位——所以只有那个会话在收紧档时，子会话才在收紧档。',
      'cfg.deep.title': '放宽档（/throttle 打开）',
      'cfg.deep.note': '放开写与思考，但额度仍是硬上限；额度一到，超限那一步的工具调用会被拒绝，并要求按固定格式交回。',
      'cfg.default.steps.label': '每轮步数上限',
      'cfg.default.steps.hint': '一轮之内允许走几步，1 起；必须小于放宽档的步数。',
      'cfg.default.steps.help': '收紧档数的是「步」而不是「工具调用」：一步 = 模型的一次回复，所以同一步里并行调多个工具仍然只算一步。到顶后，超限那一步的工具调用会被拒绝，拒绝文本点名 dsh-throttle 的档位限制，并要求模型按固定格式交回（当前结论 / 需要你确认 / 我先按默认走了 / 你可以这样验证），而不是继续重试。收尾那一步不调工具，模型还能把结论写完。',
      'cfg.default.minutes.label': '每轮时间上限（分钟）',
      'cfg.default.minutes.hint': '一轮的墙钟时长上限，1 起。',
      'cfg.default.minutes.help': '从本轮 turn/start 起算到当前步，所以一轮之内等批准、等下载都算时间；两轮之间的挂机不算（rev.3.1 修的正是这条：挂机 88 分钟不会再被记到新一轮头上）。',
      'cfg.default.effort.label': '思考等级',
      'cfg.default.effort.hint': '默认 low；必须是当前模型声明过的等级（本部署是 low / high）。',
      'cfg.default.effort.help': '收紧档把每个请求的思考等级压到这个值。它必须是模型真实声明过的等级，否则插件会跳过下发（等于保持模型自己的默认），而不会把这一轮搞挂。该网关不接受「关掉思考」，所以这里是网关照收的最低档，而不是 none。',
      'cfg.default.permission.label': '权限预设',
      'cfg.default.permission.hint': '默认 read-only（仅可查看）。',
      'cfg.default.permission.help': '收紧档每一步都会把会话的权限预设幂等校正到这个值，所以手动改成可写也会被纠正回只读 —— 这就是收紧档的定义。要写文件请切放宽档或放开档，不要改这一项。',
      'cfg.deep.steps.label': '每轮步数上限',
      'cfg.deep.steps.hint': '最小 5，且必须大于收紧档的步数；写更小会被拒绝。',
      'cfg.deep.steps.help': '放宽档同样按步计数，只是放得更远。下限 5 是硬底线，且 Host 还会拒绝「不比收紧档更宽」的放宽档 —— 那属于配置错误而不是偏好。额度用尽后仍允许一步不调工具的收尾，否则模型看不到自己刚拿到的结果。',
      'cfg.deep.minutes.label': '每轮时间上限（分钟）',
      'cfg.deep.minutes.hint': '最小 5；写更小会被拒绝。',
      'cfg.deep.minutes.help': '与收紧档同一条墙钟规则，只是上限更大；同样是硬上限，到点必须收手交回。',
      'cfg.deep.effort.label': '思考等级',
      'cfg.deep.effort.hint': '默认 high；必须是当前模型声明过的等级。',
      'cfg.deep.effort.help': '放宽档下发的思考等级。模型没声明过的等级会被跳过（等于不下发），所以写错只会让这一项不生效，不会把这一轮搞挂。',
      'cfg.deep.permission.label': '权限',
      'cfg.deep.permission.hint': '默认 restore（恢复该会话自己的预设）。',
      'cfg.deep.permission.help': 'restore = 恢复该会话进入本档之前自己的预设（推荐）。也可以直接写一个预设名，例如 workspace-write 或 danger-full-access。注意「只读」永远不会成为恢复目标：否则一个会话在这里变成只读之后就再也回不到可写。',
      'cfg.howto.title': '改完怎么生效',
      'cfg.howto.scope': '保存会把这两个块整段写进本 profile 的 cordis.patch.yml（只替换这几个可实时生效的字段），再由 Loader 原地更新插件的配置引用 —— 插件不重启、页面不刷新。',
      'cfg.howto.round': '正在进行的这一轮继续沿用旧额度；下一轮从新数字开始算。切换档位（/throttle…）会立刻重算并刷新模型选择器旁边的徽章。',
      'cfg.howto.effort': '思考等级必须是当前模型声明过的等级（本部署是 low / high，见 profile 的 llm-pi-ai 行）。写一个模型不认的等级 = 不下发，不会报错。',
      'cfg.howto.floor': '放宽档的步数与分钟下限是 5，且步数必须大于收紧档：违反任一条都会被 Host 直接拒绝，不会静默放行。',
      'cfg.howto.restore': '「恢复默认」把该块退回内置默认值（收紧档 4 步 / 2 分钟 / low / read-only；放宽档 5 步 / 5 分钟 / high / restore）。',
      'cfg.howto.yaml': '这个页面不是唯一入口：直接改 profile 的 cordis.patch.yml 里该行的 config 也可以，但手工改的普通字段要重启 Harness 才生效。'
    }

    /**
     * Required Client services.
     *
     * `remote.commands` is a service in its own right, not a field of `remote`:
     * the Cordis guard throws **synchronously** — "cannot get property
     * \"remote.commands\" without inject" — the moment the property is read, so a
     * missing declaration here does not fail the plugin at load; it fails the
     * switch on the first click. First-party UI plugins declare every remote
     * namespace they touch the same way (`dsh-client-ui-plan` lists both `remote`
     * and `remote.commands`).
     */
    const inject = ['slots', 'locale', 'remote', 'remote.commands']

    /**
     * Mount both surfaces.
     *
     * `ctx.slots.inject` handles a late declaration and its collapse, so neither
     * registration has to guess when the owning panel mounts. The switch rides
     * the entry's inject face, because the command has to be addressed to the
     * session the chip is rendered for.
     *
     * The configuration page lives behind `configForms`, the settings domain's
     * client service: without it (no `ui-settings` in the composition) the chip
     * still works and the page simply does not exist. Inside that scope,
     * `whileServed` keeps the page alive only while the Host actually serves the
     * `throttle` entry's settings namespace, which is the honest condition for
     * "there is something to edit".
     *
     * @param ctx - the browser plugin context.
     */
    function apply (ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-throttle: dictionaries')
      const navigation = ctx.get('pluginNavigation')
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'throttle-tier',
        order: 20,
        locale: NS,
        inject: (sessionId) => ({
          changeTier: (argument) => {
            // The command namespace is a generated Remote surface: a deployment
            // that composed no session controller has none, and a chip that
            // reported a tier it could not change would be worse than one that
            // says why it cannot.
            const commands = ctx.remote === undefined ? undefined : ctx.remote.commands
            if (commands === undefined) return Promise.resolve(t('panel.noCommands'))
            return runThrottle(commands, sessionId, argument)
          },
          ...(navigation === undefined ? {} : { configure: () => { navigation.openBundle('dsh-throttle') } })
        })
      }, TierChip))
      ctx.inject(['configForms'], (configCtx) => {
        const scope = configCtx.configForms.get('throttle')
        configCtx.effect(() => configCtx.configForms.whileServed(['throttle'], () => configCtx.slots.inject('plugins.bundle.config', () => configCtx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-throttle',
          id: 'dsh-throttle',
          locale: NS,
          inject: () => ({
            hooks: { throttleConfig: scope },
            save: (ops, revision) => scope.mutate(ops, revision)
          })
        }, ConfigPage))), 'dsh-throttle: configuration page')
      })
    }

    return { inject, apply }
  }
})
