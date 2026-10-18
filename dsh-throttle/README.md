# dsh-throttle — the `/throttle` three-tier boundary control

One session, three positions on one throttle. The plugin's job is to **contract a
session's boundaries**: how much reasoning it may spend, how many steps one turn
may use, how long a turn may run, and what the file policy is allowed to be.

| | **Tight** (what a session starts in) | **Wide** (`/throttle`) | **Open** (`/throttle open`) |
|---|---|---|---|
| Reasoning | cheapest level the model declares (default `low`) | the configured level (default `high`) | **not sent** (the session/model selector keeps its own) |
| Per-turn ceiling | ≤4 steps / ≤2 min | ≤5 steps / ≤5 min | **none** (and nothing is counted) |
| Permissions | view-only (`read-only`), asserted by this plugin | the session's own preset, restored | the session's own preset, left alone |
| Position | everyday questions, cheap and bounded | real work, still hard-bounded | **as if the plugin were not installed** |

When a ceiling is reached the model must stop and hand back in the fixed format
(see `../PLAN-throttle-mode.md` section 2) instead of retrying.

> **About "no thinking"**: this gateway rejects `reasoning_effort: none`, and a
> level the model never declares does not exist to select. So the Tight tier sends
> the **cheapest level the gateway accepts** (`low`) rather than trying to switch
> thinking off. The only position that truly does not constrain thinking is Open,
> which sends no level at all.

> **Upgrading from `dsh-power`**: this plugin was called `dsh-power` and its
> command was `/power`. The package name, plugin id, bundle row id, slash command,
> projection key (`throttleMode`) and the two model-facing channels
> (`throttle:policy`, `throttle:state`) all moved. The tier **ids** stayed
> `default` / `deep` / `free`, so a profile patch's config block keys are
> unchanged — but a session whose log recorded `/power …` no longer folds, and
> resumes in the Tight tier.

## The interfaces (what you see inside the Harness UI)

Both surfaces are drawn inside the Harness's own UI. Nothing here is an external
page.

### 1. The tier chip beside the model selector

In the composer bar, in the trailing group immediately **before the model
selector** (the `conversation.input.right` slot the conversation's own composer
bar renders) — the chip whose icon this plugin contributes:

- The chip shows the **current tier**: `🍃 Tight` / `⚡ Wide` / `♾️ Open`.
- Hovering shows the **tier plus that tier's ceiling** (for example
  `Wide · ≤5 steps · ≤5 min — click to review or switch tiers`).
- **Clicking opens the panel**, which carries:
  - a three-way **Tight / Wide / Open** segmented switch — one click switches;
  - four facts about the current tier: **per-turn ceiling**, **reasoning level**,
    **permissions**, and the **equivalent command**;
  - an **Edit the ceilings…** button that jumps to this plugin's card on the
    Plugins page;
  - the reason a switch failed, shown in place (nothing fails silently). Every way a
    switch can go wrong releases it: a synchronous failure and a rejected request
    report themselves, a reply lost in transit is released by the Host's own frame,
    and a request the Host never answers is reported after 5 s — so the panel can
    never be left greyed out with no way forward.

A switch is not client-side optimism: it executes the very same `/throttle …`
command a human types. The command is written to the session log, the projection
folds it, and the chip follows the frame — so a refused switch cannot display a
tier that never happened. Every switch also leaves **one receipt line** in the
conversation, for example:

```
⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (workspace-write)
```

### 2. The introduction and the configuration form on the Plugins page

Sidebar **Plugins** → the **dsh-throttle** card → open it. The page sits on the
card, between the plugin's description and its rows (the place the Harness
reserves for a plugin's own configuration). Under the plugin name sits the
**one-line description** that the Plugins list shows too — a distillation of the
introduction below it, never a second, different claim. The page then opens with
the plugin's own **introduction** — what the throttle is for, what a spent ceiling
makes DSH do, why that helps, the five situations it suits, the goal it does *not*
have, and one closing line of **usage** (the chip beside the model selector,
`/throttle`, the form below) — in the active UI language (Chinese for a Chinese UI,
English for an English one), separated from the form below by a hairline:

- Two blocks, **Tight tier** and **Wide tier**, four fields each.
- Every field has a label, its current value (an input), a one-line hint, and an
  `i` button on the right that expands the **full explanation of what that option
  does**.
