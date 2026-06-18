import { X } from 'lucide-react'

interface FocusPillProps {
  codeName: string
  codeColor: string
  onClear: () => void
  countLabel?: string
}

export default function FocusPill({ codeName, codeColor, onClear, countLabel }: FocusPillProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border"
        style={{
          backgroundColor: `${codeColor}18`,
          color: codeColor,
          borderColor: `${codeColor}40`,
        }}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: codeColor }} />
        Focused: {codeName}
        <button
          className="rounded-full p-0.5 transition-colors"
          style={{ color: codeColor }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = `${codeColor}30`)}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          onClick={onClear}
          aria-label="Clear focus"
        >
          <X className="w-3 h-3" />
        </button>
      </span>
      {countLabel && (
        <span className="text-xs text-mm-text-muted">{countLabel}</span>
      )}
    </div>
  )
}
