#!/usr/bin/env node
/**
 * Migrate a profile that still selects the old `dsh-power` bundle over to
 * `dsh-throttle`.
 *
 * `install-dsh-throttle.mjs` only ever speaks the new name, and
 * `--rollback` on it would remove a `dsh-throttle` row that is not there yet —
 * so a profile installed before the rename needs this one step: drop the old
 * dependency, the old `dsh.profile.bundles` entry and the old junction, then
 * take up the new ones exactly as a fresh install would.
 *
 * It touches only those four things. In particular it does **not** rewrite
 * `agent-default-model` or the models' `reasoningEfforts` the way a fresh
 * install does, because on an existing profile those are the user's own state
 * and a rename has no business changing them.
 *
 * Usage (from the workspace root):
 *
 *     node tools/migrate-dsh-power-profile.mjs             # dry run
 *     node tools/migrate-dsh-power-profile.mjs --apply     # write, then verify
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const pluginDir = join(workspace, 'dsh-throttle')
const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', 'desktop')
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const OLD = 'dsh-power'
const NEW = 'dsh-throttle'
const oldLink = join(profileDir, 'node_modules', OLD)
const newLink = join(profileDir, 'node_modules', NEW)
const specifier = `link:${relative(profileDir, pluginDir).split('\\').join('/')}`

const apply = process.argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(workspace, 'backup', stamp)
const changes = []
const notes = []

/** Whether the path exists as a link (junction or symlink). */
function isLink (path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Where a link points, resolved, or `undefined`. */
function linkTarget (path) {
  try {
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return undefined
  }
}

/** Read a file or fail with a clear message. */
function read (path) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`)
  return readFileSync(path, 'utf8')
}

// ── the plan ────────────────────────────────────────────────────────────────
if (!existsSync(profileDir)) throw new Error(`profile directory not found: ${profileDir}`)
if (!existsSync(pluginDir)) throw new Error(`plugin source not found: ${pluginDir}`)

const manifest = JSON.parse(read(manifestPath))

if (manifest.dependencies?.[OLD] !== undefined) {
  changes.push({ kind: 'manifest', target: `dependencies.${OLD}`, detail: `remove (${manifest.dependencies[OLD]})` })
  delete manifest.dependencies[OLD]
}
if (manifest.dependencies?.[NEW] !== specifier) {
  changes.push({ kind: 'manifest', target: `dependencies.${NEW}`, detail: `${manifest.dependencies?.[NEW] ?? '(absent)'} -> ${specifier}` })
  manifest.dependencies ??= {}
  manifest.dependencies[NEW] = specifier
}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (bundles.includes(OLD)) {
  changes.push({ kind: 'manifest', target: 'dsh.profile.bundles', detail: `remove ${OLD}` })
}
if (!bundles.includes(NEW)) {
  changes.push({ kind: 'manifest', target: 'dsh.profile.bundles', detail: `append ${NEW}` })
}
manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== OLD)
if (!manifest.dsh.profile.bundles.includes(NEW)) manifest.dsh.profile.bundles.push(NEW)

if (isLink(oldLink)) {
  const target = linkTarget(oldLink)
  if (target === resolve(join(workspace, OLD)) || target === resolve(pluginDir)) {
    changes.push({ kind: 'link', target: oldLink, detail: `remove the junction -> ${target}` })
  } else {
    notes.push(`${oldLink} points at ${target}, not at this workspace; leaving it alone`)
  }
} else if (existsSync(oldLink)) {
  notes.push(`${oldLink} exists but is not a link; leaving it alone`)
}
if (!isLink(newLink) && existsSync(newLink)) {
  notes.push(`${newLink} exists but is not a link; refusing to repoint it — inspect it first`)
} else if (linkTarget(newLink) !== resolve(pluginDir)) {
  changes.push({ kind: 'link', target: newLink, detail: `junction -> ${pluginDir}` })
}

console.log(`profile: ${profileDir}`)
console.log(`plugin : ${pluginDir}`)
console.log(`mode   : migrate ${OLD} -> ${NEW}${apply ? ' (applying)' : ' (dry run)'}`)
console.log('')
for (const entry of changes) console.log(`  ${entry.kind.padEnd(9)} ${entry.target}: ${entry.detail}`)
for (const note of notes) console.log(`  note      ${note}`)
if (changes.length === 0) console.log('  (nothing to do — the profile already selects the new row)')

if (!apply) {
  console.log('\nre-run with --apply to write these changes')
  process.exit(0)
}

// ── apply ───────────────────────────────────────────────────────────────────
mkdirSync(backupDir, { recursive: true })
cpSync(manifestPath, join(backupDir, 'package.json'))
if (existsSync(patchPath)) cpSync(patchPath, join(backupDir, 'cordis.patch.yml'))
writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')

if (isLink(oldLink) && linkTarget(oldLink) === resolve(join(workspace, OLD))) rmSync(oldLink, { recursive: true, force: true })
if (!isLink(newLink)) {
  mkdirSync(dirname(newLink), { recursive: true })
  symlinkSync(pluginDir, newLink, 'junction')
}

// ── verify ──────────────────────────────────────────────────────────────────
const problems = []
const written = JSON.parse(read(manifestPath))
if (written.dependencies?.[OLD] !== undefined) problems.push(`the manifest still declares ${OLD}`)
if (written.dsh?.profile?.bundles?.includes(OLD)) problems.push(`the manifest still selects ${OLD}`)
if (written.dependencies?.[NEW] !== specifier) problems.push(`the manifest does not point ${NEW} at ${specifier}`)
if (!written.dsh?.profile?.bundles?.includes(NEW)) problems.push(`the manifest does not select ${NEW}`)
if (!isLink(newLink)) problems.push(`${newLink} is not a junction`)
try {
  const resolved = createRequire(join(profileDir, 'package.json')).resolve(NEW)
  console.log(`\nresolved ${NEW} -> ${resolved}`)
} catch (error) {
  problems.push(`the profile cannot resolve ${NEW}: ${error.code ?? error.message}`)
}

if (problems.length > 0) {
  console.error('\nverification failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nok. the previous manifest is backed up under ${backupDir}`)
console.log('restart the Harness application so the profile is recomposed with the new bundle.')
