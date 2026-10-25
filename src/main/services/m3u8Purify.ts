const AD_URI = /(?:^|[/?&=_.-])(ads?|adv|advert(?:ise(?:ment)?)?|commercial|preroll|pre-roll|midroll|mid-roll|postroll|post-roll|sponsor|scte|vast|vmap|interstitial|bumper)(?:[/?&=_.-]|$)/i
const AD_HOST = /adservice|adserver|adsystem|doubleclick|googlesyndication|advertising|2mdn\.net|moatads|scorecardresearch|quantserve/i
const AD_TAG = /^#(?:EXT-OATCLS-SCTE35|EXT-X-SCTE35|EXT-X-SPLICEPOINT-SCTE35|EXT-X-ASSET|EXT-X-VMAP-AD-BREAK|EXT-X-AD)(?::|$)/i
const MAX_FRAME_RATE_AD_BLOCK_SIZE = 12

interface Segment {
  lines: string[]
  uri: string
  duration: number
  startOffset: number
  programDateTime: number | null
  durationPrecision: number
  discontinuity: boolean
  markedAd: boolean
  keyState: string
  mapState: string
}

interface AdDateRange {
  id: string
  startOffset: number
  startDate: number | null
  endDate: number | null
  duration: number | null
  ad: boolean
}

interface SegmentGroup {
  segments: Segment[]
  totalDuration: number
  host: string
  pathPrefix: string
  adLike: boolean
}

function uriIsAd(uri: string, baseUrl: string): boolean {
  try {
    const absolute = new URL(uri, baseUrl)
    return AD_URI.test(absolute.href) || AD_HOST.test(absolute.hostname)
  } catch {
    return AD_URI.test(uri)
  }
}

function extinf(line: string): { duration: number; precision: number } | null {
  const match = /^\s*#EXTINF:\s*([\d.]+)\s*(?:,|$)/i.exec(line)
  if (!match) return null
  const dot = match[1].indexOf('.')
  const duration = Number(match[1])
  return Number.isFinite(duration)
    ? { duration, precision: dot < 0 ? 0 : match[1].length - dot - 1 }
    : null
}

