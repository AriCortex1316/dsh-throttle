#!/usr/bin/env node
/**
 * Install (or roll back) the `dsh-throttle` bundle in the desktop Harness profile.
 *
 * The plugin's source of truth is `<workspace>/dsh-throttle`; the profile gets a
 * directory junction to it plus the two manifest facts the Harness reads at
 * boot. The profile's model catalog also needs `reasoningEfforts` declared,
 * without which no reasoning level exists for the `commandcode` models and the
 * plugin's effort control has nothing to select (see IMPLEMENTATION-throttle-mode.md).
 *
 * Usage (from the workspace root):
 *
 *     node tools/install-dsh-throttle.mjs            # dry run: print the change set
 *     node tools/install-dsh-throttle.mjs --apply    # write, then verify
 *     node tools/install-dsh-throttle.mjs --rollback --apply
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const linkPath = join(profileDir, 'node_modules', 'dsh-throttle')
const backupRoot = join(workspace, 'backup')
const packageName = 'dsh-throttle'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const rollback = args.includes('--rollback')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(backupRoot, stamp)

const changes = []
const notes = []

/** Record one intended change. */
function change (kind, target, detail) {
  changes.push({ kind, target, detail })
}

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

/** Back up one file before it is modified. */
function backupFile (path) {
  if (!apply) return
  mkdirSync(backupDir, { recursive: true })
  cpSync(path, join(backupDir, relative(profileDir, path).replace(/[\\/]/g, '__')))
}

// ── the manifest: dependency + bundle selection ─────────────────────────────
/**
 * Add the plugin to the profile manifest.
 * @param text - current manifest text.
 * @returns the next manifest text.
 */
function patchManifest (text) {
  const manifest = JSON.parse(text)
  const specifier = `link:${relative(profileDir, pluginDir).split('\\').join('/')}`
  manifest.dependencies ??= {}
  if (manifest.dependencies[packageName] !== specifier) {
    change('manifest', 'dependencies.' + packageName, `${manifest.dependencies[packageName] ?? '(absent)'} -> ${specifier}`)
    manifest.dependencies[packageName] = specifier
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (!manifest.dsh.profile.bundles.includes(packageName)) {
    change('manifest', 'dsh.profile.bundles', `append ${packageName}`)
    manifest.dsh.profile.bundles.push(packageName)
  }
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}

/** Remove the plugin from the profile manifest. */
function unpatchManifest (text) {
  const manifest = JSON.parse(text)
  if (manifest.dependencies?.[packageName] !== undefined) {
    change('manifest', 'dependencies.' + packageName, 'remove')
    delete manifest.dependencies[packageName]
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(packageName)) {
    change('manifest', 'dsh.profile.bundles', `remove ${packageName}`)
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== packageName)
  }
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}

// ── the model catalog: declare the reasoning levels ─────────────────────────
/**
 * Declare `reasoningEfforts` on every model of every `models:` list.
 *
 * The wire spellings are what the gateway receives as `reasoning_effort`; the
 * pi-ai adapter only sends the off value when one is declared, so an empty
 * `off:` — which the docs allow — would leave the gateway thinking on its own.
 * `none` is the OpenAI-compatible spelling for "do not reason".
 *
 * @param text - current patch text.
 * @param levels - the level-to-wire mapping to declare.
 * @returns the next patch text.
 */
function patchModelReasoning (text, levels = { low: 'low', high: 'high' }) {
  const lines = text.split('\n')
  const modelsIndex = lines.findIndex((line) => /^(\s*)models:\s*$/.test(line))
  if (modelsIndex === -1) {
    notes.push('no `models:` list found in the profile patch; the reasoning levels were not declared')
    return text
  }
  const modelsIndent = /^(\s*)/.exec(lines[modelsIndex])[1].length
  // The first sequence entry after `models:` fixes the item indent; nested
  // sequences inside an entry (a model's `input:` list) are deeper and must not
  // be mistaken for further models.
  let itemIndent = -1
  for (let index = modelsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= modelsIndent) break
    const match = /^(\s*)- /.exec(line)
    if (match !== null) {
      itemIndent = match[1].length
      break
    }
  }
  if (itemIndent === -1) {
    notes.push('the `models:` list in the profile patch is empty; the reasoning levels were not declared')
    return text
  }
  const isItem = (line) => {
    const match = /^(\s*)- /.exec(line)
    return match !== null && match[1].length === itemIndent
  }
  const itemIndices = []
  for (let index = modelsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= modelsIndent && !isItem(line)) break
    if (isItem(line)) itemIndices.push(index)
  }
  const levelsText = Object.entries(levels).map(([level, wire]) => `${level}: ${wire}`).join(', ')
  const edits = []
  for (let position = 0; position < itemIndices.length; position += 1) {
    const start = itemIndices[position]
    let end = position + 1 < itemIndices.length ? itemIndices[position + 1] : -1
    if (end === -1) {
      end = start + 1
      while (end < lines.length) {
        const line = lines[end]
        if (line.trim() !== '' && /^(\s*)/.exec(line)[1].length <= modelsIndent) break
        end += 1
      }
    }
    const dashIndent = /^(\s*)/.exec(lines[start])[1].length
    const keyIndent = ' '.repeat(dashIndent + 2)
    const id = /- id:\s*(\S+)/.exec(lines[start])?.[1] ?? `item ${position + 1}`
    const declared = lines.findIndex((line, index) => index >= start && index < end && line.startsWith(`${keyIndent}reasoningEfforts:`))
    // 手动声明包含网关映射、内联对象和 false；安装不能替用户重写能力。
    if (declared !== -1) {
      notes.push(`model ${id}: keep existing reasoningEfforts`)
      continue
    }
    const block = [`${keyIndent}reasoningEfforts:`]
    for (const [level, wire] of Object.entries(levels)) block.push(`${keyIndent}  ${level}: ${wire}`)
    edits.push({ from: end, to: end, block, id, action: 'declare' })
  }
  if (edits.length === 0) return text
  for (const edit of edits.reverse()) {
    change('model', edit.id, `${edit.action} reasoningEfforts {${levelsText}}`)
    lines.splice(edit.from, edit.to - edit.from, ...edit.block)
  }
  return lines.join('\n')
}

