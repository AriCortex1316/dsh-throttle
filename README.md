# dsh-throttle

A `/throttle` **three-tier boundary control** for the DeepSeek Harness (DSH): one
session, three positions on one throttle. The plugin's job is to contract a
session's boundaries — how much reasoning it may spend, how many steps one turn
may use, how long a turn may run, and what the file policy is allowed to be.

- **Tight** (the tier a session starts in) — cheapest declared reasoning level,
  view-only permissions, the tightest per-turn ceiling.
- **Wide** (`/throttle`) — a configurable reasoning level, the session's own
  permission preset restored, a larger ceiling that still holds.
- **Open** (`/throttle open`) — no ceiling, no effort override, permissions
  untouched: as if the plugin were not installed.

## Why it exists

1. **Every turn was thinking.** The models on the `commandcode` route declared no
   `reasoningEfforts`, so DSH treated them as having no reasoning control, sent no
   switch at all, and the gateway fell back to its own default — always on. Slow,
   token-hungry, and prone to drifting off the question.
2. **Everyday questions do not need deep reasoning.** Chat and lookups should land
   in one or two tool calls.
3. **Real work needs room, but a bounded amount of it.** Deep tasks want freedom
   with a hard ceiling, not unbounded exploration.
4. **A missing flow constraint.** Nothing told the model to offer directions first
   and *stop to ask* when the requirements were thin — so a one-line request could
   turn straight into an implementation.

The ceiling is the point: when a session spends it, the model must stop and hand
back a fixed checkpoint (current conclusions, what is still unconfirmed, and the
commands you should run to verify) instead of silently retrying. That turns a
runaway turn into a decision you get to make.

## The three tiers

| | **Tight** (what a session starts in) | **Wide** (`/throttle`) | **Open** (`/throttle open`) |
|---|---|---|---|
| Reasoning | cheapest level the model declares (default `low`) | the configured level (default `high`) | **not sent** (the session / model selector keeps its own) |
| Per-turn ceiling | ≤4 steps / ≤2 min | ≤5 steps / ≤5 min | **none** (and nothing is counted) |
| Permissions | view-only (`read-only`), asserted by this plugin | the session's own preset, restored | the session's own preset, left alone |
| Position | everyday questions, cheap and bounded | real work, still hard-bounded | **as if the plugin were not installed** |

**A "step" is one model response, not one tool call.** However many tools a step
calls in parallel, it costs exactly one — so the ceiling bounds how far a turn
walks, not how wide a single step spreads. Past the ceiling the over-limit step's
tool calls are refused, the refusal names the plugin's tier as the reason, and the
model is told to hand back in the fixed format.

## Usage

### Commands

| Command | Effect |
|---|---|
| `/throttle` | toggle **Tight ⇄ Wide** (typed from Open, re-engages the plugin at Tight) |
| `/throttle wide` (or `deep`) | enter **Wide** explicitly |
| `/throttle open` (or `off`, `free`, `unlimited`) | enter **Open** |
| `/throttle tight` (or `on`, `default`) | return to **Tight** explicitly |

Attachments are refused; a stray argument is an error and changes nothing. Every
switch leaves one receipt line in the conversation, for example:

```
⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (workspace-write)
```

### The tier chip

In the composer bar, in the trailing group immediately **before the model
selector**, sits a chip showing the current tier: `🍃 Tight` / `⚡ Wide` / `♾️ Open`.
Hovering shows the tier and its ceiling; clicking opens a panel with a three-way
segmented switch, the current tier's four facts (ceiling, reasoning level,
permissions, equivalent command), and a jump to the ceiling editor.

A switch is not client-side optimism — it executes the very same `/throttle …`
command a human types, so a refused switch cannot display a tier that never
happened, and nothing fails silently.

### Editing the ceilings

Sidebar **Plugins** → the **dsh-throttle** card → open it. Two blocks (**Tight**,
**Wide**), four fields each, with hints, an `i` explanation per field, an
**Overridden / Built-in default** marker and a **Reset to default** button. Saving
applies immediately — no remount, no page reload, no restart. The **Open tier has
no configuration block on purpose**: "no limit" is not a number anybody could get
wrong, and the way back to a usable position must not depend on configuration.

| Field | Default | Meaning |
|---|---|---|
| `default.steps` | `4` | steps one Tight turn may take (must stay below `deep.steps`) |
| `default.minutes` | `2` | Tight wall-clock ceiling per turn |
| `default.effort` | `low` | reasoning level Tight sends (must be one the model declares) |
| `default.permission` | `read-only` | preset Tight pins the session to |
| `deep.steps` | `5` | steps one Wide turn may use (**floor 5**, must exceed `default.steps`) |
| `deep.minutes` | `5` | Wide wall-clock ceiling (**floor 5**) |
| `deep.effort` | `high` | reasoning level Wide sends |
| `deep.permission` | `restore` | give the session its own preset back (read-only is never a restore target) |

The same values can be written by hand in the profile's `cordis.patch.yml`:

```yaml
- id: throttle
  name: 'dsh-throttle'
  config:
    default: { steps: 4, minutes: 2, effort: low,  permission: read-only }
    deep:    { steps: 5, minutes: 5, effort: high, permission: restore }
```

Hand-editing needs a Harness restart; the Plugins-page form does not. A refused
config is loud, not silent: the built-in numbers stand in, the reason is named in
the model-facing snapshot, and every `/throttle` receipt repeats it.