function attributeList(line: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const body = line.slice(line.indexOf(':') + 1)
  for (const match of body.matchAll(/(?:^|,)\s*([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi)) {
    attributes.set(match[1].toUpperCase(), match[2].replace(/^"|"$/g, '').trim())
  }
  return attributes
}

function secondsAttribute(attributes: Map<string, string>, name: string): number | null {
  const value = Number(attributes.get(name))
  return Number.isFinite(value) && value > 0 ? value : null
}

function isAdDateRange(attributes: Map<string, string>): boolean {
  const marker = `${attributes.get('ID') ?? ''} ${attributes.get('CLASS') ?? ''}`
  return AD_URI.test(marker) || attributes.has('SCTE35-OUT') || attributes.has('SCTE35-IN') || attributes.has('X-ASSET-URI')
}

function isAdMarkerLine(line: string): boolean {
  if (AD_TAG.test(line) || /^#EXT-X-CUE-(?:OUT|IN)/i.test(line)) return true
  return /^#EXT-X-DATERANGE:/i.test(line) && isAdDateRange(attributeList(line))
}

function mergeAdDateRange(ranges: Map<string, AdDateRange>, line: string, startOffset: number): void {
  if (!/^#EXT-X-DATERANGE:/i.test(line)) return
  const attributes = attributeList(line)
  const id = attributes.get('ID')
  if (!id) return
  const current = ranges.get(id) ?? {
    id,
    startOffset,
    startDate: null,
    endDate: null,
    duration: null,
    ad: false
  }
  const startDate = Date.parse(attributes.get('START-DATE') ?? '')
  const endDate = Date.parse(attributes.get('END-DATE') ?? '')
  if (Number.isFinite(startDate)) current.startDate = startDate
  if (Number.isFinite(endDate)) current.endDate = endDate
  current.duration = secondsAttribute(attributes, 'DURATION') ?? current.duration
  current.ad ||= isAdDateRange(attributes)
  ranges.set(id, current)
}

function totalUris(lines: string[]): number {
  return lines.filter((line) => line.trim() && !line.trimStart().startsWith('#')).length
}

function totalDuration(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.duration, 0)
}

function buildGroups(segments: Segment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = []
  let current: Segment[] = []
  const flush = (): void => {
    if (!current.length) return
    const urls = current.map((segment) => {
      try { return new URL(segment.uri, 'https://playlist.invalid') } catch { return null }
    })
    const firstUrl = urls.find((url) => url !== null)
    groups.push({
      segments: current,
      totalDuration: current.reduce((sum, segment) => sum + segment.duration, 0),
      host: firstUrl?.host ?? '',
      pathPrefix: firstUrl ? firstUrl.pathname.slice(0, firstUrl.pathname.lastIndexOf('/') + 1) : '',
      adLike: current.some((segment) => segment.markedAd || uriIsAd(segment.uri, 'https://playlist.invalid'))
    })
    current = []
  }
  for (const segment of segments) {
    if (segment.discontinuity && current.length) flush()
    current.push(segment)
  }
  flush()
  return groups
}

function segmentLimit(segments: Segment[]): number {
  const minutes = totalDuration(segments) / 60
  if (minutes <= 30) return 18
  if (minutes <= 60) return 24
  if (minutes <= 90) return 30
  return 36
}

function markGroups(groups: SegmentGroup[], remove: Set<Segment>, predicate: (group: SegmentGroup, index: number) => boolean): number {
  let count = 0
  groups.forEach((group, index) => {
    if (!predicate(group, index)) return
    for (const segment of group.segments) {
      if (!remove.has(segment)) {
        remove.add(segment)
        count++
      }
    }
  })
  return count
}

function removeDecimalPrecisionGroups(segments: Segment[], remove: Set<Segment>, originalCount: number): void {
  const remaining = segments.filter((segment) => !remove.has(segment))
  const groups = buildGroups(remaining)
  const precisionCounts = new Map<number, number>()
  let measuredCount = 0
  for (const segment of remaining) {
    if (segment.durationPrecision < 0) continue
    measuredCount++
    precisionCounts.set(segment.durationPrecision, (precisionCounts.get(segment.durationPrecision) ?? 0) + 1)
  }
  if (groups.length < 2 || measuredCount < 8 || precisionCounts.size < 2) return

  const dominant = [...precisionCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!dominant || dominant[1] / measuredCount < 0.7) return
  const candidateGroups = groups.filter((group, index) => index !== groups.length - 1 &&
    group.segments.length > 0 && group.segments.length <= MAX_FRAME_RATE_AD_BLOCK_SIZE)
  const toRemove = candidateGroups.filter((group) => {
    const precisions = group.segments.map((segment) => segment.durationPrecision).filter((value) => value >= 0)
    return precisions.length > 0 && precisions.every((precision) => precision !== dominant[0])
  })
  const count = toRemove.reduce((sum, group) => sum + group.segments.length, 0)
  if (!count || count > segmentLimit(remaining) || count > originalCount * 0.3) return
  markGroups(groups, remove, (group, index) => toRemove.includes(group) && index !== groups.length - 1)
}

function canonicalDecimal(value: number, scale: number): string {
  return String(Number(value.toFixed(scale)))
}

function frameRateFeatures(frameRate: number, ntsc: boolean): Set<string> {
  const features = new Set<string>()
  const add = (rate: number, maxFrames: number): void => {
    for (let frame = 1; frame <= maxFrames; frame++) {
      const fraction = (frame / rate) % 1
      for (let scale = 3; scale <= 6; scale++) {
        const value = canonicalDecimal(fraction, scale)
        if (value !== '0') features.add(value)
      }
    }
  }
  add(frameRate, frameRate)
  if (ntsc) add(frameRate / 1.001, frameRate * 10)
  return features
}

const FRAME_RATE_FEATURES = new Map<number, Set<string>>([
  [30, frameRateFeatures(30, true)],
  [25, frameRateFeatures(25, false)],
  [24, frameRateFeatures(24, true)]
])

function exclusiveFrameRate(duration: number): number {
  const fraction = Math.abs(duration % 1)
  const matches = [...FRAME_RATE_FEATURES.entries()].filter(([, features]) =>
    [3, 4, 5, 6].some((scale) => features.has(canonicalDecimal(fraction, scale)))
  ).map(([rate]) => rate)
  return matches.length === 1 ? matches[0] : 0
}

function removeFrameRateGroups(segments: Segment[], remove: Set<Segment>): void {
  const remaining = segments.filter((segment) => !remove.has(segment))
  const groups = buildGroups(remaining)
  if (groups.length < 2) return
  const frameCounts = new Map([[30, 0], [25, 0], [24, 0]])
  for (const segment of remaining) {
    const rate = exclusiveFrameRate(segment.duration)
    if (rate) frameCounts.set(rate, (frameCounts.get(rate) ?? 0) + 1)
  }
  const max = Math.max(...frameCounts.values())
  const dominantRates = [...frameCounts].filter(([, count]) => count === max).map(([rate]) => rate)
  if (max < 2 || dominantRates.length !== 1) return
  const dominantRate = dominantRates[0]
  const removable = groups.filter((group, index) => {
    if (index === groups.length - 1 || group.segments.length === 0 ||
      group.segments.length > MAX_FRAME_RATE_AD_BLOCK_SIZE) return false
    const matched = group.segments.filter((segment) => exclusiveFrameRate(segment.duration) === dominantRate).length
    const mismatched = group.segments.filter((segment) => {
      const rate = exclusiveFrameRate(segment.duration)
      return rate !== 0 && rate !== dominantRate
    }).length
    return mismatched > 0 && mismatched >= matched
  })
  const count = removable.reduce((sum, group) => sum + group.segments.length, 0)
  if (!count || count > segmentLimit(remaining)) return
  for (const group of removable) for (const segment of group.segments) remove.add(segment)
}

function removeUniformDurationGroups(segments: Segment[], remove: Set<Segment>, originalCount: number): void {
  const remaining = segments.filter((segment) => !remove.has(segment))
  const groups = buildGroups(remaining)
  if (groups.length < 4) return
  const cadences = groups.slice(0, -1).map((group) => {
    if (group.segments.length < 3 || group.segments.length > MAX_FRAME_RATE_AD_BLOCK_SIZE) return ''
    const first = group.segments[0].duration
    if (first <= 0 || !group.segments.every((segment) => segment.duration === first)) return ''
    return String(first)
  })
  const counts = new Map<string, number>()
  cadences.filter(Boolean).forEach((cadence) => counts.set(cadence, (counts.get(cadence) ?? 0) + 1))
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1]) || ranked[0][1] < 3) return
  const [mainCadence, mainCount] = ranked[0]
  const mainDuration = Number(mainCadence)
  const removable = groups.slice(0, -1).filter((group, index) => {
    const cadence = cadences[index]
    if (!cadence || cadence === mainCadence) return false
    const count = counts.get(cadence) ?? 0
    const duration = Number(cadence)
    return count >= 2 && count / mainCount <= 0.35 && duration > 1 && duration <= 10 &&
      Math.abs(duration - mainDuration) >= 0.05
  })
  const count = removable.reduce((sum, group) => sum + group.segments.length, 0)
  if (!count || count > segmentLimit(remaining) || count > originalCount * 0.3) return
  for (const group of removable) for (const segment of group.segments) remove.add(segment)
}

