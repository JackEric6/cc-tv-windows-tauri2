import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../src/main/services/m3u8Purify.ts', import.meta.url), 'utf8')
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const module = { exports: {} }
new Function('module', 'exports', compiled)(module, module.exports)
const { purifyM3u8 } = module.exports

const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD']
const appendSegment = (index, duration) => {
  lines.push(`#EXTINF:${duration.toFixed(3)},`, `https://cdn.example/shared/${index}.ts?sig=opaque`)
}

for (let i = 0; i < 105; i++) appendSegment(i, 4)
lines.push('#EXT-X-DISCONTINUITY')
const adDurations = [4.08, 4.12, 4.08, 4.12, 4.08, 4.12, 4.08, 4.12, 4.08]
adDurations.forEach((duration, i) => appendSegment(105 + i, duration))
lines.push('#EXT-X-DISCONTINUITY')
for (let i = 114; i < 719; i++) appendSegment(i, 4)
lines.push('#EXT-X-ENDLIST')

const input = lines.join('\n')
const output = purifyM3u8('https://cdn.example/shared/index.m3u8', input)
const uris = output.split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
assert.equal(uris.length, 710, 'removes only the nine short cadence outlier segments')
assert.equal(uris.some((uri) => /\/(?:10[5-9]|11[0-3])\.ts\?/.test(uri)), false, 'removes the ad interval')
assert.equal(uris[104], 'https://cdn.example/shared/104.ts?sig=opaque', 'keeps the segment before the ad')
assert.equal(uris[105], 'https://cdn.example/shared/114.ts?sig=opaque', 'keeps and resumes at the first segment after the ad')
assert.ok(output.startsWith('#EXTM3U\n'))
assert.ok(output.endsWith('#EXT-X-ENDLIST'))

console.log('M3U8 purifier regression passed: 9 ad segments removed; 710 media segments remain.')