- Each block also shows a **Built-in default / Overridden** marker and a
  **Reset to default** button; an edited field is marked **Unsaved** and can be
  **Discarded** on its own.
- **Save** at the bottom writes every staged change in one revision-fenced batch.

This page is the Harness's own plugin-settings machinery: `dsh-settings` derives
the form from the `Config` this plugin declares, and `dsh-config-editor` writes the
values into this profile's `cordis.patch.yml`. **The page only exists when the Host
actually serves a settings form** (without `dsh-settings` or
`@deepseek-ai/schemastery` the whole block is not registered — the chip keeps
working).

## Commands

- `/throttle` — a bare command toggles **Tight ⇄ Wide**. Typed from Open it
  re-engages the plugin at Tight.
- `/throttle wide` (also `/throttle deep`) — enter **Wide** explicitly.
- `/throttle open` (also `/throttle off`, `/throttle free`, `/throttle unlimited`)
  — enter **Open**: no ceiling, no reasoning level sent, permissions handed back to
  the session (the plugin only puts a preset back when it finds the session pinned
  to Tight's view-only preset).
- `/throttle tight` (also `/throttle on`, `/throttle default`) — return to
  **Tight** explicitly.
- Attachments are refused; a stray argument is an error and changes nothing.

The three positions in the chip panel are the GUI version of those commands, and
they produce exactly the same receipt.

## Configuration

### Through the interface (recommended)

Plugins page → the **dsh-throttle** card's configuration form. Fields:

| Field | Default | What it does | When it takes effect |
|---|---|---|---|
| `default.steps` | `4` | How many steps one Tight-tier turn may take. **A step is one model response, not one tool call**: however many tools a step calls in parallel, it costs exactly one, which is why the ceiling bounds how far a turn walks and not how wide one step spreads. Past the ceiling, the over-limit step's tool calls are refused, the refusal names the dsh-throttle tier as the reason, and the model is told to hand back in the fixed format. It must stay below `deep.steps`. | Immediately on save; the **next turn** uses the new number |
| `default.minutes` | `2` | The Tight tier's wall-clock ceiling for one turn, in minutes. Counted from the turn's `turn/start` to the current step, so an approval or a download inside a turn counts, while sitting idle between two turns does not. | Same as above |
| `default.effort` | `low` | The reasoning level the Tight tier sends. **Must be a level the model really declares**, otherwise the plugin sends none (the model keeps its own default) instead of failing the turn. | Same as above; applies to every new request |
| `default.permission` | `read-only` | The permission preset Tight pins the session to. It is reconciled idempotently before every step, so changing the session to writable by hand is corrected back — that is what this tier means. | The next step's reconciliation is immediate |
| `deep.steps` | `5` | How many steps one Wide-tier turn may use, counted the same way. **Minimum 5**, and it must be greater than `default.steps`; anything else is refused. A spent ceiling still allows one closing step without tool calls. | Immediately on save; the **next turn** uses the new number |
| `deep.minutes` | `5` | The Wide tier's wall-clock ceiling in minutes, **minimum 5**, also hard. | Same as above |
| `deep.effort` | `high` | The reasoning level the Wide tier sends, again a level the model must declare. | Same as above |
| `deep.permission` | `restore` | `restore` = bring back whatever preset the session held before it entered this tier (recommended). You may name a preset instead (`workspace-write`, `danger-full-access`, …). **Read-only is never a restore target.** | The next step's reconciliation is immediate |

**The Open tier has no configuration block, on purpose**: "no limit" is not a
number anybody could get wrong, and the way back to a usable position must not
depend on configuration.

### Through YAML (the equivalent entry point)

Edit the numbers in `cordis.patch.yml`; no code changes:

```yaml
- id: throttle
  name: 'dsh-throttle'
  config:
    default: { steps: 4, minutes: 2, effort: low,  permission: read-only }
    deep:    { steps: 5,     minutes: 5, effort: high, permission: restore }
```

Once you save from the interface once, that block appears in full in
`~/.dsh/profiles/<profile>/cordis.patch.yml` (the profile's own patch layer,
which outranks the bundle layer's defaults).

- `deep.steps` / `deep.minutes` floor at 5, and `deep.steps` must exceed
  `default.steps`: a value that breaks either rule fails plugin load loudly
  rather than being quietly clamped. Unknown keys fail too — except the
  pre-rename `default.toolCalls`, which is still read as an alias for
  `default.steps` so an unmigrated patch cannot take the plugin row down.
  `default.steps` is the one field the `Config` schema deliberately declares
  **without** a default: the Loader resolves that schema *before* `apply()` runs,
  so a schema default would fill the key whenever a patch omitted it and the alias
  could never be reached — `toolCalls: 6` would quietly mean 4 steps. The built-in
  4 therefore lives in `resolveConfig`, the only place that sees both keys; the
  settings form still shows 4, from its own control fallback.
- **A refused config is loud, not silent.** The validator's message is logged, the
  built-in defaults stand in (a bad patch costs the numbers, never the plugin), and
  the refusal is published where it can be acted on: the `throttle:state` snapshot
  says the numbers in force are the plugin's built-in defaults and names the reason,
  and every `/throttle` receipt repeats it. The same channel covers a refused live
  edit, where the *previous* values stay in force instead. The Tight/Wide ordering
  rule is the case this matters for: it is a cross-field constraint no single
  field's schema can express, so a hand-edited `cordis.patch.yml` can still state a
  pair the plugin refuses; the settings page blocks that pair before writing it.
- `effort` must be a level **the session's model declares** (see the profile's
  `llm-pi-ai` row). A level that is not declared is skipped, not fatal — the plugin
  asks the model's capability first, so a wrong value cannot break a turn.
- `permission: restore` means the non-Tight tiers give the session its own preset
  back; you may also write a preset name directly (`workspace-write`).

### How a change takes effect

| Entry point | Written to | When it applies | Restart needed |
|---|---|---|---|
| **Save** on the Plugins page form | the profile's `cordis.patch.yml` | **Immediately**: the Loader updates the plugin's config references in place (`loader/volatile-update`), with no remount and no page reload | **No** |
| **Reset to default** / **Discard** | same | same | No |
| Hand-editing `cordis.patch.yml` | same | the next time the composition is loaded | **Yes, restart the Harness** |

Details:

- The interface writes only fields declared **volatile**, which is why nothing
  remounts. One write is atomic and revision-checked (a page sitting on a stale
  revision is refused and told to re-read).
- **The turn already running keeps the old ceiling**: it was counted at the turn's
  start, so the next turn picks up the new number. Switching tiers with
  `/throttle …` recomputes immediately, so the chip's numbers refresh at once.
- The Wide tier's floor of 5 is enforced **twice**: by the form's validation
  (refused with a message) and at plugin load (an error).
- The values the form shows are the values **in force** (the profile layer, falling
  back to the built-in defaults); the **Overridden / Built-in default** marker tells
  you whether that block came from the profile or from the bundle.

## What the model can see

The tier is self-describing. The model has two channels telling it which position
it is in, and **why** the current file policy looks the way it does:

1. `throttle:policy` — the tier's contract plus the standing rules, in the system
   prompt. It changes **only with the tier**, so an ordinary step never rewrites the
   cached prompt prefix.
2. `throttle:state` — a runtime-context snapshot ordered right after the Harness's
   own `sandbox:policy` (order `110 + 2`), so the line after
   `Current DSH file policy: read-only` explains that this read-only came from the
   plugin's Tight tier — not from the deployment default and not from the user. It
   also carries this turn's budget progress, and renders the fixed hand-back format
   once the ceiling is spent. The Harness **replaces** context snapshots in place
   rather than appending, so a per-step update costs one line.

Three sources of a permission preset are kept apart: `set by this plugin to X`
(defined by the tier), `the session's own preset X` (this tier honours it and adds
no limit), and `this plugin targets Y while the current preset is X` (the tier was
just entered, the user just changed it by hand, or the permission service is
unavailable — it is reconciled on the next step). A refused tool call also names
`the dsh-throttle plugin's tier ceiling` so nobody mistakes it for the sandbox.

Two more facts ride in those channels, because both would otherwise be invisible:

- **A delegated sub-session inherits its tier** (see the trade-offs below). Its
  snapshot names the tier as *inherited from the session that delegated to this
  one*, and the permission line attributes the scope to `the scope this delegated
  sub-session was started with` instead of to the tier — the plugin releases the
  read-only pin its own Tight tier may have written, and never narrows the scope
  the Harness fixed at delegation.
- **A refused row config is named, not absorbed.** `apply()` falls back to the
  built-in numbers so a bad patch cannot remove the throttle, but the snapshot
  then carries *the numbers in force are this plugin's built-in defaults, because
  the row config was refused — &lt;reason&gt;*, and every `/throttle` receipt repeats
  it. The model reports the mismatch instead of presenting the built-in numbers as
  the user's own.

To read the copy directly:

```powershell
node tools/preview-throttle-text.mjs    # every tier × fresh/spent, verbatim
```

## Install / rollback

```powershell
node tools/install-dsh-throttle.mjs            # dry run: print the change set + validate YAML
node tools/install-dsh-throttle.mjs --apply    # write, then verify
node tools/install-dsh-throttle.mjs --rollback --apply
```

Installing does four things in the desktop profile:

1. adds a `link:` dependency pointing at this directory to the profile's
   `package.json`;
2. appends `dsh-throttle` to `dsh.profile.bundles`;
3. creates a directory junction to this directory under the profile's
   `node_modules`;
4. declares `reasoningEfforts: { low, high }` on the `commandcode` models and clears
   a stray `reasoningEffort` on `agent-default-model`.

Everything is backed up to `backup/<timestamp>/` before it is touched. **The
Harness application must be restarted afterwards** (the bundle list and the browser
plugin graph are composed at startup).

### Migrating an existing `dsh-power` installation

```powershell
node tools/migrate-dsh-power-profile.mjs           # dry run: print the change set
node tools/migrate-dsh-power-profile.mjs --apply   # write, then verify
```

`install-dsh-throttle.mjs` only ever speaks the new name, so a profile installed
before the rename needs this one step: it drops the old dependency, the old
`dsh.profile.bundles` entry and the old `node_modules` junction, then takes up the
new ones exactly as a fresh install would. It changes **only** those four things —
in particular it leaves `agent-default-model` and the models' `reasoningEfforts`
alone, because on an existing profile those are your own state (a fresh install does
rewrite them). The previous manifest is backed up under `backup/<timestamp>/`, and
the restart is required just the same.

Note that a session whose log recorded `/power …` no longer folds: the projection
key and the command name both moved, so such a session resumes in **Tight**.

> **Run `/throttle open` before removing the plugin**: the Tight tier writes a
> `read-only` permission preset into each session log, and once the plugin is gone
> nothing puts it back. Such a session stays read-only with nothing explaining why.
> For a session already stuck there, pick a writable preset in the permissions
> selector or run `/permission workspace-write` (a command `dsh-permission-presets`
> ships).

## Tests

```powershell
node --test dsh-throttle/test/            # the normal form
node dsh-throttle/test/throttle.test.mjs  # use this in a restricted shell (a --test directory spawns a child, which the sandbox blocks)
```

44 cases cover config validation, all three tiers' ceilings and time limits, Open
counting nothing, the hand-back copy, the turn boundary folding **before** the
prompt is assembled (including the "88 idle minutes then a new turn" regression),
projection folding (including that a refusal changes nothing), **the client view
(tier + all three ceilings + JSON-serializable + live values after a config
edit)**, **volatile config updates (good values apply, bad ones keep the old
ones)**, **a delegated sub-session inheriting its delegator's tier — and its own
`/throttle` ending that inheritance — on a budget of its own**, **a refused row
config being named in the snapshot and in the receipt**, the three command paths,
remembering and restoring a manually changed permission, reasoning-level dispatch
(including Open sending none), guard refusals, the prompt section and runtime
context's copy and stability, replay across a restart, and that a session is still
writable after `/throttle open`.

The settings form and the browser half ride real contracts, but a unit-test
environment has no `@deepseek-ai/schemastery` / `zod` / React — so there are four
offline checks:

```powershell
# 1. the manifest <-> client-half contract (needs no dependencies at all)
node tools/verify-throttle-manifest.mjs

# 2. the browser half: load client.js and really render it
#    (a bundled minimal React double plus a primitives stub)
node tools/probe-throttle-client.mjs

# 3. the config-schema contract: take the libraries out of the installation and
#    run the plugin's own code against them
$app = "<install dir>\resources\app.asar"
$probe = "$env:TEMP\probe\node_modules"
node tools/asar-read.mjs extract $app "dsh/node_modules/@deepseek-ai/schemastery" "$probe\@deepseek-ai\schemastery"
node tools/asar-read.mjs extract $app "dsh/node_modules/@deepseek-ai/cosmokit"    "$probe\@deepseek-ai\cosmokit"
node tools/asar-read.mjs extract $app "dsh/node_modules/@standard-schema/spec"    "$probe\@standard-schema\spec"
node tools/asar-read.mjs extract $app "dsh/node_modules/zod"                      "$probe\zod"
node tools/probe-throttle-config.mjs "$probe\@deepseek-ai\schemastery" "$probe\zod"

# 4. the counting contracts: the step ceiling's legacy alias through the real
#    schema, and a sub-session's inherited tier against its own budget
#    (section A needs the same two package directories, section B none)
node tools/probe-throttle-budgets.mjs "$probe\@deepseek-ai\schemastery" "$probe\zod"
```

- **Manifest check** (19 items): `dsh.client` / `exports["./client"]` / the factory
  id equals the package name, every module the browser half `require()`s is in the
  shell's frozen module table, the icon and the bilingual `locale` metadata, and the
  two `peerDependencies` a linked plugin needs.
- **Client render check** (56 items): both slot registrations and their inject faces
  (the chip claiming `conversation.input.right`, the composer slot immediately before
  the model selector, with its tooltip opening upwards; the config page registering
  behind `configForms`, only while that namespace is
  served, and not at all without `ui-settings`), **that every remote namespace the
  bundle reads is declared in its `inject` list** — checked both from the source and
  behaviourally, through a service accessor that refuses an undeclared namespace the
  way Cordis does — the chip rendering nothing before the projection's first frame,
  the panel's three-way switch (clicking it really executes `/throttle open`, through
  that same guarded accessor), **that a switch which throws, is rejected, or is never
  answered still releases the panel** — the probe's React double keeps refs and runs
  effects, so the deadline and the projection-driven release are exercised for real
  — **the key-set parity of `en` and `zh`**, the **introduction** the page opens
  with (the lead, what a spent ceiling makes the model do, why the checkpoint
  helps, the five situations it suits, the goal it does *not* have, and the one
  closing line of usage, in that order — rendered under `zh` *and* under `en`,
  because parity only proves a key exists, not that the English half reads as the
  introduction), the **Edit
  the ceilings…** jump to the Plugins page, a readable message when the command
  channel is missing, the configuration page's 8 controls with their current values
  and explanations, the **Overridden / Built-in default** markers, and the **one
  operation** a staged save sends (`{op:'set', path:['deep','steps'], value:9}` with
  the revision it read), a value below the floor blocking the save, **the Tight/Wide
  step ordering blocking a save the Host would otherwise refuse at load**, and the
  two fallback messages (not served / still loading).