function removeDiscontinuityAdGroups(segments: Segment[], remove: Set<Segment>): void {
  const remaining = segments.filter((segment) => !remove.has(segment))
  const groups = buildGroups(remaining)
  if (groups.length < 3) return
  const main = groups.reduce((best, group) => {
    const score = group.totalDuration > 0 ? group.totalDuration : group.segments.length
    const bestScore = best.totalDuration > 0 ? best.totalDuration : best.segments.length
    return score > bestScore ? group : best
  })
  if (main.segments.length < 3) return
  for (const group of groups) {
    if (group === main || !group.segments.length) continue
    const shortGroup = group.segments.length <= 2 ||
      (main.totalDuration > 0 && group.totalDuration > 0 && group.totalDuration < main.totalDuration * 0.18)
    const differentHost = Boolean(main.host && group.host && main.host !== group.host)
    const differentPath = Boolean(main.pathPrefix && group.pathPrefix && main.pathPrefix !== group.pathPrefix)
    const adLike = group.adLike || differentHost || (group.segments.length <= 2 && differentPath)
    if (shortGroup && adLike) for (const segment of group.segments) remove.add(segment)
  }
}

function normalizeMediaPlaylist(lines: string[]): string[] {
  const output: string[] = []
  let seenMedia = false
  let pendingDiscontinuity = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      if (seenMedia && !pendingDiscontinuity) pendingDiscontinuity = raw
      continue
    }
    if (pendingDiscontinuity) {
      if (!line) continue
      if (line !== '#EXT-X-ENDLIST') output.push(pendingDiscontinuity)
      pendingDiscontinuity = ''
    }
    if (!line && output.length === 0) continue
    output.push(raw)
    if (line && !line.startsWith('#')) seenMedia = true
  }
  return output
}

function isPlayable(lines: string[]): boolean {
  let mediaCount = 0
  let pendingExtinf = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^#EXTINF:/i.test(line)) {
      if (pendingExtinf) return false
      pendingExtinf = true
    } else if (!line.startsWith('#')) {
      mediaCount++
      pendingExtinf = false
    } else if (line === '#EXT-X-ENDLIST' && pendingExtinf) {
      return false
    }
  }
  return mediaCount > 0 && !pendingExtinf
}

