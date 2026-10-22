import { translate } from '@/i18n'

export function OrdinalLabel({ prefix, value }: { prefix: string; value: string }): JSX.Element {
  return (
    <span className="ordinal-label">
      <span className="ordinal-label-prefix">{translate(prefix)}</span>
      <span className="ordinal-label-value">{value}</span>
    </span>
  )
}
