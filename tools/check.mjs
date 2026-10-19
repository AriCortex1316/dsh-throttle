import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')

function sources (directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:js|mjs)$/.test(entry.name) ? [path] : []
  })
}

function run (args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// 仅读取插件与工具源码，避免将本地 reference/、backup/ 纳入检查。
const files = [...sources(join(root, 'dsh-throttle')), ...sources(join(root, 'tools'))]
for (const file of files) run(['--check', file])
console.log(`语法检查通过：${files.length} 个文件`)
const tests = sources(join(root, 'dsh-throttle', 'test')).filter((file) => file.endsWith('.test.mjs'))
run(['--test', ...tests])
for (const file of ['verify-throttle-manifest.mjs', 'probe-throttle-client.mjs', 'probe-throttle-ceilings.mjs']) {
  console.log(`\n运行 ${relative(root, join(root, 'tools', file))}`)
  run([join(root, 'tools', file)])
}
console.log('\n离线检查通过；真实 schema 依赖检查和 Harness 界面验收需单独运行。')
