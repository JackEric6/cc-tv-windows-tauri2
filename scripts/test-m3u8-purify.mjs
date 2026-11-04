import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/main/services/m3u8Purify.ts', import.meta.url))
const { outputFiles } = await build({
  entryPoints: [source],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false
})
const { purifyM3u8 } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

const appendSegment = (index, duration) => [
  `#EXTINF:${duration.toFixed(3)},`,
  `https://cdn.example/shared/${index}.ts?sig=opaque`
]

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

function getUris(input, baseUrl = 'https://cdn.example/shared/index.m3u8') {
  const output = purifyM3u8(baseUrl, input)
  assert.ok(output.startsWith('#EXTM3U\n'))
  return output.split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
}

function appendGroup(lines, durations, startIndex) {
  lines.push('#EXT-X-DISCONTINUITY')
  durations.forEach((duration, index) => lines.push(...appendSegment(startIndex + index, duration)))
}

function makeAndroidRulePlaylist() {
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
assert.equal(markedUris.some((uri) => /\/(?:10[5-9]|11[0-3])\.ts\?/.test(uri)), false)
assert.equal(markedUris[104], 'https://cdn.example/shared/104.ts?sig=opaque')
assert.equal(markedUris[105], 'https://cdn.example/shared/114.ts?sig=opaque')

const androidCueUris = getUris(makePlaylist(false))
assert.equal(androidCueUris.length, 710, 'applies Android VOD cadence grouping without explicit cue tags')
assert.equal(androidCueUris.some((uri) => /\/(?:10[5-9]|11[0-3])\.ts\?/.test(uri)), false)

const androidRuleUris = getUris(makeAndroidRulePlaylist())
assert.equal(androidRuleUris.length, 303, 'applies Android cadence outlier rules to both short discontinuity groups')
assert.ok(androidRuleUris.some((uri) => /\/102\.ts\?/.test(uri)))
assert.ok(androidRuleUris.some((uri) => /\/112\.ts\?/.test(uri)))
assert.equal(androidRuleUris.some((uri) => /\/(?:103|104|105|106|107|108|109|110|111)\.ts\?/.test(uri)), false)
assert.equal(androidRuleUris.some((uri) => /\/(?:212|213|214|215|216|217|218|219)\.ts\?/.test(uri)), false)

const androidBaseUrl = 'https://cdn.example/20250425/15110_777125b9/index.m3u8'
const baseIndependentUris = getUris(makeAndroidRulePlaylist(), androidBaseUrl)
assert.equal(baseIndependentUris.length, 303, 'uses Android playlist rules independent of a single hard-coded path')

function playlist(segments, { endList = true } = {}) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    ...segments.flatMap(({ uri, duration = 6, discontinuity = false, marker = '' }) => [
      ...(discontinuity ? ['#EXT-X-DISCONTINUITY'] : []),
      ...(marker ? [marker] : []),
      `#EXTINF:${duration.toFixed(3)},`,
      uri
    ]),
    ...(endList ? ['#EXT-X-ENDLIST'] : [])
  ].join('\n')
}

function numbered(prefix, count, duration = 6) {
  return Array.from({ length: count }, (_, index) => ({
    uri: `${prefix}${String(index + 1).padStart(5, '0')}.ts`,
    duration
  }))
}

const urlFiltered = playlist([
  ...numbered('https://media.example/movie/seg-', 30),
  { uri: 'https://ads.example/ad/spot-00001.ts', duration: 6 }
])
const cleanUrlFiltered = purifyM3u8('https://media.example/movie/index.m3u8', urlFiltered)
assert.doesNotMatch(cleanUrlFiltered, /ads\.example/)
assert.equal((cleanUrlFiltered.match(/#EXTINF:/g) ?? []).length, 30)

const urlThresholdPlaylist = playlist([
  ...numbered('https://media.example/threshold/main-', 5),
  ...numbered('https://media.example/threshold/other-', 3)
])
assert.equal(
  purifyM3u8('https://media.example/threshold/index.m3u8', urlThresholdPlaylist),
  urlThresholdPlaylist
)

const cueFiltered = playlist([
  ...numbered('https://media.example/cue/pre-', 2),
  { uri: 'https://media.example/cue/ad-1.ts', marker: '#EXT-X-CUE-OUT:12' },
  { uri: 'https://media.example/cue/ad-2.ts' },
  { uri: 'https://media.example/cue/post-00001.ts', marker: '#EXT-X-CUE-IN' },
  ...numbered('https://media.example/cue/post-', 18).slice(1)
])
const cleanCueFiltered = purifyM3u8('https://media.example/cue/index.m3u8', cueFiltered)
assert.doesNotMatch(cleanCueFiltered, /ad-[12]\.ts/)
assert.match(cleanCueFiltered, /post-00001\.ts/)
assert.match(cleanCueFiltered, /#EXT-X-ENDLIST/)

const excessiveCuePlaylist = playlist([
  ...numbered('https://media.example/safety/main-', 1),
  { uri: 'https://media.example/safety/ad-1.ts', marker: '#EXT-X-CUE-OUT:18' },
  { uri: 'https://media.example/safety/ad-2.ts' },
  { uri: 'https://media.example/safety/ad-3.ts' },
  { uri: 'https://media.example/safety/post-00001.ts', marker: '#EXT-X-CUE-IN' }
])
assert.equal(
  purifyM3u8('https://media.example/safety/index.m3u8', excessiveCuePlaylist),
  excessiveCuePlaylist
)

const cadenceFiltered = playlist([
  ...numbered('https://media.example/vod/seg-', 12),
  ...numbered('https://media.example/vod/seg-', 3, 3.8).map((item, index) => ({
    ...item,
    uri: `https://media.example/vod/seg-${String(index + 13).padStart(5, '0')}.ts`,
    discontinuity: index === 0
  })),
  ...numbered('https://media.example/vod/seg-', 12).map((item, index) => ({
    ...item,
    uri: `https://media.example/vod/seg-${String(index + 16).padStart(5, '0')}.ts`,
    discontinuity: index === 0
  }))
])
const cleanCadenceFiltered = purifyM3u8('https://media.example/vod/index.m3u8', cadenceFiltered)
assert.equal((cleanCadenceFiltered.match(/#EXTINF:/g) ?? []).length, 24)
assert.doesNotMatch(cleanCadenceFiltered, /seg-00013\.ts|seg-00014\.ts|seg-00015\.ts/)

const markerlessProgram = playlist([
  ...numbered('https://media.example/program/seg-', 6, 6.1),
  ...numbered('https://media.example/program/seg-', 3, 3.8).map((item, index) => ({
    ...item,
    uri: `https://media.example/program/seg-${String(index + 7).padStart(5, '0')}.ts`,
    discontinuity: index === 0
  })),
  ...numbered('https://media.example/program/seg-', 6, 6.1).map((item, index) => ({
    ...item,
    uri: `https://media.example/program/seg-${String(index + 10).padStart(5, '0')}.ts`,
    discontinuity: index === 0
  }))
])
const keptProgram = purifyM3u8('https://media.example/program/index.m3u8', markerlessProgram)
assert.match(keptProgram, /seg-00007\.ts/)

console.log('Android M3U8 净化回归检查通过：原有播放列表样例、URL/CUE/时间节奏过滤及安卓分组规则。')
