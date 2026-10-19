#!/usr/bin/env node
/**
 * Read one DSH session log as a readable transcript.
 *
 * Usage: node tools/read-session.mjs <session-id-or-path-substring> [--raw] [--limit N]
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSessionLog } from './session-log-decode.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = join(home, 'sessions')
const needle = process.argv[2] ?? ''
const raw = process.argv.includes('--raw')
const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex === -1 ? 40 : Number(process.argv[limitIndex + 1])

/** Every `session.*.zstd` under the sessions root, newest first. */
function walk (dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.name.startsWith('session.') && entry.name.endsWith('.zstd')) out.push(path)
  }
  return out
}

const files = walk(root).filter((path) => path.includes(needle))
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
if (files.length === 0) {
  console.error(`no session log matches "${needle}"`)
  process.exit(1)
}
const path = files[0]
const records = decodeSessionLog(path)
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { type: '(unparsed)', raw: line.slice(0, 200) }
    }
  })

console.log(`session log: ${path}\nrecords: ${records.length}\n`)

/** Render one record as transcript text. */
function render (record) {
  const data = record.data ?? {}
  switch (record.type) {
    case 'session':
      return `SESSION cwd=${data.cwd} preset=${data.agentPreset}`
    case 'user/message':
      return `\n>>> USER\n${textOf(data)}`
    case 'assistant/message':
      return `\n<<< ASSISTANT\n${textOf(data)}`
    case 'system/message':
      return `\n=== SYSTEM MESSAGE (sourced ${data.source ?? '?'})\n${textOf(data).slice(0, Number.isFinite(limit) ? limit * 40 : 2000)}`
    case 'command/run':
      return `\n--- COMMAND /${data.name} args=${JSON.stringify(data.args)}`
    case 'command/done':
      return `--- COMMAND DONE kind=${data.kind}`
    case 'permission/preset':
      return `--- PERMISSION PRESET -> ${data.preset}`
    case 'sandbox/mode':
      return `--- SANDBOX MODE -> ${data.mode}`
    case 'approval/policy':
      return `--- APPROVAL POLICY -> ${JSON.stringify(data.policy ?? data)}`
    case 'tool/call':
      return `  [tool] ${data.name} ${JSON.stringify(data.arguments ?? data.args ?? {}).slice(0, 240)}`
    case 'tool/result': {
      const text = textOf(data)
      const denied = /denied|not permitted|ceiling is reached|tier ceiling/.test(text)
      return `  [result${denied ? ' !!DENIED/REFUSED' : ''}] ${text.replace(/\s+/g, ' ').slice(0, 300)}`
    }
    default:
      return undefined
  }
}

/** Best-effort text extraction from a message record. */
function textOf (data) {
  const content = data.content ?? data.message?.content ?? data.text ?? data.messages
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? JSON.stringify(part)))
      .join('\n')
  }
  return JSON.stringify(data).slice(0, 400)
}

let printed = 0
for (const record of records) {
  const line = raw ? JSON.stringify(record).slice(0, limit * 40) : render(record)
  if (line === undefined) continue
  console.log(line)
  printed += 1
}
console.log(`\n(${printed} rendered records)`)
