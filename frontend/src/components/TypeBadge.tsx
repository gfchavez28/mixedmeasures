import { TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'

export function TypeBadge({ type }: { type: string }) {
  const cls = TYPE_BADGE_CLASSES[type] || 'bg-mm-bg text-mm-text-muted'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
      {type}
    </span>
  )
}
