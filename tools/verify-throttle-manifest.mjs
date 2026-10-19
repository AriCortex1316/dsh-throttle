/**
 * Manifest + client-bundle contract check for `dsh-throttle`.
 *
 * The Harness reads this package's `package.json` before it activates anything
 * (`dsh-client-modules`'s scan, the Plugin Manager's display metadata, the
 * Loader's bundle patch), so a mistake here is a silent "no UI appears" rather
 * than a crash. This script re-checks every field those readers require, using
 * only the plugin's own files — no Harness runtime and no npm dependencies.
 *
 * Usage: node tools/verify-throttle-manifest.mjs
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', 'dsh-throttle')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

let failed = 0
/** Assert one contract, printing the outcome either way. */
function check (label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const exists = (relative) => {
  try {
    return statSync(join(pluginDir, relative)).isFile()
  } catch {
    return false
  }
}

// ── the Loader row and the bundle patch ──────────────────────────────────────
check('the package is an ESM plugin package', manifest.type === 'module' && typeof manifest.main === 'string' && exists(manifest.main))
check('the bundle patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml' && exists('cordis.patch.yml'))
const patch = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
check('the patch inserts the throttle row', /- insert:/.test(patch) && /id: throttle/.test(patch) && /name: 'dsh-throttle'/.test(patch))

// 拆分后的 Host 模块必须随包交付；检查实际相对 import 的完整依赖链。
const shipped = (file) => (manifest.files ?? []).some((entry) => entry === file || (entry.endsWith('/') && file.startsWith(entry)))
const visited = new Set()
function checkHostModule (file) {
  if (visited.has(file)) return
  visited.add(file)
  check(`Host 模块存在且纳入交付：${file}`, exists(file) && shipped(file))
  if (!exists(file)) return
  const source = readFileSync(join(pluginDir, file), 'utf8')
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue
    const dependency = resolve(dirname(join(pluginDir, file)), match[1])
    checkHostModule(relative(pluginDir, dependency).split('\\').join('/'))
  }
}
checkHostModule('index.js')

// ── the browser half: what dsh-client-modules scans ──────────────────────────
const client = manifest.dsh?.client
check('dsh.client declares the web platform', client?.platform === 'web', JSON.stringify(client))
check('dsh.client lists the packages it needs at activation', Array.isArray(client?.inject) && client.inject.length > 0)
check('a ./client export is declared', manifest.exports?.['./client'] === './client.js')
check('the client bundle exists', exists('client.js'))
check('the client bundle is shipped in files', (manifest.files ?? []).includes('client.js'))

const clientSource = readFileSync(join(pluginDir, 'client.js'), 'utf8')
const idMatch = clientSource.match(/window\.__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/)
check('the browser factory is registered', idMatch !== null)
check('the factory id equals the package name (the graph row attaches by it)', idMatch?.[1] === manifest.name, idMatch?.[1])

/**
 * The shell's frozen module table (apps/web's `staticModules`): everything else
 * must be declared under `dsh.client.external` or the factory throws at
 * materialization.
 */
const STATIC_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
])
const requested = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
const undeclared = requested.filter((specifier) => !STATIC_MODULES.has(specifier) && !(manifest.dsh?.client?.external ?? []).includes(specifier))
check('every module the browser half requires resolves', undeclared.length === 0, `unresolved: ${undeclared.join(', ') || 'none'}; requested: ${requested.join(', ')}`)

// ── the display metadata the Plugin Manager reads without activating ─────────
check('the icon is declared and shipped', typeof manifest.icon === 'string' && exists(manifest.icon) && (manifest.files ?? []).includes('icon.svg'))
const iconBytes = statSync(join(pluginDir, 'icon.svg')).size
check('the icon is inside the 256 KiB limit', iconBytes <= 256 * 1024, `${iconBytes} bytes`)
for (const locale of ['en', 'zh']) {
  const rel = `locale/${locale}.json`
  check(`the ${locale} locale ships`, exists(rel) && (manifest.files ?? []).includes('locale/*.json'))
  const dict = JSON.parse(readFileSync(join(pluginDir, rel), 'utf8'))
  check(`the ${locale} locale carries meta.title/description`,
    typeof dict.meta?.title === 'string' && dict.meta.title.length > 0 &&
    typeof dict.meta?.description === 'string' && dict.meta.description.length > 0)
}

// ── what the profile-resolution router needs to hand out installation deps ───
const peers = Object.keys(manifest.peerDependencies ?? {})
check('the settings Config dependency (schemastery) is a declared peer', peers.includes('@deepseek-ai/schemastery'), peers.join(', '))
check('the projection wire dependency (zod) is a declared peer', peers.includes('zod'), peers.join(', '))

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
