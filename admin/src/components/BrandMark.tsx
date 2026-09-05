interface Props {
  className?: string
}

/** WzzScrm 固定 W 标识。 */
export function BrandMark({ className = '' }: Props): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M14 19 24 46 32 29 40 46 50 19"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
