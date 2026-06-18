import { useCallback, useRef, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  minWidth?: number
  maxWidth?: number
  currentWidth: number
}

export default function ResizeHandle({
  onResize,
  minWidth = 200,
  maxWidth = 600,
  currentWidth,
}: ResizeHandleProps) {
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [isActive, setIsActive] = useState(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = currentWidth
    setIsActive(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [currentWidth])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return

      // Delta is negative when dragging left (which should increase panel width for right panel)
      const delta = startX.current - e.clientX
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      const actualDelta = newWidth - currentWidth

      if (actualDelta !== 0) {
        onResize(actualDelta)
      }
    }

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        setIsActive(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [onResize, minWidth, maxWidth, currentWidth])

  return (
    <div
      className={cn(
        'absolute left-0 top-0 bottom-0 w-1 cursor-col-resize group z-10',
        'hover:bg-emerald-400 transition-colors',
        isActive && 'bg-emerald-500'
      )}
      onMouseDown={handleMouseDown}
    >
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-4 -translate-x-1/2',
          'opacity-0 group-hover:opacity-100 transition-opacity'
        )}
      />
    </div>
  )
}
