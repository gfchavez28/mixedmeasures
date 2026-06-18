import { useState, useRef, useEffect, useCallback } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useNavigate } from 'react-router-dom'
import { X, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import MemosPanelContent from '@/components/MemosPanelContent'

const MIN_WIDTH = 280
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 380
const STORAGE_KEY = 'mm-memos-width'

function loadWidth(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      const n = Number(v)
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH
}

interface MemosSlideOutProps {
  projectId: number
  onClose: () => void
  defaultEntityType?: string
  defaultEntityId?: number | null
  zIndex?: number
}

export default function MemosSlideOut({ projectId, onClose, defaultEntityType, defaultEntityId, zIndex }: MemosSlideOutProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [width, setWidth] = useState(loadWidth)
  const widthRef = useRef(width)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // Keep ref in sync with state
  useEffect(() => { widthRef.current = width }, [width])

  // Focus trap: Tab wraps within panel, Escape closes, restore focus on unmount
  useFocusTrap(panelRef, onClose)

  // Auto-focus panel on mount
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Resize drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [width])

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      // Dragging left edge: moving left = wider
      const delta = startX.current - e.clientX
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      setWidth(newWidth)
    }
    function handleMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      // Persist using ref to avoid stale closure
      try { localStorage.setItem(STORAGE_KEY, String(widthRef.current)) } catch { /* ignore */ }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handleGoToPage = () => {
    onClose()
    navigate(`/projects/${projectId}/memos-notes`)
  }

  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label="Memos"
      tabIndex={-1}
      className="fixed top-0 right-0 h-screen bg-mm-surface border-l border-mm-border-subtle shadow-xl flex flex-col animate-in slide-in-from-right duration-200"
      style={{ width, zIndex: zIndex ?? 50 }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400/30 active:bg-blue-400/50 transition-colors z-10"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize memos panel"
      />

      <MemosPanelContent
        projectId={projectId}
        defaultEntityType={defaultEntityType}
        defaultEntityId={defaultEntityId}
        headerExtra={
          <div className="flex items-center gap-1">
            <button
              onClick={handleGoToPage}
              className="text-[11px] text-mm-text-muted hover:text-mm-accent transition-colors flex items-center gap-0.5 mr-1"
              title="Go to Memos & Notes page"
            >
              <ArrowUpRight className="h-3 w-3" />
              <span>Full page</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-mm-text-muted hover:text-mm-text"
              onClick={onClose}
              aria-label="Close memos panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        }
      />
    </div>
  )
}
