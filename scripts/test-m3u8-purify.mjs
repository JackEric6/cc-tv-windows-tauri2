import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../src/main/services/m3u8Purify.ts', import.meta.url), 'utf8')
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const module = { exports: {} }
new Function('module', 'exports', compiled)(module, module.exports)
const { purifyM3u8 } = module.exports

const appendSegment = (index, duration) => {
  return [`#EXTINF:${duration.toFixed(3)},`, `https://cdn.example/shared/${index}.ts?sig=opaque`]
}

const adDurations = [4.08, 4.12, 4.08, 4.12, 4.08, 4.12, 4.08, 4.12, 4.08]
function makePlaylist(markAd) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD']
  for (let i = 0; i < 105; i++) lines.push(...appendSegment(i, 4))
  if (markAd) lines.push('#EXT-X-CUE-OUT:36.8')
  lines.push('#EXT-X-DISCONTINUITY')
  adDurations.forEach((duration, i) => lines.push(...appendSegment(105 + i, duration)))
  if (markAd) lines.push('#EXT-X-CUE-IN')
  lines.push('#EXT-X-DISCONTINUITY')
  for (let i = 114; i < 719; i++) lines.push(...appendSegment(i, 4))
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

function getUris(input) {
  const output = purifyM3u8('https://cdn.example/shared/index.m3u8', input)
  assert.ok(output.startsWith('#EXTM3U\n'))
  assert.ok(output.endsWith('#EXT-X-ENDLIST'))
  return output.split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
}

function getUrisFor(baseUrl, input) {
  const output = purifyM3u8(baseUrl, input)
  assert.ok(output.startsWith('#EXTM3U\n'))
  return output.split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
}

function appendGroup(lines, durations, startIndex) {
  lines.push('#EXT-X-DISCONTINUITY')
  durations.forEach((duration, index) => lines.push(...appendSegment(startIndex + index, duration)))
}

function makeConfirmedAdPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:8', '#EXT-X-PLAYLIST-TYPE:VOD']
  appendGroup(lines, [...Array(73).fill(4), 7.6], 0)
  appendGroup(lines, [...Array(28).fill(4), 0.8], 74)
  appendGroup(lines, [4.12, 4.12, 4.08, 4.12, 4.08, 4.12, 4.08, 4.12, 4.12], 103)
  appendGroup(lines, Array(100).fill(4), 112)
  appendGroup(lines, [4.24, 4.2, 4.2, 4.24, 4.2, 4.2, 4.2, 4.24], 212)
  appendGroup(lines, Array(100).fill(4), 220)
  return lines.join('\n')
}

const markedUris = getUris(makePlaylist(true))
assert.equal(markedUris.length, 710, 'removes the nine explicitly marked ad segments')
assert.equal(markedUris.some((uri) => /\/(?:10[5-9]|11[0-3])\.ts\?/.test(uri)), false, 'removes the marked ad interval')
assert.equal(markedUris[104], 'https://cdn.example/shared/104.ts?sig=opaque', 'keeps the segment before the ad')
assert.equal(markedUris[105], 'https://cdn.example/shared/114.ts?sig=opaque', 'resumes at the first segment after the ad')

const unmarkedUris = getUris(makePlaylist(false))
assert.equal(unmarkedUris.length, 719, 'preserves unmarked content with a different segment cadence')
assert.ok(unmarkedUris.some((uri) => /\/105\.ts\?/.test(uri)), 'does not discard the first ambiguous segment')
assert.ok(unmarkedUris.some((uri) => /\/113\.ts\?/.test(uri)), 'does not discard the last ambiguous segment')

const confirmedBaseUrl = 'https://cdn.example/20250425/15110_777125b9/index.m3u8'
const confirmedInput = makeConfirmedAdPlaylist()
const confirmedUris = getUrisFor(confirmedBaseUrl, confirmedInput)
assert.equal(confirmedUris.length, 311, 'removes only the nine confirmed inserted-ad segments')
const confirmedAdUris = new Set(Array.from({ length: 9 }, (_, index) => `https://cdn.example/shared/${103 + index}.ts?sig=opaque`))
assert.equal(confirmedUris.some((uri) => confirmedAdUris.has(uri)), false, 'removes the confirmed ad group')
assert.equal(confirmedUris[102], 'https://cdn.example/shared/102.ts?sig=opaque', 'keeps the segment before the ad')
assert.equal(confirmedUris[103], 'https://cdn.example/shared/112.ts?sig=opaque', 'keeps the first segment after the ad')
assert.ok(confirmedUris.some((uri) => /\/212\.ts\?/.test(uri)), 'preserves the separate ambiguous discontinuity group')

const sameContentOtherPath = getUrisFor('https://cdn.example/other/index.m3u8', confirmedInput)
assert.equal(sameContentOtherPath.length, 320, 'preserves the same unmarked segments on other playlists')

console.log('M3U8 purifier regressions passed: explicit and confirmed ad groups are removed; ambiguous content is preserved.')
