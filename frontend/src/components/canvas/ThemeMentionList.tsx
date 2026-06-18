import { forwardRef, useImperativeHandle, useState, useEffect, useRef } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThemeMentionItem {
  id: string
  label: string
  color: string
}

export interface ThemeMentionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface ThemeMentionListProps {
  items: ThemeMentionItem[]
  command: (item: { id: string; label: string }) => void
  clientRect: (() => DOMRect | null) | null
}

// ── Component ────────────────────────────────────────────────────────────────

const ThemeMentionList = forwardRef<ThemeMentionListRef, ThemeMentionListProps>(
  function ThemeMentionList({ items, command, clientRect }, ref) {
    const [focusIndex, setFocusIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    // Reset focus when items change
    useEffect(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset highlight to top when the mention list changes (external editor-driven)
      setFocusIndex(0)
    }, [items])

    // Scroll focused item into view
    useEffect(() => {
      const el = listRef.current?.querySelector(`[data-index="${focusIndex}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }, [focusIndex])

    useImperativeHandle(ref, () => ({
      onKeyDown(event: KeyboardEvent): boolean {
        if (event.key === 'ArrowDown') {
          setFocusIndex(prev => (prev + 1) % items.length)
          return true
        }
        if (event.key === 'ArrowUp') {
          setFocusIndex(prev => (prev - 1 + items.length) % items.length)
          return true
        }
        if (event.key === 'Enter') {
          if (items[focusIndex]) {
            command({ id: items[focusIndex].id, label: items[focusIndex].label })
          }
          return true
        }
        return false
      },
    }))

    const rect = clientRect?.()
    if (!rect || items.length === 0) return null

    // Position: below the caret, clamped to viewport
    const menuWidth = 200
    const estimatedHeight = Math.min(items.length * 32 + 8, 200)
    const top = rect.bottom + 4
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 8)
    const flipped = top + estimatedHeight > window.innerHeight
    const finalTop = flipped ? rect.top - estimatedHeight - 4 : top

    const activeId = items[focusIndex] ? `theme-mention-${items[focusIndex].id}` : undefined

    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="Mention a theme"
        aria-activedescendant={activeId}
        className="fixed bg-white dark:bg-mm-surface border border-mm-border shadow-lg rounded-md overflow-auto"
        style={{
          top: finalTop,
          left,
          minWidth: menuWidth,
          maxHeight: 200,
          zIndex: 60,
        }}
      >
        {items.map((item, i) => (
          <button
            key={item.id}
            id={`theme-mention-${item.id}`}
            role="option"
            type="button"
            data-index={i}
            aria-selected={i === focusIndex}
            className={`flex items-center gap-2 w-full text-left transition-colors ${
              i === focusIndex
                ? 'bg-mm-bg text-mm-text'
                : 'text-mm-text hover:bg-mm-bg/60'
            }`}
            style={{ padding: '6px 10px' }}
            onClick={() => command({ id: item.id, label: item.label })}
            onMouseEnter={() => setFocusIndex(i)}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-sm truncate">{item.label}</span>
          </button>
        ))}
      </div>
    )
  },
)

export default ThemeMentionList
