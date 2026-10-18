#!/usr/bin/env node
/**
 * Preview exactly what the model reads in each `/throttle` tier.
 *
 * Prints the `throttle:policy` system-prompt section and the `throttle:state`
 * runtime-context snapshot for every tier, at a fresh turn, mid-turn, and with
 * the budget spent — plus the inherited-tier copy a delegated sub-session reads
 * and the copy a refused row config produces — so the model-facing text can be
 * reviewed without running the Harness.
 *
 * Usage: node tools/preview-throttle-text.mjs
 */

import {
  emptyUsage,
  observeStep,
  policySection,
  resolveConfig,
  stateContext
} from '../dsh-throttle/state.js'

const config = resolveConfig({
  default: { steps: 4, minutes: 2, effort: 'low', permission: 'read-only' },
  deep: { steps: 5, minutes: 5, effort: 'high', permission: 'restore' }
})

const T0 = 1_000_000
const rows = [
  ['default', 'pending', 'workspace-write', 'read-only', 0],
  ['default', 'plugin', 'read-only', null, 0],
  ['default', 'plugin', 'read-only', null, 3],
  ['default', 'plugin', 'read-only', null, 5],
  ['deep', 'session', 'workspace-write', null, 3],
  ['deep', 'session', 'workspace-write', null, 6],
  ['deep', 'delegated', 'workspace-write', null, 1, { inherited: true }],
  ['free', 'session', 'workspace-write', null, 12],
  ['free', 'session', 'read-only', null, 12],
  ['free', 'pending', 'read-only', 'workspace-write', 12]
]

for (const [mode, source, preset, target, step, options] of rows) {
  const usage = emptyUsage()
  if (step > 0) observeStep(usage, { turn: 1, step }, T0)
  const permission = { preset, source, target: target ?? undefined }
  const now = T0 + 60_000 * (mode === 'default' ? 0.5 : 3)
  console.log(`\n${'─'.repeat(78)}`)
  console.log(`# ${mode} · permission=${preset} (${source}${target === null ? '' : ` → ${target}`}) · step=${step}${options === undefined ? '' : ' · inherited'}`)
  console.log(`${'─'.repeat(78)}`)
  console.log('--- throttle:policy (system prompt section, stable per tier) ---')
  console.log(policySection(config, mode, permission, options?.inherited === true))
  console.log('\n--- throttle:state (runtime-context snapshot, replaced in place) ---')
  console.log(stateContext(config, mode, usage, now, permission, options))
}

// The one snapshot shape that is not a tier: a row config the plugin refused.
{
  const usage = emptyUsage()
  observeStep(usage, { turn: 1, step: 2 }, T0)
  console.log(`\n${'─'.repeat(78)}`)
  console.log('# default · a refused row config (built-in defaults in force)')
  console.log(`${'─'.repeat(78)}`)
  console.log('--- throttle:policy (system prompt section, stable per tier) ---')
  console.log(policySection(config, 'default', { preset: 'read-only', source: 'plugin' }))
  console.log('\n--- throttle:state (runtime-context snapshot, replaced in place) ---')
  console.log(stateContext(config, 'default', usage, T0 + 30_000, { preset: 'read-only', source: 'plugin' }, {
    issue: 'dsh-throttle: config.deep.steps (5) must be greater than config.default.steps (6) — the Wide tier must be wider than the Tight tier'
  }))
}
