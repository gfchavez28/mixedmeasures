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
        className="h-8 px-3 shadow-lg bg-mm-text text-mm-bg hover:bg-mm-text/90 gap-1.5"
        aria-label="Split segment at selection"
        title="Split this segment in two at the selected point"
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
