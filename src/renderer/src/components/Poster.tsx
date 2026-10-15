import { useEffect, useState } from 'react'

interface PosterProps {
  src?: string
  fallbacks?: string[]
  name: string
  className?: string
}

/**
 * 海报图。第三方站点的图床经常挂，必须给失败兜底，
 * 否则海报墙会出现一片破图。
 */
export function Poster({ src, fallbacks = [], name, className = '' }: PosterProps): JSX.Element {
  const [sourceIndex, setSourceIndex] = useState(0)
  const fallbackKey = fallbacks.join('\n')
  const sources = [...new Set([src, ...fallbacks].filter((url): url is string => Boolean(url)))]

  useEffect(() => {
    setSourceIndex(0)
  }, [src, fallbackKey])

  const currentSource = sources[sourceIndex]

  return (
    <div className={`poster ${className}`}>
      {currentSource ? (
        <img src={currentSource} alt="" loading="lazy" draggable={false}
          onError={() => setSourceIndex((current) => Math.min(current + 1, sources.length))} />
      ) : (
        <span className="poster-fallback">{(name || '?').trim().slice(0, 1)}</span>
      )}
    </div>
  )
}