- **Schema probe** (24 items): both `Config` blocks declared volatile, every default
  except the Tight step ceiling (which the plugin, not the schema, must supply, or
  the legacy `toolCalls` alias could never be reached), the floor refusal, the
  cross-field rule the schema *cannot* state together with the plugin's refusal of
  it, the `dsh-settings` form projection (`volatileForm`) exposing only those two
  blocks, a saved document re-resolving to the same values, and that
  `wire.viewSchema` really is Zod (it has `.parse`) and refuses a malformed view.
- **Counting probe** (19 items): the alias deciding the value through the real
  schema, the built-in 4 when neither key is present, a Tight delegator's child
  running Tight and view-only, a Wide delegator's child following it into Wide on
  its own step counter (and only the plugin's own read-only pin being released),
  and the delegator's wall clock — but never its step counter — being charged for
  the delegation.

## Known trade-offs

- **Tight is "the cheapest reasoning level", not "no thinking"**: the provider
  rejects `none`, and leaving `off` empty means sending no parameter at all, which
  lets the gateway keep its own (more expensive) default. So Tight sends `low`. For
  genuinely unconstrained thinking, use Open.
- **Tight keeps pushing the preset back to `read-only`**: it re-asserts the preset
  once per step (idempotently — a match writes nothing to the log), so changing the
  session to writable by hand is corrected. That is deliberate: Tight *means*
  view-only, and the way out is `/throttle` or `/throttle open`.
- **The non-Tight tiers do not accept "read-only" as a choice**: Wide/Open restore
  the session's own preset, so changing them to read-only by hand is similarly
  corrected. Also deliberate — otherwise a session that once picked read-only
  outside Tight could never become writable again.
- **Sub-sessions follow the tier of the session that started them**, on a budget of
  their own. A session spawned by `subagent` has no `/throttle` record, so it
  *inherits*: a Tight delegator's child is Tight and view-only, a Wide delegator's
  child is Wide, an Open delegator's child is Open. The lookup is live — switching
  the delegator is what widens or narrows its children — and transitive through
  nested delegation. `subagent_fork` inherits the parent's *log*, hence its own
  tier record, which is the same answer by a different route.
  Three consequences worth knowing:
  - **A child's step budget is its own**, so it does not spend the delegator's
    steps; N children are N budgets. The delegator's *wall clock*, however, keeps
    running while it waits inside the `subagent` call, so a long delegation spends
    the delegator's minute ceiling even though it spends none of its steps.
  - **An inherited tier never rewrites the scope the delegation fixed.** The
    subagent runtime starts a child with its own permission scope ("your permission
    scope was fixed when you were started"); the plugin only releases the read-only
    pin its own Tight tier wrote, and never narrows a delegated scope. Running
    `/throttle …` *inside* a child session ends the inheritance and pins that
    session's own tier, after which only that session's own commands move it.
  - **The chip beside the model selector shows the session's own record, not the
    inherited answer.**
    The published view is computed from one session's projection state, which has no
    access to the delegator; enforcement and the model-facing text both use the
    inherited tier. Clicking a position in a child session's panel pins that tier
    for that session, exactly as typing the command does.
- **The time ceiling is the wall clock of one turn**: counted from the log's
  `turn/start` to the current step, so waiting for an approval or a download inside
  a turn counts, while sitting idle between two turns does not. The boundary is
  folded from `turn/start` / `turn/end` on `session/event` **before** the prompt is
  assembled (the rev.3.1 fix): the record used to be advanced only in
  `agent/pre-step`, which the loop runs *after* rendering the runtime context, so a
  turn's first step carried the previous turn's record — 88 minutes of idling were
  charged to a fresh, zero-call turn, and the model surrendered instead of working.
- **The chip's numbers can lag one step**: the ceiling is published with the
  projection view (recomputed when the tier or state changes), so right after
  editing a number in the form, with no session event in between, the panel may
  still show the old figure; switching tier or starting a new turn refreshes it.
  **The enforcement side always uses the newest values** (the guard and the prompt
  text re-read the config every step), so this is display lag only.
- **The configuration page depends on two Host packages and two schema libraries**:
  `dsh-settings` + `dsh-config-editor` (form and persistence) and
  `@deepseek-ai/schemastery` (the `Config` schema); the projection's
  `wire.viewSchema` uses `zod` (the projection wire contract's schema language, as
  first-party plugins do). Both are **dynamic imports**: a linked plugin only gets
  installation packages if its own `package.json` declares them as
  `peerDependencies` (both are declared here), and failing to resolve them is not an
  error — the settings form simply does not appear (`wire.viewSchema` falls back to
  a built-in validator).
- **The browser half depends on the Harness's static module table**: `react` and
  `@deepseek-ai/dsh-client-ui-primitives` are baseline entries in the web shell's
  frozen module table (`Button` / `Modal` / `Tooltip` / `Tag` / `SegmentedControl` /
  `SettingsValueField`), so no build step and no `dsh.client.external` declaration
  are needed. The cost is coupling to this DSH version's primitives — which is how
  the shipped settings pages do it too.
- **Every remote namespace the browser half reads must be declared in its exported
  `inject`**: `remote.commands` is a service of its own, not a field of `remote`. The
  Cordis guard answers an undeclared read with a **synchronous** throw at the moment
  of the read, so getting this wrong does not fail the plugin at load — it fails the
  chip's switch on the first click. The client probe derives the requirement from the
  source and drives the switch through a guarded accessor, so the declaration cannot
  silently rot.

## Implementation notes

The design, the deviations from the plan and why they were taken (including the
projection state-version upgrade) are recorded in
[`../IMPLEMENTATION-throttle-mode.md`](../IMPLEMENTATION-throttle-mode.md); the
decisions taken for the UI stage (the plan's original section 11) are recorded there
too. The plan itself is [`../PLAN-throttle-mode.md`](../PLAN-throttle-mode.md).