/**
 * Drop a reasoning effort pinned on the profile's default model.
 *
 * The global default applies to every new session, so an effort left there
 * decides thinking for sessions `/throttle` has not touched — and when that effort
 * is not declared on the model, `prepareCall` refuses the first request of every
 * new session. `/throttle` owns effort per session; the global default must not.
 *
 * @param text - current patch text.
 * @returns the next patch text.
 */
function patchDefaultModel (text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*- id:\s*agent-default-model\s*$/.test(line))
  if (start === -1) {
    notes.push('no `agent-default-model` row found; the global default effort was not checked')
    return text
  }
  const dashIndent = /^(\s*)/.exec(lines[start])[1].length
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && /^(\s*)- /.exec(line) !== null && /^(\s*)/.exec(line)[1].length <= dashIndent) break
    end += 1
  }
  const kept = []
  let dropped = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (index > start && index < end && /^\s*reasoningEffort:\s*\S/.test(lines[index])) {
      dropped += 1
      continue
    }
    kept.push(lines[index])
  }
  if (dropped > 0) change('manifest', 'agent-default-model.config.reasoningEffort', `remove ${dropped} pinned effort(s)`)
  return kept.join('\n')
}

/** Restore every default-model effort line this script removed. */
function unpatchDefaultModel (text) {
  notes.push('a reasoningEffort removed from agent-default-model is not restored by --rollback; re-add it by hand if you want it back')
  return text
}

/** Remove every `reasoningEfforts` block this script shape could have added. */
function unpatchModelReasoning (text) {
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*reasoningEfforts:\s*$/.test(lines[index])) {
      const indent = /^(\s*)/.exec(lines[index])[1].length
      let end = index + 1
      while (end < lines.length && /^(\s*)/.exec(lines[end])[1].length > indent && lines[end].trim() !== '') end += 1
      removed += 1
      index = end - 1
      continue
    }
    out.push(lines[index])
  }
  if (removed > 0) change('model', 'reasoningEfforts', `remove ${removed} declared block(s)`)
  return out.join('\n')
}

// ── the plan ────────────────────────────────────────────────────────────────
if (!existsSync(profileDir)) throw new Error(`profile directory not found: ${profileDir}`)
if (!existsSync(pluginDir)) throw new Error(`plugin source not found: ${pluginDir}`)

const nextManifest = rollback ? unpatchManifest(read(manifestPath)) : patchManifest(read(manifestPath))
const nextPatch = rollback
  ? unpatchModelReasoning(read(patchPath))
  : patchDefaultModel(patchModelReasoning(read(patchPath)))

if (rollback) {
  if (isLink(linkPath) && linkTarget(linkPath) === resolve(pluginDir)) change('link', linkPath, 'remove the junction')
  else if (existsSync(linkPath)) notes.push(`${linkPath} exists but is not our junction; leaving it alone`)
  // The Tight tier writes `read-only` into each session log, and nothing puts
  // it back once this plugin is gone. Say so, with the user-facing way out.
  notes.push('sessions that are still in the Tight tier keep their read-only permission preset after removal; switch them back with /permission workspace-write (or the Permissions selector), and prefer `/throttle open` before uninstalling')
} else if (isLink(linkPath)) {
  const target = linkTarget(linkPath)
  if (target !== resolve(pluginDir)) {
    throw new Error(`${linkPath} already points at ${target}; refusing to repoint it — inspect it first`)
  }
  notes.push(`${linkPath} already points at the plugin source`)
} else if (existsSync(linkPath)) {
  change('link', linkPath, 'move the existing directory aside into the backup')
} else {
  change('link', linkPath, `junction -> ${pluginDir}`)
}