## Install

```powershell
node tools/install-dsh-throttle.mjs            # dry run: print the change set + validate YAML
node tools/install-dsh-throttle.mjs --apply    # write, then verify
node tools/install-dsh-throttle.mjs --rollback --apply
```

Installing does four things in the desktop profile: adds a `link:` dependency on
this directory, appends `dsh-throttle` to `dsh.profile.bundles`, creates a
junction under the profile's `node_modules`, and declares
`reasoningEfforts: { low, high }` on the `commandcode` models. Everything is
backed up to `backup/<timestamp>/` first. **Restart the Harness afterwards** — the
bundle list and the browser plugin graph are composed at startup.

Upgrading from the plugin's former name (`dsh-power` / `/power`), run the one-step
migration instead:

```powershell
node tools/migrate-dsh-power-profile.mjs --apply
```

> **Run `/throttle open` before removing the plugin.** Tight writes a `read-only`
> permission preset into each session log, and once the plugin is gone nothing
> puts it back — such a session stays read-only with nothing explaining why. For a
> session already stuck there, pick a writable preset in the permissions selector
> or run `/permission workspace-write`.

## What the model can see

The tier is self-describing, through two channels:

- **`throttle:policy`** — the tier's contract and the standing rules, in the system
  prompt. It changes only with the tier, so an ordinary step never rewrites the
  cached prompt prefix.
- **`throttle:state`** — a runtime-context snapshot ordered right after the
  Harness's own `sandbox:policy`, so the line following
  `Current DSH file policy: read-only` explains that this read-only came from the
  plugin's Tight tier rather than from the deployment or the user. It carries the
  turn's budget progress and renders the fixed hand-back format once the ceiling is
  spent.

A delegated sub-session **inherits the tier of the session that started it**, on a
budget of its own: a Tight delegator's child is Tight and view-only, a Wide
delegator's child is Wide, an Open delegator's child is Open. The delegator's wall
clock keeps running while it waits on the delegation, but its step counter is not
charged. Running `/throttle …` inside a child ends the inheritance for that session.

To read the model-facing copy verbatim:

```powershell
node tools/preview-throttle-text.mjs    # every tier × fresh/spent
```

## Repository layout

```
dsh-throttle/                 the plugin itself (host half, browser half, locale, tests)
  index.js                    host half: config, tiers, guard, prompt + runtime context
  state.js                    the session projection that holds the tier
  client.js                   browser half: the tier chip and the settings form
  cordis.patch.yml            the bundle patch row
  locale/{en,zh}.json         bilingual UI copy
  test/throttle.test.mjs      44 unit cases
tools/                        development and diagnostic scripts
  install-dsh-throttle.mjs    install / rollback into a profile
  migrate-dsh-power-profile.mjs  one-step migration from the old name
  preview-throttle-text.mjs   print every model-facing string
  verify-throttle-manifest.mjs  manifest ↔ client-half contract
  probe-throttle-*.mjs        client render, config schema, counting contracts
  asar-read.mjs, asar-probe.mjs, scan-sessions.mjs, …  offline inspection helpers
PLAN-throttle-mode.md         the specification (Chinese)
IMPLEMENTATION-throttle-mode.md  deviations from the spec and why (Chinese)
```

`reference/` (a local dump of DSH internals) and `backup/` (timestamped profile
backups) are **git-ignored and not part of this repository** — the docs above refer
to them as local-only working material.

## Tests

```powershell
node dsh-throttle/test/throttle.test.mjs   # 44 cases; use this form in a restricted shell
node --test dsh-throttle/test/             # the normal form (spawns a child)
```

The settings form and the browser half ride real contracts, so four offline checks
cover what a unit environment without `@deepseek-ai/schemastery` / `zod` / React
cannot:

```powershell
node tools/verify-throttle-manifest.mjs   # manifest ↔ client contract, 19 items
node tools/probe-throttle-client.mjs      # really render the browser half, 56 items
```

See [`dsh-throttle/README.md`](dsh-throttle/README.md) for the schema probe and the
counting probe, the full item-by-item coverage, and the known trade-offs.

## Documentation

- [`dsh-throttle/README.md`](dsh-throttle/README.md) — the full user-facing manual:
  every interface, every field, the model-facing copy, install/rollback, coverage
  and trade-offs.
- [`PLAN-throttle-mode.md`](PLAN-throttle-mode.md) — the specification (Chinese).
- [`IMPLEMENTATION-throttle-mode.md`](IMPLEMENTATION-throttle-mode.md) — where the
  implementation departs from the spec, and why (Chinese).

## Known trade-offs, in brief

- **Tight is "the cheapest reasoning level", not "no thinking"**: the gateway
  rejects `none`, and sending nothing lets it keep its own expensive default. For
  genuinely unconstrained thinking, use Open.
- **Tight keeps pushing the preset back to `read-only`** once per step
  (idempotently). That is deliberate — Tight *means* view-only, and the way out is
  `/throttle` or `/throttle open`.
- **The chip's numbers can lag one step** behind a just-saved config edit; tier
  switching or a new turn refreshes them. **Enforcement always uses the newest
  values** — this is display lag only.

## License

MIT, as declared in [`dsh-throttle/package.json`](dsh-throttle/package.json).
