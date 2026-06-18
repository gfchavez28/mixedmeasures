import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SplitToolbarProps {
  position: { top: number; left: number }
  onSplit: () => void
  onCancel: () => void
}

export default function SplitToolbar({ position, onSplit, onCancel }: SplitToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  // Auto-focus button on mount for keyboard accessibility
  useEffect(() => {
    // Small delay to avoid interfering with the text selection
    const timer = setTimeout(() => buttonRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label="Split segment"
      className="fixed z-50 animate-in fade-in-0 zoom-in-95"
      style={{
        top: position.top - 40,
        left: position.left,
      }}
    >
      <Button
        ref={buttonRef}
        size="sm"
        variant="default"
        className="h-8 px-3 shadow-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 gap-1.5"
        aria-label="Split segment at selection"
        onMouseDown={(e) => {
          // Prevent clearing the text selection
          e.preventDefault()
        }}
        onClick={(e) => {
          e.preventDefault()
          onSplit()
        }}
      >
        <Scissors className="w-3.5 h-3.5" />
        Split
      </Button>
    </div>,
    document.body
  )
}
