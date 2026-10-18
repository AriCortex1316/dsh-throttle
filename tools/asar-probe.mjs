import { readFileSync } from 'node:fs'
const p = process.argv[2]
const b = readFileSync(p)
console.log('file size', b.length)
console.log('first 48 bytes hex:', b.subarray(0, 48).toString('hex'))
for (const off of [0, 4, 8, 12]) console.log(`u32@${off} =`, b.readUInt32LE(off))
console.log('ascii@12:', JSON.stringify(b.toString('utf8', 12, 120)))
console.log('ascii@8 :', JSON.stringify(b.toString('utf8', 8, 116)))
console.log('ascii@16:', JSON.stringify(b.toString('utf8', 16, 124)))
