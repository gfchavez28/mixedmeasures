import { useState, useRef, useEffect, useCallback } from 'react'

interface InlineEditableTextProps {
  value: string
  placeholder?: string
  onSave: (newValue: string) => void
  className?: string
  inputClassName?: string
  maxLength?: number
  allowEmpty?: boolean
  tag?: 'span' | 'h3' | 'p'
  startEditing?: boolean
  onEditEnd?: () => void
  ariaLabel?: string
  title?: string
}

export default function InlineEditableText({
  value,
  placeholder = 'Untitled',
  onSave,
  className = '',
  inputClassName = '',
  maxLength = 255,
  allowEmpty = false,
  tag: Tag = 'span',
  startEditing = false,
  onEditEnd,
  ariaLabel,
  title,
}: InlineEditableTextProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guard against premature blur (e.g. context menu teardown stealing focus)
  const settledRef = useRef(false)

  // Sync draft when value changes externally
  useEffect(() => {
    if (!isEditing) setDraft(value)
  }, [value, isEditing])

  // Programmatic trigger via startEditing prop — delay to let context menu close
  useEffect(() => {
    if (startEditing && !isEditing) {
      const timer = setTimeout(() => enterEdit(), 60)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing])

  const enterEdit = useCallback(() => {
    setDraft(value)
    settledRef.current = false
    setIsEditing(true)
  }, [value])

  const save = useCallback(() => {
    const trimmed = draft.trim()
    if (!allowEmpty && trimmed === '') {
      // Revert to original
      setDraft(value)
    } else if (trimmed !== value) {
      onSave(trimmed)
    }
    setIsEditing(false)
    onEditEnd?.()
  }, [draft, value, allowEmpty, onSave, onEditEnd])

  const cancel = useCallback(() => {
    setDraft(value)
    setIsEditing(false)
    onEditEnd?.()
  }, [value, onEditEnd])

  // Auto-focus + select on mount, then mark as settled
  useEffect(() => {
    if (isEditing && inputRef.current) {
      const el = inputRef.current
      requestAnimationFrame(() => {
        el.focus()
        el.select()
        // Mark settled after focus is established so blur handler becomes active
        requestAnimationFrame(() => {
          settledRef.current = true
        })
      })
    }
  }, [isEditing])

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!settledRef.current) {
            // Premature blur (context menu teardown) — re-focus
            inputRef.current?.focus()
            return
          }
          save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
          e.stopPropagation()
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        maxLength={maxLength}
        className={`bg-mm-bg border border-mm-border-subtle rounded px-1.5 py-0.5 text-mm-text outline-none focus:border-[hsl(var(--mm-green))] ${inputClassName}`}
        style={{ width: '100%' }}
      />
    )
  }

  return (
    <Tag
      className={`cursor-text ${!value ? 'italic text-mm-text-faint' : ''} ${className}`}
      title={title}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        enterEdit()
      }}
    >
      {value || placeholder}
    </Tag>
  )
}
