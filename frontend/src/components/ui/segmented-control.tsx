import { useCallback, type KeyboardEvent } from 'react'

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  /** Optional id prefix for tab buttons */
  idPrefix?: string
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  idPrefix = 'seg',
}: SegmentedControlProps<T>) {
  const activeIndex = options.findIndex(o => o.value === value)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const idx = options.findIndex(o => o.value === value)
    let next: number | undefined
    if (e.key === 'ArrowRight') {
      next = (idx + 1) % options.length
    } else if (e.key === 'ArrowLeft') {
      next = (idx - 1 + options.length) % options.length
    } else if (e.key === 'Home') {
      next = 0
    } else if (e.key === 'End') {
      next = options.length - 1
    }
    if (next != null) {
      e.preventDefault()
      onChange(options[next].value)
      requestAnimationFrame(() => {
        const btn = (e.currentTarget as HTMLElement).querySelector(
          `[data-seg="${options[next!].value}"]`
        ) as HTMLButtonElement | null
        btn?.focus()
      })
    }
  }, [options, value, onChange])

  return (
    <div
      className="inline-flex rounded-md border bg-mm-bg p-0.5 relative"
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      style={{ display: 'inline-grid', gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {/* Sliding indicator */}
      <div
        className="absolute top-0.5 bottom-0.5 rounded-[calc(var(--radius)-2px)] bg-mm-surface shadow-xs transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          left: '2px',
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map(opt => {
        const isActive = opt.value === value
        return (
          <button
            key={opt.value}
            role="tab"
            id={`${idPrefix}-${opt.value}`}
            data-seg={opt.value}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`relative z-[1] px-3 py-1 text-xs font-medium rounded-[calc(var(--radius)-2px)] transition-colors whitespace-nowrap ${
              isActive ? 'text-mm-text' : 'text-mm-text-muted hover:text-mm-text-secondary'
            }`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
