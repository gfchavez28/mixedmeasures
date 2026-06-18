/**
 * Floating slash command list for Tiptap suggestion integration.
 *
 * Analogous to ThemeMentionList — forwardRef with imperative onKeyDown,
 * positioned via clientRect from the suggestion plugin.
 */
import { forwardRef, useImperativeHandle, useState, useEffect, useRef } from 'react'
import type { SlashCommand } from './extensions/slash-commands'

export interface SlashCommandListRef {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface SlashCommandListProps {
  items: SlashCommand[]
  command: (item: SlashCommand) => void
  clientRect: (() => DOMRect | null) | null
}

const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  ({ items, command, clientRect }, ref) => {
    const [focusIndex, setFocusIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    // Reset focus when items change
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset highlight to top when the Tiptap suggestion list changes (external editor-driven)
    useEffect(() => { setFocusIndex(0) }, [items])

    // Scroll focused item into view
    useEffect(() => {
      const el = listRef.current?.children[focusIndex] as HTMLElement | undefined
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
          if (items[focusIndex]) command(items[focusIndex])
          return true
        }
        if (event.key === 'Escape') {
          return true
        }
        return false
      },
    }))

    if (!items.length) {
      const rect = clientRect?.()
      if (!rect) return null
      return (
        <div
          className="bg-white dark:bg-mm-surface border border-mm-border rounded-lg shadow-lg py-2 px-3 text-xs text-mm-text-muted"
          style={{ position: 'fixed', top: rect.bottom + 4, left: Math.max(8, rect.left), width: 220, zIndex: 60 }}
        >
          No matching commands
        </div>
      )
    }

    // Position below the caret
    const rect = clientRect?.()
    if (!rect) return null
    const estimatedHeight = items.length * 36 + 8
    const flipAbove = rect.bottom + estimatedHeight > window.innerHeight
    const top = flipAbove ? rect.top - estimatedHeight - 4 : rect.bottom + 4
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 228))

    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="Slash commands"
        className="bg-white dark:bg-mm-surface border border-mm-border rounded-lg shadow-lg overflow-hidden py-1"
        style={{
          position: 'fixed',
          top,
          left,
          width: 220,
          zIndex: 60,
          maxHeight: 280,
          overflowY: 'auto',
        }}
      >
        {items.map((cmd, i) => (
          <button
            key={cmd.type}
            type="button"
            role="option"
            aria-selected={i === focusIndex}
            onClick={() => command(cmd)}
            onMouseEnter={() => setFocusIndex(i)}
            className={`flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-sm transition-colors ${
              i === focusIndex
                ? 'bg-mm-bg text-mm-text'
                : 'text-mm-text hover:bg-mm-bg/50'
            }`}
          >
            <span className="w-5 h-5 flex items-center justify-center text-mm-text-muted shrink-0">
              {cmd.icon}
            </span>
            <div className="min-w-0">
              <div className="font-medium text-[13px] truncate">{cmd.label}</div>
              <div className="text-[11px] text-mm-text-muted truncate">{cmd.description}</div>
            </div>
          </button>
        ))}
      </div>
    )
  },
)

SlashCommandList.displayName = 'SlashCommandList'

export default SlashCommandList
