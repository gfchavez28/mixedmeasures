import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, LockOpen } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi } from '@/lib/api'

/**
 * Track J · J3-1: the "Freeze Codebook" soft-lock toggle. Self-contained — reads the
 * project (shared `['project', projectId]` cache) and flips `codebook_frozen_at`.
 * Frozen state is dual-encoded (lock icon + "Frozen" label + amber tint), not color
 * alone. Renders in both the codebook page toolbar and the codebook slide-out header.
 */
export default function FreezeCodebookButton({
  projectId,
  className = '',
}: {
  projectId: number
  className?: string
}) {
  const qc = useQueryClient()
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
  })
  const isFrozen = !!project?.codebook_frozen_at

  const mut = useMutation({
    mutationFn: (frozen: boolean) => projectsApi.setCodebookFreeze(projectId, frozen),
    onSuccess: (updated) => {
      qc.setQueryData(['project', projectId], updated)
      toast.success(updated.codebook_frozen_at ? 'Codebook frozen' : 'Codebook unfrozen')
    },
    onError: () => toast.error('Could not update the codebook freeze'),
  })

  const Icon = isFrozen ? Lock : LockOpen
  return (
    <button
      onClick={() => mut.mutate(!isFrozen)}
      disabled={mut.isPending}
      className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
        isFrozen
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
          : 'text-mm-text-muted border-mm-surface-border hover:bg-mm-surface'
      } ${className}`}
      title={
        isFrozen
          ? 'Codebook is frozen — coders are warned before adding, removing, or renaming codes. Click to unfreeze.'
          : 'Freeze the codebook to lock its codes during independent coding.'
      }
      aria-label={isFrozen ? 'Unfreeze codebook' : 'Freeze codebook'}
      aria-pressed={isFrozen}
    >
      <Icon className="w-3.5 h-3.5" />
      {isFrozen ? 'Frozen' : 'Freeze'}
    </button>
  )
}
