// Reconstruct where a dsh-throttle budget number came from, from the session log
// itself: every injected `throttle:state` snapshot is a persisted `user/message`,
// so the rendered text plus the event time let us solve for the usage record
// the plugin was holding when it rendered that line.
//
// Usage: node tools/session-budget-report.mjs <session.v4.jsonl.zstd | session.jsonl>
import { readSessionEvents } from './session-log-decode.mjs'

const iso = (time) => new Date(time).toISOString().replace('T', ' ').slice(0, 23)
const minutesOf = (text, pattern) => {
  const match = pattern.exec(text)
  return match === null ? null : Number(match[2])
}

/** The budget line a snapshot carries, if any. */
function budgetLine (text) {
  const progress = /This turn: (?:(\d+)\/(\d+) tool calls|step (\d+)\/(\d+)) · ([\d.]+)\/([\d.]+) min\./.exec(text)
  if (progress !== null) {
    const used = progress[1] ?? `step ${progress[3]}`
    return { kind: 'progress', display: progress[0], used, minutes: Number(progress[5]), ceiling: Number(progress[6]) }
  }
  const minutes = /the ([\d.]+)-minute ceiling is reached \(([\d.]+) min spent\)/.exec(text)
  if (minutes !== null) return { kind: 'exhausted', display: minutes[0], minutes: Number(minutes[2]), ceiling: Number(minutes[1]) }
  const calls = /the (\d+)-tool-call ceiling is reached/.exec(text)
  if (calls !== null) return { kind: 'exhausted', display: calls[0], used: calls[1] }
  const steps = /the (\d+)-step ceiling is reached \(now on step (\d+)\)/.exec(text)
  if (steps !== null) return { kind: 'exhausted', display: steps[0] }
  return null
}

const [input] = process.argv.slice(2)
if (input === undefined) {
  console.error('usage: node tools/session-budget-report.mjs <session.v4.jsonl.zstd|session.jsonl>')
  process.exit(2)
}

const events = readSessionEvents(input)
const header = events[0]
console.log(`session   ${header.id}`)
console.log(`cwd       ${header.cwd}`)
console.log(`created   ${iso(header.createdAt)}`)

/** Turn boundaries, so a solved start time can be attributed to a turn. */
const turns = []
for (const event of events) {
  if (event.type === 'turn/start') turns.push({ turn: event.data.turn, start: event.time, end: null, toolCalls: 0 })
  if (event.type === 'tool/call') { const open = turns[turns.length - 1]; if (open !== undefined) open.toolCalls += 1 }
  if (event.type === 'turn/end') { const open = turns[turns.length - 1]; if (open !== undefined) open.end = event.time }
}
const turnOfTime = (time) => {
  let found = null
  for (const turn of turns) if (turn.start <= time) found = turn
  return found
}

console.log('\nturns')
for (const turn of turns) {
  const wall = turn.end === null ? null : (turn.end - turn.start) / 1000
  console.log(`  turn ${turn.turn}  ${iso(turn.start)} → ${turn.end === null ? 'open' : iso(turn.end)}  wall=${wall === null ? '?' : wall.toFixed(1)}s  tool/call=${turn.toolCalls}`)
}

console.log('\ninjected budget snapshots (rendered text → solved usage record)')
for (const [index, event] of events.entries()) {
  if (event.type !== 'user/message') continue
  const text = (event.data?.content ?? []).map((part) => part.text ?? '').join('')
  if (!text.includes('[throttle:state]') && !text.includes("This turn's ceiling is spent")) continue
  const line = budgetLine(text)
  if (line === null) continue
  let solved = ''
  if (line.minutes !== undefined) {
    // `toFixed(1)` makes the display a rounding test rather than a search: a
    // turn's own start matches the line only if it reproduces the same rounded
    // minutes, so a line can be attributed to a turn exactly.
    const matches = (turn) => Number(((event.time - turn.start) / 60000).toFixed(1)) === line.minutes
    const current = turnOfTime(event.time)
    const own = current !== null && matches(current)
    const owner = own ? current : turns.find((turn) => matches(turn))
    const stale = !own && owner !== undefined
    solved = owner === undefined
      ? 'no turn start reproduces this number — record not from a turn boundary'
      : `startedAt≈${iso(owner.start)} (turn ${owner.turn})${stale ? `  ⚠ STALE: rendered in turn ${current?.turn ?? '?'}` : ''}`
  }
  console.log(`  #${String(index).padStart(3)} seq=${String(event.seq).padStart(3)} ${iso(event.time)}  ${line.kind.padEnd(9)} ${line.display}`)
  if (solved !== '') console.log(`        ${solved}`)
}