function appendState(output: string[], tag: string, current: string, next: string): string {
  if (current === next) return current
  if (next) output.push(next)
  else if (current) output.push(`${tag}:METHOD=NONE`)
  return next
}

/** Mirrors Android's conservative VOD segment-group filters while retaining HLS key/map state. */
export function purifyM3u8(baseUrl: string, input: string): string {
  const content = input.replace(/^\uFEFF/, '')
  if (!content.startsWith('#EXTM3U') || /#EXT-X-STREAM-INF/i.test(content)) return input

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const originalCount = totalUris(lines)
  if (!originalCount) return input

  const segments: Segment[] = []
  const leading: string[] = []
  let pending: string[] = []
  let activeKey = ''
  let activeMap = ''
  let inAdBreak = false
  let markedAd = false
  let adDiscontinuity = false
  let cueAdEndOffset: number | null = null
  let cueRemovedCount = 0
  let elapsed = 0
  let programDateTime: number | null = null
  let scteAdStart: number | null = null
  const adDateRanges = new Map<string, AdDateRange>()
  const scteAdIntervals: Array<{ start: number; end: number }> = []

  for (const raw of lines) {
    const line = raw.trim()
    if (/^#EXT-X-PROGRAM-DATE-TIME:/i.test(line)) {
      const timestamp = Date.parse(line.slice(line.indexOf(':') + 1))
      programDateTime = Number.isFinite(timestamp) ? timestamp : null
    }
    mergeAdDateRange(adDateRanges, line, elapsed)
    if (/^#EXT-X-DATERANGE:/i.test(line)) {
      const attributes = attributeList(line)
      if (attributes.has('SCTE35-OUT') && scteAdStart === null) scteAdStart = elapsed
      if (attributes.has('SCTE35-IN') && scteAdStart !== null) {
        scteAdIntervals.push({ start: scteAdStart, end: elapsed })
        scteAdStart = null
      }
    }
    if (/^#EXT-X-KEY:/i.test(line)) activeKey = raw
    if (/^#EXT-X-MAP:/i.test(line)) activeMap = raw

    if (line.startsWith('#EXT-X-CUE-IN')) {
      inAdBreak = false
      pending = adDiscontinuity ? ['#EXT-X-DISCONTINUITY'] : []
      adDiscontinuity = false
      continue
    }
    if (/^#EXT-X-CUE-OUT(?:-CONT)?(?::|$)/i.test(line)) {
      const attributes = attributeList(line)
      const rawDuration = line.match(/^#EXT-X-CUE-OUT:(\s*[\d.]+)/i)?.[1]
      const duration = secondsAttribute(attributes, 'DURATION') ?? Number(rawDuration)
      const elapsedTime = secondsAttribute(attributes, 'ELAPSEDTIME') ?? 0
      if (Number.isFinite(duration) && duration > 0) {
        cueAdEndOffset = elapsed + Math.max(0, duration - elapsedTime)
      }
      inAdBreak = true
      pending = []
      continue
    }
    if (inAdBreak) {
      if (line === '#EXT-X-ENDLIST') {
        pending.push(raw)
        inAdBreak = false
      } else if (line && !line.startsWith('#')) {
        cueRemovedCount++
        const durationInfo = extinf(pending.find((part) => /^\s*#EXTINF:/i.test(part)) ?? '')
        const duration = durationInfo?.duration ?? 0
        elapsed += duration
        if (programDateTime !== null) programDateTime += duration * 1000
        pending = []
        if (cueAdEndOffset !== null && elapsed >= cueAdEndOffset) {
          inAdBreak = false
          cueAdEndOffset = null
          pending = adDiscontinuity ? ['#EXT-X-DISCONTINUITY'] : []
          adDiscontinuity = false
        }
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        adDiscontinuity = true
        pending.push(raw)
      } else if (line) {
        pending.push(raw)
      }
      continue
    }
    if (AD_TAG.test(line) || (/^#EXT-X-DATERANGE:/i.test(line) && /scte|cue|interstitial|vmap|vast|advert|commercial|ad[-_.]/i.test(line))) {
      markedAd = true
      continue
    }
    if (line && !line.startsWith('#')) {
      const segmentLines = [...pending, raw]
      const extinfLine = pending.find((part) => /^\s*#EXTINF:/i.test(part)) ?? ''
      const durationInfo = extinf(extinfLine)
      const duration = durationInfo?.duration ?? 0
      segments.push({
        lines: segmentLines,
        uri: line,
        duration,
        startOffset: elapsed,
        programDateTime,
        durationPrecision: durationInfo?.precision ?? -1,
        discontinuity: pending.some((part) => part.trimStart().startsWith('#EXT-X-DISCONTINUITY')),
        markedAd,
        keyState: activeKey,
        mapState: activeMap
      })
      elapsed += duration
      if (programDateTime !== null) programDateTime += duration * 1000
      pending = []
      markedAd = false
      continue
    }
    if (!segments.length && !pending.length && (line === '#EXTM3U' || /^#EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|DISCONTINUITY-SEQUENCE)/i.test(line))) {
      leading.push(raw)
    } else {
      pending.push(raw)
      if (/^#EXT-X-(?:CUE|SCTE|AD|VMAP)/i.test(line)) markedAd = true
    }
  }

  if (segments.length + cueRemovedCount !== originalCount) return input
  const remove = new Set<Segment>()
  segments.forEach((segment) => {
    if (uriIsAd(segment.uri, baseUrl) || segment.markedAd) remove.add(segment)
  })

  const firstTimedSegment = segments.find((segment) => segment.programDateTime !== null)
  const overlaps = (segment: Segment, start: number, end: number): boolean =>
    segment.startOffset < end && segment.startOffset + segment.duration > start
  for (const range of adDateRanges.values()) {
    if (!range.ad) continue
    const duration = range.endDate !== null && range.startDate !== null
      ? (range.endDate - range.startDate) / 1000
      : range.duration
    if (duration === null || duration <= 0) continue
    let startOffset = range.startOffset
    if (range.startDate !== null && firstTimedSegment?.programDateTime !== null && firstTimedSegment?.programDateTime !== undefined) {
      startOffset = firstTimedSegment.startOffset + (range.startDate - firstTimedSegment.programDateTime) / 1000
    }
    for (const segment of segments) {
      if (overlaps(segment, startOffset, startOffset + duration)) remove.add(segment)
    }
  }
  for (const interval of scteAdIntervals) {
    for (const segment of segments) {
      if (overlaps(segment, interval.start, interval.end)) remove.add(segment)
    }
  }

  const hasVodDiscontinuities = lines.some((line) => line.trim() === '#EXT-X-ENDLIST') &&
    lines.some((line) => line.trim().startsWith('#EXT-X-DISCONTINUITY'))
  if (hasVodDiscontinuities) {
    removeDecimalPrecisionGroups(segments, remove, originalCount)
    removeFrameRateGroups(segments, remove)
    removeUniformDurationGroups(segments, remove, originalCount)
  }
  removeDiscontinuityAdGroups(segments, remove)

  // Also mirror Android's dominant media-name prefix filter when a playlist is strongly clustered.
  if (segments.length >= 8) {
    const prefix = (value: string): string => {
      try {
        const url = new URL(value, baseUrl)
        url.pathname = url.pathname.replace(/(.*?)(?:[-_]?\d{1,7})?\.[^.]+$/, '$1')
        url.search = ''
        return url.origin + url.pathname
      } catch {
        return value
      }
    }
    const counts = new Map<string, number>()
    for (const segment of segments) counts.set(prefix(segment.uri), (counts.get(prefix(segment.uri)) ?? 0) + 1)
    const largest = Math.max(...counts.values())
    if (counts.size > 1 && largest / segments.length >= 0.8) {
      const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      for (const segment of segments) {
        if (prefix(segment.uri) !== main && !remove.has(segment) && remove.size + cueRemovedCount < originalCount * 0.3) remove.add(segment)
      }
    }
  }

  const removedCount = remove.size + cueRemovedCount
  if (!removedCount || removedCount > originalCount * 0.5) return input

  const output = [...leading]
  let keyState = ''
  let mapState = ''
  for (const segment of segments) {
    if (remove.has(segment)) continue
    keyState = appendState(output, '#EXT-X-KEY', keyState, segment.keyState)
    mapState = appendState(output, '#EXT-X-MAP', mapState, segment.mapState)
    output.push(...segment.lines.filter((line) =>
      !/^\s*#EXT-X-(?:KEY|MAP):/i.test(line) && !isAdMarkerLine(line.trim())
    ))
  }
  output.push(...pending.filter((line) => {
    const trimmed = line.trim()
    return trimmed === '#EXT-X-ENDLIST' || !isAdMarkerLine(trimmed)
  }))
  const normalized = normalizeMediaPlaylist(output)
  if (totalUris(normalized) <= 0 || !normalized.some((line) => /^#EXTM3U/.test(line)) || !isPlayable(normalized)) return input
  const result = normalized.join(eol)
  return `${result}${content.endsWith(eol) ? eol : ''}`
}
