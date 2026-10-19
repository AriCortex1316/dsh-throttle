#!/usr/bin/env node
/**
 * Diagnostic: scan persisted DSH session logs (multi-frame Zstandard JSONL) for
 * what the model was actually told about the /throttle plugin, and for whether
 * every command actually settled.
 *
 * The pairing report is the one that matters for "the chip hangs": the badge
 * executes a real `/throttle …` line, so the log shows a `command/run` and, once
 * the host answers, a matching `command/done`. A run with **no** done is a
 * command the host never settled — which is exactly what leaves the panel's
 * switch disabled (`busy`) forever.
 *
 * Usage: node tools/scan-sessions.mjs [path-substring-filter]
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSessionArtifact } from './session-log-decode.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = join(home, 'sessions')
const filter = process.argv[2] ?? ''

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

const files = walk(root).filter((path) => path.includes(filter))
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

for (const path of files) {
  let text
  let frames
  try {
    ({ text, frames } = decodeSessionArtifact(path))
  } catch (error) {
    console.log(`!! ${path}: ${error.message}`)
    continue
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const types = new Map()
  for (const line of lines) {
    try {
      const type = JSON.parse(line).type ?? '(none)'
      types.set(type, (types.get(type) ?? 0) + 1)
    } catch {}
  }
  const has = (needle) => lines.filter((line) => line.includes(needle)).length
  const policy = lines.filter((line) => line.includes('Current DSH file policy'))
  const lastPolicy = policy.length === 0 ? undefined : /Current DSH file policy: [a-z-]+/.exec(policy.at(-1))?.[0]
  console.log(`\n=== ${path}`)
  console.log(`    mtime ${new Date(statSync(path).mtimeMs).toISOString()} · frames ${frames} · records ${lines.length}`)
  console.log(`    types: ${[...types].map(([t, n]) => `${t}×${n}`).join(' ')}`)
  console.log(`    [throttle] lines: ${has('[throttle]')} · policy lines: ${policy.length}${lastPolicy === undefined ? '' : ` (last: ${lastPolicy})`} · ceiling spent: ${has('ceiling is reached')} · sandbox denied: ${has('sandbox: file access denied')}`)
  for (const line of lines) {
    if (!line.includes('[throttle]')) continue
    const match = /\[throttle\][^"\\]{0,150}/.exec(line)
    if (match !== null) console.log(`    throttle section: ${match[0]}`)
    break
  }
  for (const line of lines) {
    if (!/"name":"throttle"/.test(line)) continue
    const args = /"args":"[^"]*"/.exec(line)?.[0] ?? ''
    const kind = /"kind":"[^"]*"/.exec(line)?.[0] ?? ''
    console.log(`    throttle command: ${args} ${kind}`)
  }
  reportCommandPairs(lines)
}
console.log(`\n${files.length} log(s) scanned`)

/**
 * Report every command the log opened, with the result the host wrote back and
 * whether it was closed at all.
 * @param lines - the decoded log lines.
 */
function reportCommandPairs (lines) {
  const open = new Map()
  const settled = []
  for (const [index, line] of lines.entries()) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const data = record.data
    if (record.type === 'command/run' && data?.name !== undefined) {
      const entry = { name: String(data.name), args: data.args ?? '', seq: record.seq, time: record.time, commandId: data.commandId }
      open.set(String(data.commandId), entry)
      settled.push(entry)
    } else if (record.type === 'command/done' && data?.commandId !== undefined) {
      const entry = open.get(String(data.commandId))
      if (entry !== undefined) {
        entry.result = `${data.kind}${data.text === undefined ? '' : ` ${JSON.stringify(String(data.text).slice(0, 80))}`}`
        open.delete(String(data.commandId))
      } else {
        settled.push({ name: '(unpaired done)', args: '', seq: record.seq, time: record.time, result: String(data.kind) })
      }
    }
    if (record.type === 'command/run' && data?.commandId === undefined) {
      settled.push({ name: String(data?.name), args: '', seq: record.seq, time: record.time, note: 'run without a commandId' })
    }
    void index
  }
  console.log(`    commands: ${settled.length} run(s)`)
  for (const entry of settled) {
    const when = entry.time === undefined ? '?' : new Date(entry.time).toISOString()
    console.log(`      ${entry.name} ${JSON.stringify(entry.args)}  -> ${entry.result ?? entry.note ?? 'NO command/done (UNSETTLED)'}  (seq=${entry.seq} ${when})`)
  }
}
