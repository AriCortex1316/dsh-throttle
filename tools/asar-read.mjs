// Minimal offline ASAR reader (no dependencies).
// Usage:
//   node tools/asar-read.mjs list <asarPath> [regexFilter]
//   node tools/asar-read.mjs cat  <asarPath> <innerPath>
//   node tools/asar-read.mjs extract <asarPath> <innerPrefix> <outDir>
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

function openAsar (asarPath) {
  const buf = readFileSync(asarPath)
  // [sizePickle: payloadSize=4][headerBufLen][headerPickle: payloadSize][stringLen][json][data...]
  const headerSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize))
  const dataOffset = 8 + headerSize
  return { buf, header, dataOffset }
}

function walk (node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? posix.join(prefix, name) : name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, size: entry.size || 0, offset: entry.offset, unpacked: !!entry.unpacked })
  }
  return out
}

function readEntry (asar, entry) {
  if (entry.unpacked) {
    const unpackedPath = asar.path + '.unpacked/' + entry.path.split('/').join('\\')
    return readFileSync(unpackedPath)
  }
  const start = asar.dataOffset + Number(entry.offset)
  return asar.buf.subarray(start, start + entry.size)
}

const [cmd, asarPath, ...rest] = process.argv.slice(2)
const asar = openAsar(asarPath)

if (cmd === 'list') {
  const filter = rest[0] ? new RegExp(rest[0]) : null
  for (const f of walk(asar.header, '', [])) {
    if (!filter || filter.test(f.path)) console.log(`${f.size}\t${f.unpacked ? 'U' : ' '}\t${f.path}`)
  }
} else if (cmd === 'cat') {
  const target = rest[0].replace(/\\/g, '/')
  const entry = walk(asar.header, '', []).find(f => f.path === target)
  if (!entry) { console.error('not found: ' + target); process.exit(2) }
  entry.path = target
  process.stdout.write(readEntry(asar, entry))
} else if (cmd === 'extract') {
  const prefix = rest[0].replace(/\\/g, '/').replace(/\/$/, '') + '/'
  const outDir = rest[1]
  let n = 0
  for (const f of walk(asar.header, '', [])) {
    if (!f.path.startsWith(prefix)) continue
    const rel = f.path.slice(prefix.length)
    const dest = join(outDir, ...rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    f.path = f.path
    writeFileSync(dest, readEntry(asar, f))
    n++
  }
  console.log(`extracted ${n} files to ${outDir}`)
} else {
  console.error('usage: list|cat|extract')
  process.exit(1)
}