console.log(`profile: ${profileDir}`)
console.log(`plugin : ${pluginDir}`)
console.log(`mode   : ${rollback ? 'rollback' : 'install'}${apply ? ' (applying)' : ' (dry run)'}`)
console.log('')

// Prove the patched YAML still parses and that every model really carries the
// declaration, using the profile's own js-yaml, before anything is written.
if (!rollback) {
  try {
    const yaml = createRequire(join(profileDir, 'package.json'))('js-yaml')
    const parsed = yaml.load(nextPatch)
    const provider = parsed?.find?.((entry) => entry?.id === 'llm-pi-ai')
    const models = provider?.config?.providers?.commandcode?.models ?? []
    const declared = models.filter((model) => model.reasoningEfforts !== undefined)
    console.log(`yaml check: ${models.length} model(s), ${declared.length} declaring reasoningEfforts`)
    for (const model of models) {
      console.log(`  ${model.id}: ${model.reasoningEfforts === undefined ? 'MISSING' : JSON.stringify(model.reasoningEfforts)}`)
    }
    if (models.length === 0) notes.push('the patch declares no commandcode models; the reasoning levels had no target')
    else if (declared.length !== models.length) notes.push('not every model declares reasoningEfforts')
    const defaultModel = parsed?.find?.((entry) => entry?.id === 'agent-default-model')
    const pinned = defaultModel?.config?.reasoningEffort
    console.log(`default model effort: ${pinned === undefined ? '(none — /throttle owns it per session)' : `${pinned} (will be removed)`}`)
    if (pinned !== undefined) notes.push(`the global default model pins reasoningEffort "${pinned}"; new sessions would fail while it names a level the model does not declare`)
  } catch (error) {
    notes.push(`yaml check unavailable or failed: ${error.message}`)
  }
  console.log('')
}
if (changes.length === 0) console.log('no changes needed')
for (const entry of changes) console.log(`  ${entry.kind.padEnd(9)} ${entry.target}: ${entry.detail}`)
for (const note of notes) console.log(`  note      ${note}`)

if (!apply) {
  console.log('\nre-run with --apply to write these changes')
  process.exit(0)
}

// ── apply ───────────────────────────────────────────────────────────────────
backupFile(manifestPath)
backupFile(patchPath)
if (nextManifest !== read(manifestPath)) writeFileSync(manifestPath, nextManifest, 'utf8')
if (nextPatch !== read(patchPath)) writeFileSync(patchPath, nextPatch, 'utf8')

if (rollback) {
  if (isLink(linkPath) && linkTarget(linkPath) === resolve(pluginDir)) rmSync(linkPath, { recursive: true, force: true })
} else {
  mkdirSync(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath) && !isLink(linkPath)) {
    mkdirSync(backupDir, { recursive: true })
    renameSync(linkPath, join(backupDir, 'node_modules__dsh-throttle'))
  }
  if (!existsSync(linkPath)) symlinkSync(pluginDir, linkPath, 'junction')
}

// ── verify ──────────────────────────────────────────────────────────────────
const problems = []
if (rollback) {
  const manifest = JSON.parse(read(manifestPath))
  if (manifest.dependencies?.[packageName] !== undefined) problems.push('manifest still declares the dependency')
  if (manifest.dsh?.profile?.bundles?.includes(packageName)) problems.push('manifest still selects the bundle')
  if (existsSync(linkPath)) problems.push(`${linkPath} still exists`)
  if (/reasoningEfforts:/.test(read(patchPath))) problems.push('the profile patch still declares reasoningEfforts')
} else {
  const manifest = JSON.parse(read(manifestPath))
  if (manifest.dependencies?.[packageName] === undefined) problems.push('manifest is missing the dependency')
  if (!manifest.dsh?.profile?.bundles?.includes(packageName)) problems.push('manifest is missing the bundle selection')
  if (!isLink(linkPath)) problems.push(`${linkPath} is not a junction`)
  try {
    const resolved = createRequire(join(profileDir, 'package.json')).resolve(packageName)
    console.log(`\nresolved ${packageName} -> ${resolved}`)
  } catch (error) {
    problems.push(`the profile cannot resolve ${packageName}: ${error.code ?? error.message}`)
  }
  const declared = (read(patchPath).match(/reasoningEfforts:/g) ?? []).length
  console.log(`declared reasoningEfforts blocks: ${declared}`)
  if (declared === 0) problems.push('the profile patch declares no reasoningEfforts, so no reasoning level exists')
}

if (problems.length > 0) {
  console.error('\nverification failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nok. backups (if any) are under ${backupDir}`)
console.log('restart the Harness application so the profile is recomposed with the new bundle.')
