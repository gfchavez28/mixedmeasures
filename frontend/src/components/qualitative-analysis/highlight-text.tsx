import type { JSX } from 'react'

/** Highlight matching search terms in text with <mark> tags. */
export function highlightText(text: string, query: string): JSX.Element {
  if (!query) return <>{text}</>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-yellow-200/60 dark:bg-yellow-500/30 text-inherit rounded-sm">{part}</mark>
          : part
      )}
    </>
  )
}
