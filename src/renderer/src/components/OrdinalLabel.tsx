import { translate } from '@/i18n'

function displayOrdinal(value: string): string {
  const codePoint = value.codePointAt(0)
  if (codePoint === undefined) return value

  if (codePoint >= 0x2460 && codePoint <= 0x2473) return String(codePoint - 0x245f)
  if (codePoint >= 0x3251 && codePoint <= 0x3254) return String(codePoint - 0x323c)
  return value
}

export function OrdinalLabel({ prefix, value }: { prefix: string; value: string }): JSX.Element {
  const ordinal = displayOrdinal(value)

  return (
    <span className="ordinal-label">
      <span className="ordinal-label-prefix">{translate(prefix)}</span>
      <span className="ordinal-label-value" aria-label={`${translate(prefix)}${ordinal}`}>
        <span className="ordinal-label-number">{ordinal}</span>
      </span>
    </span>
  )
}
