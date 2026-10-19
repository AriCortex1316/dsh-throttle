import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 在独立临时目录加载插件，使用调用方指定的 Harness schema 依赖。 */
export async function loadThrottleSchema (schemaDir, zodDir) {
  if (!schemaDir || !zodDir) throw new Error('需要同时传入 <schemasteryDir> 和 <zodDir>')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-throttle-schema-'))
  const pluginDir = join(scratch, 'plugin')
  try {
    mkdirSync(pluginDir)
    const sourceDir = resolve(import.meta.dirname, '..', 'dsh-throttle')
    for (const file of ['index.js', 'state.js', 'schemas.js', 'lib', 'package.json']) {
      cpSync(join(sourceDir, file), join(pluginDir, file), { recursive: true })
    }
    const schemaPath = join(pluginDir, 'schemas.js')
    let source = readFileSync(schemaPath, 'utf8')
    const entries = [
      ['@deepseek-ai/schemastery', join(resolve(schemaDir), 'lib', 'index.mjs')],
      ['zod', join(resolve(zodDir), 'index.js')]
    ]
    for (const [specifier, entry] of entries) {
      const token = `await import('${specifier}')`
      if (!source.includes(token)) throw new Error(`schema 探针找不到依赖入口：${specifier}`)
      source = source.replace(token, `await import(${JSON.stringify(pathToFileURL(entry).href)})`)
    }
    writeFileSync(schemaPath, source)
    const schemastery = (await import(pathToFileURL(entries[0][1]).href)).default
    const plugin = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
    const state = await import(pathToFileURL(join(pluginDir, 'state.js')).href)
    return { schemastery, plugin, state }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
