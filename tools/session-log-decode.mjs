// Decode a DSH JSONL session log (`session.v*.jsonl.zstd`) into plain JSONL.
//
// The backend stores a concatenated-frame Zstandard container: each frame is
// independently decodable and the final frame may be torn (still being
// appended). `node:zlib`'s one-shot `zstdDecompressSync` only accepts a single
// frame, so this walks the frames the same way the persistence backend's
// `scanZstdFrames` does, then decodes each frame on its own.
//
// This module is the single copy of that scan: `tools/scan-sessions.mjs`,
// `tools/read-session.mjs`, and `tools/session-budget-report.mjs` all import it.
//
// Usage: node tools/session-log-decode.mjs <in.jsonl.zstd> [out.jsonl]
import { constants, zstdDecompressSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = 4247762216

/**
 * Locate structurally complete frames; report an EOF-torn final frame.
 * @param buffer - the artifact's bytes.
 * @returns complete `{ start, end }` frame ranges, plus `tornStart` when the
 *   final frame is still being written.
 */
export function scanZstdFrames (buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode a whole session artifact.
 * @param input - path to a `.jsonl.zstd` artifact, or any plaintext `.jsonl`.
 * @returns the plaintext, the complete-frame count, and whether a final frame
 *   was torn (recovered under `ZSTD_e_flush`).
 */
export function decodeSessionArtifact (input) {
  const buffer = readFileSync(input)
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return { text: buffer.toString('utf8'), frames: 0, torn: false }
  const { frames, tornStart } = scanZstdFrames(buffer)
  const parts = []
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch (error) {
      console.error(`frame at byte ${start} failed to decode: ${error.message}`)
    }
  }
  if (tornStart !== undefined) {
    // A final frame that is still being written: recover what it already holds.
    try {
      parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }))
    } catch { /* nothing recoverable yet */ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, torn: tornStart !== undefined }
}

/**
 * Decode a session artifact into plaintext JSONL.
 * @param input - path to the artifact.
 * @returns the artifact's plaintext.
 */
export function decodeSessionLog (input) {
  return decodeSessionArtifact(input).text
}

/**
 * Parse an artifact into committed events.
 * @param input - path to the artifact.
 * @returns the events, in log order.
 */
export function readSessionEvents (input) {
  return decodeSessionLog(input).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2)
  if (input === undefined) {
    console.error('usage: node tools/session-log-decode.mjs <in.jsonl.zstd> [out.jsonl]')
    process.exit(2)
  }
  const { text, frames, torn } = decodeSessionArtifact(input)
  if (output === undefined) process.stdout.write(text)
  else {
    writeFileSync(output, text)
    console.error(`decoded ${frames} frame(s)${torn ? ' + 1 torn' : ''} → ${text.split('\n').filter((line) => line !== '').length} line(s) → ${output}`)
  }
}
