import { useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { SELECTED_ROW } from '@/lib/selection'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Plus,
  Users,
  Pencil,
  Check,
  X,
  Trash2,
  CircleAlert,
  ExternalLink,
  ChevronRight,
} from 'lucide-react'
import {
  participantsApi,
  datasetsApi,
  speakersApi,
  type Participant,
  type Dataset,
} from '@/lib/api'
import { toast } from 'sonner'
import { filterLinkableRows, linkableRowDetail } from '@/lib/linkable-rows'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { getSpeakerInitials, getInitialsBadgeColors, isOrphanedParticipant, isUnnamedLabel, UNNAMED_LABEL } from '@/lib/conversation-import-utils'
import { getContrastColor } from '@/lib/utils'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export default function ParticipantsPage() {
  const { projectId } = useProjectLayout()
  const queryClient = useQueryClient()

  const { data: participantsData, isLoading } = useQuery({
    queryKey: ['participants', projectId],
    queryFn: () => participantsApi.list(projectId),
    staleTime: 30_000,
  })

  const { data: datasetsData } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => datasetsApi.list(projectId),
    staleTime: 30_000,
  })

  const participants = participantsData?.participants || []
  const datasets = datasetsData?.datasets || []

  // Add participant form state
  const [isAddingParticipant, setIsAddingParticipant] = useState(false)
  const [newParticipantName, setNewParticipantName] = useState('')
  const [newParticipantRole, setNewParticipantRole] = useState('')
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false)

  // Selection + confirm state
  const [selectedParticipantId, setSelectedParticipantId] = useState<number | null>(null)
  const [deleteParticipant, setDeleteParticipant] = useState<{ id: number; identifier: string } | null>(null)

  // Orphan filter + bulk-delete state
  const [showOrphansOnly, setShowOrphansOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // Mutations
  const createParticipantMutation = useMutation({
    mutationFn: (data: { identifier: string; display_name?: string; role?: string }) =>
      participantsApi.create(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setNewParticipantName('')
      setNewParticipantRole('')
      setDuplicateConfirmed(false)
      setIsAddingParticipant(false)
    },
  })

  const updateParticipantMutation = useMutation({
    mutationFn: ({ participantId, data }: { participantId: number; data: { identifier?: string; display_name?: string; role?: string } }) =>
      participantsApi.update(projectId, participantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'segments' })
    },
  })

  const deleteParticipantMutation = useMutation({
    mutationFn: (participantId: number) => participantsApi.delete(projectId, participantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedParticipantId(null)
    },
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((pid) => participantsApi.delete(projectId, pid))
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      return { total: ids.length, failed }
    },
    onSuccess: ({ total, failed }) => {
      if (failed > 0) {
        toast.error(`Deleted ${total - failed} of ${total}; ${failed} could not be removed.`)
      } else {
        toast.success(`Deleted ${total} participant${total === 1 ? '' : 's'}.`)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedIds(new Set())
      setSelectedParticipantId(null)
    },
  })

  const orphanCount = participants.filter(isOrphanedParticipant).length
  const visibleParticipants = showOrphansOnly
    ? participants.filter(isOrphanedParticipant)
    : participants
  const allVisibleSelected =
    visibleParticipants.length > 0 &&
    visibleParticipants.every((p) => selectedIds.has(p.id))
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        visibleParticipants.forEach((p) => next.delete(p.id))
        return next
      }
      return new Set([...prev, ...visibleParticipants.map((p) => p.id)])
    })
  }

  if (isLoading) {
    return (
      <div className="h-full overflow-auto p-8">
        <div className="text-center py-12 text-mm-text-muted">Loading participants...</div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Back link */}
        <Link
          to={`/projects/${projectId}/overview`}
          className="inline-flex items-center gap-1.5 text-sm text-mm-text-muted hover:text-mm-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Overview
        </Link>

        {/* Header + Add button */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-mm-text">
            Participants
            {participants.length > 0 && (
              <span className="text-mm-text-muted font-normal ml-2">({participants.length})</span>
            )}
          </h1>
          <Button onClick={() => setIsAddingParticipant(true)} size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            Add Participant
          </Button>
        </div>

        {/* Add participant form */}
        {isAddingParticipant && (
          <div className="bg-mm-surface border border-mm-border-subtle rounded-lg p-4 space-y-4">
            <h3 className="font-medium text-mm-text">New Participant</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-mm-text-secondary mb-1 block">Name *</label>
                <Input
                  value={newParticipantName}
                  onChange={(e) => {
                    setNewParticipantName(e.target.value)
                    setDuplicateConfirmed(false)
                  }}
                  placeholder="Participant name"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium text-mm-text-secondary mb-1 block">Role</label>
                <Input
                  value={newParticipantRole}
                  onChange={(e) => setNewParticipantRole(e.target.value)}
                  placeholder="e.g. board, staff"
                />
              </div>
            </div>
            {/* Duplicate warning */}
            {(() => {
              const trimmed = newParticipantName.trim().toLowerCase()
              const match = trimmed && participants.find(
                p => (p.display_name || p.identifier).toLowerCase() === trimmed
              )
              if (match && !duplicateConfirmed) {
                const convNames = match.linked_speakers.flatMap(s => s.conversations.map(c => c.name))
                const uniqueConvs = [...new Set(convNames)]
                return (
                  <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-950/30 dark:border-amber-800">
                    <CircleAlert className="w-4 h-4 flex-shrink-0 text-amber-600" />
                    <p className="text-sm text-amber-800 dark:text-amber-200 flex-1">
                      Matches existing participant "<strong>{match.display_name || match.identifier}</strong>"
                      {uniqueConvs.length > 0 && <> (in {uniqueConvs.join(', ')})</>}
                      . If this is a different person, use a different name or click proceed.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setDuplicateConfirmed(true)}
                    >
                      Different person, proceed
                    </Button>
                  </div>
                )
              }
              return null
            })()}
            {createParticipantMutation.isError && (
              <p className="text-sm text-red-600">
                {(createParticipantMutation.error as Error & { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to create participant'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => {
                setIsAddingParticipant(false)
                setNewParticipantName('')
                setNewParticipantRole('')
                setDuplicateConfirmed(false)
              }}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const name = newParticipantName.trim()
                  const data: { identifier: string; display_name: string; role?: string } = {
                    identifier: name,
                    display_name: name,
                  }
                  if (newParticipantRole.trim()) data.role = newParticipantRole.trim()
                  createParticipantMutation.mutate(data)
                }}
                disabled={
                  !newParticipantName.trim() ||
                  createParticipantMutation.isPending ||
                  (!!newParticipantName.trim() && !!participants.find(
                    p => (p.display_name || p.identifier).toLowerCase() === newParticipantName.trim().toLowerCase()
                  ) && !duplicateConfirmed)
                }
              >
                {createParticipantMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {participants.length === 0 && !isAddingParticipant ? (
          <div className="text-center py-16 bg-mm-surface rounded-lg border border-mm-border-subtle">
            <Users className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
            <h3 className="text-lg font-medium text-mm-text mb-2">No participants yet</h3>
            <p className="text-mm-text-muted mb-4">
              When you import a conversation, a participant is created for each non-facilitator speaker. You can also add participants manually.
            </p>
            <Button onClick={() => setIsAddingParticipant(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Participant
            </Button>
          </div>
        ) : participants.length > 0 && (
          <div className="space-y-3">
            {/* Orphan filter + bulk actions */}
            {(orphanCount > 0 || selectedIds.size > 0) && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => { setShowOrphansOnly(false); setSelectedIds(new Set()) }}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                      !showOrphansOnly
                        ? 'bg-mm-text text-mm-bg border-mm-text'
                        : 'border-mm-border-subtle text-mm-text-muted hover:text-mm-text'
                    }`}
                  >
                    All ({participants.length})
                  </button>
                  {orphanCount > 0 && (
                    <button
                      onClick={() => { setShowOrphansOnly(true); setSelectedIds(new Set()) }}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        showOrphansOnly
                          ? 'bg-mm-text text-mm-bg border-mm-text'
                          : 'border-mm-border-subtle text-mm-text-muted hover:text-mm-text'
                      }`}
                      title="Participants whose conversations and datasets were all deleted"
                    >
                      No linked sources ({orphanCount})
                    </button>
                  )}
                </div>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-mm-text-muted">{selectedIds.size} selected</span>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setBulkDeleteOpen(true)}
                      disabled={bulkDeleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" />
                      {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete selected'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          <div className="flex gap-4 items-start">
            {/* Table */}
            <div className={`bg-mm-surface rounded-lg border border-mm-border-subtle ${selectedParticipantId ? 'flex-1 min-w-0' : 'w-full'}`}>
              <table className="w-full">
                <thead className="bg-mm-bg">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <Checkbox
                        checked={allVisibleSelected ? true : selectedIds.size > 0 && visibleParticipants.some(p => selectedIds.has(p.id)) ? 'indeterminate' : false}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all participants"
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-mm-text-secondary">Name</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-mm-text-secondary">Role</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-mm-text-secondary">Conversations</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-mm-text-secondary w-16">Datasets</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-mm-text-secondary w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-mm-border-subtle">
                  {visibleParticipants.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-sm text-mm-text-muted">
                        No participants without linked sources.
                      </td>
                    </tr>
                  )}
                  {visibleParticipants.map((participant) => (
                    <ParticipantRow
                      key={participant.id}
                      participant={participant}
                      isOrphan={isOrphanedParticipant(participant)}
                      checked={selectedIds.has(participant.id)}
                      onToggleChecked={() => setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(participant.id)) next.delete(participant.id)
                        else next.add(participant.id)
                        return next
                      })}
                      isSelected={selectedParticipantId === participant.id}
                      onSelect={() => setSelectedParticipantId(
                        selectedParticipantId === participant.id ? null : participant.id
                      )}
                      onUpdate={(data) => updateParticipantMutation.mutate({ participantId: participant.id, data })}
                      onDelete={() => setDeleteParticipant({ id: participant.id, identifier: participant.identifier })}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Detail panel */}
            {selectedParticipantId && (
              <ParticipantDetailPanel
                participantId={selectedParticipantId}
                projectId={projectId}
                datasets={datasets}
                onClose={() => setSelectedParticipantId(null)}
              />
            )}
          </div>
          </div>
        )}
      </div>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleteParticipant !== null}
        onOpenChange={(open) => { if (!open) setDeleteParticipant(null) }}
        title="Delete Participant"
        description={`Delete participant "${deleteParticipant?.identifier}"? Speaker links will be removed.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteParticipant !== null) {
            deleteParticipantMutation.mutate(deleteParticipant.id)
          }
          setDeleteParticipant(null)
        }}
        destructive
      />

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => { if (!open) setBulkDeleteOpen(false) }}
        title={`Delete ${selectedIds.size} participant${selectedIds.size === 1 ? '' : 's'}`}
        description={`Permanently delete ${selectedIds.size} selected participant${selectedIds.size === 1 ? '' : 's'}? Any remaining speaker or dataset-row links will be cleared. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          bulkDeleteMutation.mutate([...selectedIds])
          setBulkDeleteOpen(false)
        }}
        destructive
      />
    </div>
  )
}

// ── Participant table row ──────────────────────────────────────────────

function ParticipantRow({
  participant,
  onUpdate,
  onDelete,
  isSelected,
  onSelect,
  isOrphan = false,
  checked = false,
  onToggleChecked,
}: {
  participant: Participant
  onUpdate: (data: { identifier?: string; display_name?: string; role?: string }) => void
  onDelete: () => void
  isSelected?: boolean
  onSelect?: () => void
  isOrphan?: boolean
  checked?: boolean
  onToggleChecked?: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(participant.display_name || participant.identifier)
  const [editRole, setEditRole] = useState(participant.role || '')

  const rawName = participant.display_name || participant.identifier
  const currentName = rawName
  // #396: unnamed participants (no name, or an imported "..." placeholder)
  // render a clear label instead of literal dots.
  const isUnnamed = isUnnamedLabel(rawName)
  const displayName = isUnnamed ? UNNAMED_LABEL : rawName

  const handleSave = () => {
    const data: { identifier?: string; display_name?: string; role?: string } = {}
    const trimmedName = editName.trim()
    if (trimmedName && trimmedName !== currentName) {
      data.display_name = trimmedName
      data.identifier = trimmedName
    }
    if (editRole.trim() !== (participant.role || '')) data.role = editRole.trim() || undefined
    if (Object.keys(data).length > 0) onUpdate(data)
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditName(currentName)
    setEditRole(participant.role || '')
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSave() }
    else if (e.key === 'Escape') handleCancel()
  }

  const linkedConversations = participant.linked_speakers.flatMap(s => s.conversations.map(c => c.name))
  const uniqueConversations = [...new Set(linkedConversations)]

  // #353: keyboard activation for the (now-expandable) row. Enter/Space
  // toggles the detail panel exactly like a click. The whole row stays a
  // semantic <tr> — only adds tabIndex + aria-expanded; no role override
  // that would break table semantics in screen readers.
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (isEditing) return  // don't intercept while inline-editing the name
    // Don't fire when focus is inside an interactive child (checkbox, button)
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect?.()
    }
  }

  return (
    <tr
      className={`hover:bg-mm-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${isSelected ? SELECTED_ROW : ''}`}
      onClick={() => onSelect?.()}
      // #353 — keyboard + screen-reader affordance for row expansion
      tabIndex={0}
      aria-expanded={isSelected}
      onKeyDown={handleRowKeyDown}
    >
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleChecked?.()}
          aria-label={`Select ${displayName}`}
        />
      </td>
      <td className="px-4 py-3 text-sm text-mm-text">
        <div className="flex items-center gap-2">
          {/* #353: chevron affordance — rotates to indicate the detail
            * panel state. aria-hidden because the <tr>'s aria-expanded
            * carries the semantic. transition-transform so reduced-motion
            * users get the global media-query suppression. */}
          <ChevronRight
            className={`w-3.5 h-3.5 text-mm-text-muted shrink-0 transition-transform ${isSelected ? 'rotate-90' : ''}`}
            aria-hidden
          />
          {participant.linked_speakers.length > 0 && (() => {
            const s = participant.linked_speakers[0]
            return (
              <span
                className={`w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center ring-1 shrink-0 ${
                  s.color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(s.is_facilitator)
                }`}
                style={s.color ? { backgroundColor: s.color, color: getContrastColor(s.color) } : undefined}
                title={s.speaker_name}
              >
                {getSpeakerInitials(currentName)}
              </span>
            )
          })()}
          {isEditing ? (
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={handleKeyDown} className="h-8 text-sm" autoFocus onClick={(e) => e.stopPropagation()} />
          ) : (
            <span className={isUnnamed ? 'text-mm-text-faint italic' : ''}>{displayName}</span>
          )}
          {isOrphan && (
            <span
              className="px-1.5 py-0.5 text-[10px] rounded bg-mm-surface-hover text-mm-text-muted shrink-0"
              title="No conversations or datasets reference this participant — its sources were deleted"
            >
              No linked sources
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-mm-text">
        {isEditing ? (
          <Input value={editRole} onChange={(e) => setEditRole(e.target.value)} onKeyDown={handleKeyDown} className="h-8 text-sm" placeholder="Role" onClick={(e) => e.stopPropagation()} />
        ) : (
          <span className={participant.role ? '' : 'text-mm-text-faint italic'}>{participant.role || '-'}</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-mm-text-secondary">
        {uniqueConversations.length > 0
          ? uniqueConversations.join(', ')
          : <span className="text-mm-text-faint italic">No linked conversations</span>
        }
      </td>
      <td className="px-4 py-3 text-sm text-right">
        {participant.dataset_rows.length > 0
          ? <span className="text-mm-blue-text">{participant.dataset_rows.length}</span>
          : <span className="text-mm-text-faint">0</span>
        }
      </td>
      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {isEditing ? (
            <>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleSave} aria-label="Save">
                <Check className="w-4 h-4 text-green-600" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleCancel} aria-label="Cancel">
                <X className="w-4 h-4 text-mm-text-muted" />
              </Button>
            </>
          ) : (
            <>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-secondary hover:text-mm-text" onClick={() => setIsEditing(true)} title="Edit participant">
                <Pencil className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-faint hover:text-destructive" onClick={onDelete} title="Delete participant">
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Participant detail side panel ──────────────────────────────────────

function ParticipantDetailPanel({
  participantId,
  projectId,
  datasets,
  onClose,
}: {
  participantId: number
  projectId: number
  datasets: Dataset[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [linkingDatasetId, setLinkingDatasetId] = useState<number | null>(null)
  const [linkSearch, setLinkSearch] = useState('')

  const { data: detail, isLoading } = useQuery({
    queryKey: ['participant-detail', participantId],
    queryFn: () => participantsApi.getDetail(projectId, participantId),
  })

  const { data: linkableData } = useQuery({
    queryKey: ['linkable-rows', projectId, linkingDatasetId],
    queryFn: () => datasetsApi.linkableRows(projectId, linkingDatasetId!),
    enabled: !!linkingDatasetId,
  })

  const linkMutation = useMutation({
    mutationFn: ({ datasetId, rowId }: { datasetId: number; rowId: number }) =>
      participantsApi.linkDatasetRow(projectId, participantId, datasetId, rowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith?.('dataset') })
      setLinkingDatasetId(null)
      setLinkSearch('')
    },
  })

  const unlinkMutation = useMutation({
    mutationFn: (rowId: number) =>
      participantsApi.unlinkDatasetRow(projectId, participantId, rowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith?.('dataset') })
    },
  })

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (isLoading || !detail) {
    return (
      <div className="w-96 flex-shrink-0 sticky top-4 bg-mm-surface rounded-lg border border-mm-border-subtle p-4">
        <div className="text-center text-mm-text-faint py-8">Loading...</div>
      </div>
    )
  }

  const rawName = detail.display_name || detail.identifier
  const isUnnamed = isUnnamedLabel(rawName)  // #396
  const currentName = isUnnamed ? UNNAMED_LABEL : rawName
  const linkedDatasetIds = new Set(detail.dataset_rows.map(dr => dr.dataset_id))
  const availableDatasets = datasets.filter(ds => !linkedDatasetIds.has(ds.id))

  // Group demographics by dataset
  const demoByDataset = new Map<number, typeof detail.linked_demographics>()
  for (const d of detail.linked_demographics) {
    const arr = demoByDataset.get(d.dataset_id) || []
    arr.push(d)
    demoByDataset.set(d.dataset_id, arr)
  }

  const linkableRows = linkableData?.rows || []
  // #418: search every value in the row (was demographic-typed values only)
  const filteredRows = filterLinkableRows(linkableRows, linkSearch)

  return (
    <div
      className="w-96 flex-shrink-0 sticky top-4 bg-mm-surface rounded-lg border border-mm-border-subtle overflow-y-auto max-h-[calc(100vh-200px)]"
      role="complementary"
      aria-label="Participant details"
    >
      {/* Header */}
      <div className="p-4 border-b border-mm-border-subtle flex items-start justify-between">
        <div className="min-w-0">
          <h3 className={`font-medium text-sm truncate ${isUnnamed ? 'text-mm-text-faint italic' : 'text-mm-text'}`} title={currentName}>{currentName}</h3>
          <p className="text-xs text-mm-text-faint">{detail.identifier}</p>
          {detail.role && (
            <p className="text-xs text-mm-text-secondary mt-0.5">
              {detail.role}
              {detail.role_auto_filled_from && (
                <span className="text-mm-text-faint ml-1">(from {detail.role_auto_filled_from})</span>
              )}
            </p>
          )}
        </div>
        <button onClick={onClose} className="text-mm-text-faint hover:text-mm-text-secondary p-1" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Speakers & Conversations */}
      {detail.linked_speakers.length > 0 && (
        <div className="p-4 border-b border-mm-border-subtle">
          <h4 className="text-xs font-medium text-mm-text-muted mb-2">Speakers</h4>
          <div className="space-y-2">
            {detail.linked_speakers.map(s => (
              <div key={s.speaker_id} className="flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className={`w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center ring-1 shrink-0 cursor-pointer hover:ring-2 transition-all ${
                        s.color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(s.is_facilitator)
                      }`}
                      style={s.color ? { backgroundColor: s.color, color: getContrastColor(s.color) } : undefined}
                      title="Change color"
                    >
                      {getSpeakerInitials(s.speaker_name)}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-3" align="start">
                    <ColorSwatchPicker
                      value={s.color || ''}
                      onChange={(color: string) => {
                        speakersApi.updateColor(Number(projectId), s.speaker_id, color || null).then(() => {
                          queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
                          queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
                          queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
                        })
                      }}
                    />
                  </PopoverContent>
                </Popover>
                <div className="min-w-0">
                  <p className="text-xs text-mm-text">{s.speaker_name}</p>
                  {s.conversations.length > 0 && (
                    <p className="text-[10px] text-mm-text-faint truncate" title={s.conversations.map(c => c.name).join(', ')}>
                      {s.conversations.map((c, i) => (
                        <span key={c.id}>
                          {i > 0 && ', '}
                          <a
                            href={`/projects/${projectId}/conversations/${c.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-mm-blue-text hover:underline"
                            title={`Open conversation "${c.name}" in new tab`}
                          >
                            {c.name}
                          </a>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Linked datasets */}
      <div className="p-4 border-b border-mm-border-subtle">
        <h4 className="text-xs font-medium text-mm-text-muted mb-2">Linked Datasets</h4>
        {detail.dataset_rows.length === 0 ? (
          <p className="text-xs text-mm-text-faint italic">No linked datasets</p>
        ) : (
          <div className="space-y-3">
            {detail.dataset_rows.map(dr => {
              const demos = demoByDataset.get(dr.dataset_id) || []
              return (
                <div key={dr.id} className="bg-mm-bg rounded p-2">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <a
                        href={`/projects/${projectId}/datasets/${dr.dataset_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group/dslink flex items-center gap-1 min-w-0 text-xs font-medium text-mm-text hover:text-mm-blue-text"
                        title={`Open dataset "${dr.dataset_name}" in new tab`}
                      >
                        <span className="truncate group-hover/dslink:underline">{dr.dataset_name}</span>
                        <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 opacity-0 group-hover/dslink:opacity-60" aria-hidden="true" />
                      </a>
                      <p className="text-[11px] text-mm-text-faint" title={dr.row_identifier ?? undefined}>{dr.row_identifier}</p>
                    </div>
                    <button
                      onClick={() => unlinkMutation.mutate(dr.id)}
                      className="text-mm-text-faint hover:text-red-500 p-0.5 flex-shrink-0"
                      title="Unlink"
                      disabled={unlinkMutation.isPending}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {demos.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {demos.map(d => {
                        // #353: type-aware value formatting. Numerics +
                        // percentages use tabular-nums for right-aligned
                        // monospaced digits. Multi-select renders as
                        // comma-separated chips. Demographic/ordinal/nominal
                        // and unknown types fall back to plain text.
                        const label = d.demographic_subtype
                          ? d.demographic_subtype.charAt(0).toUpperCase() + d.demographic_subtype.slice(1)
                          : (d.column_text || '').slice(0, 50)
                        const isNumeric = d.column_type === 'numeric' || d.column_type === 'percentage'
                        return (
                          <p key={d.column_id} className="text-[11px] text-mm-text-muted">
                            <span className="font-medium">{label}:</span>{' '}
                            {d.value
                              ? <span className={isNumeric ? 'tabular-nums' : ''}>
                                  {d.value}{d.column_type === 'percentage' && /^\d/.test(d.value) ? '%' : ''}
                                </span>
                              : <span className="italic">empty</span>}
                          </p>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Link to dataset row */}
        {!linkingDatasetId ? (
          availableDatasets.length > 0 && (
            <div className="mt-2">
              <select
                value=""
                onChange={(e) => {
                  const dsId = parseInt(e.target.value)
                  if (dsId) setLinkingDatasetId(dsId)
                }}
                className="w-full text-xs border border-mm-border-subtle rounded px-2 py-1.5 bg-mm-surface text-mm-text-secondary"
              >
                <option value="">+ Link to dataset...</option>
                {availableDatasets.map(ds => (
                  <option key={ds.id} value={ds.id}>{ds.name}</option>
                ))}
              </select>
            </div>
          )
        ) : (
          <div className="mt-2 border border-mm-border-subtle rounded bg-mm-surface">
            <div className="p-1.5 border-b border-mm-border-subtle flex items-center gap-1">
              <span className="text-[11px] text-mm-text-muted truncate max-w-[120px]" title={datasets.find(d => d.id === linkingDatasetId)?.name}>
                {datasets.find(d => d.id === linkingDatasetId)?.name}
              </span>
              <a
                href={`/projects/${projectId}/datasets/${linkingDatasetId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mm-text-faint hover:text-mm-blue-text flex-shrink-0"
                title="Open dataset in new tab"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
              <div className="flex-1" />
              <button
                onClick={() => { setLinkingDatasetId(null); setLinkSearch('') }}
                className="text-mm-text-faint hover:text-mm-text-secondary flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="p-2 border-b border-mm-border-subtle">
              <input
                type="text"
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
                placeholder="Search rows..."
                className="w-full text-xs border border-mm-border-subtle rounded px-2 py-1 bg-mm-surface text-mm-text"
                autoFocus
              />
            </div>
            <div className="max-h-48 overflow-y-auto divide-y divide-mm-border-subtle">
              {filteredRows.map(row => {
                const isLinked = !!row.linked_participant_name
                // #418: identifying values (Student_ID, names, School, \u2026),
                // not just demographic-typed ones
                const demoText = linkableRowDetail(row)
                return (
                  <button
                    key={row.row_id}
                    disabled={isLinked || linkMutation.isPending}
                    onClick={() => linkMutation.mutate({ datasetId: linkingDatasetId!, rowId: row.row_id })}
                    className={`w-full text-left px-2 py-1.5 text-xs ${
                      isLinked
                        ? 'text-mm-text-faint bg-mm-bg cursor-not-allowed'
                        : 'hover:bg-mm-surface-hover cursor-pointer text-mm-text'
                    }`}
                  >
                    <span className="font-medium">{row.row_identifier || `Row ${row.row_id}`}</span>
                    {demoText && <span className="text-mm-text-faint ml-1">{demoText}</span>}
                    {isLinked && <span className="text-mm-text-faint ml-1">({row.linked_participant_name})</span>}
                  </button>
                )
              })}
              {filteredRows.length === 0 && (
                <p className="text-xs text-mm-text-faint p-2 text-center">No rows found</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Demographics summary — scoped to actual DEMOGRAPHIC-typed columns
        * post-#353. Pre-fix this was the only place linked-row values
        * surfaced (the array contained only demographic columns); post-fix
        * the per-dataset section above shows ALL non-text values, so this
        * rolls up just the demographic subset as a cross-dataset profile.
        * Hidden when no demographic-typed columns exist (no point showing
        * an empty rollup of "all the columns are repeated below"). */}
      {(() => {
        const demoOnly = detail.linked_demographics.filter(d => d.column_type === 'demographic')
        if (demoOnly.length === 0) return null
        return (
        <div className="p-4">
          <h4 className="text-xs font-medium text-mm-text-muted mb-1">Demographics</h4>
          <div className="space-y-0.5">
            {(() => {
              const bySubtype = new Map<string, Array<{ value: string | null; dataset: string }>>()
              for (const d of demoOnly) {
                const key = d.demographic_subtype || d.column_text
                const arr = bySubtype.get(key) || []
                arr.push({ value: d.value, dataset: d.dataset_name })
                bySubtype.set(key, arr)
              }
              return [...bySubtype.entries()].map(([subtype, entries]) => {
                const uniqueValues = [...new Set(entries.filter(e => e.value).map(e => e.value))]
                const label = subtype.charAt(0).toUpperCase() + subtype.slice(1)
                if (uniqueValues.length === 0) return null
                if (uniqueValues.length === 1) {
                  return (
                    <p key={subtype} className="text-xs text-mm-text-secondary">
                      <span className="font-medium">{label}:</span> {uniqueValues[0]}
                    </p>
                  )
                }
                return (
                  <p key={subtype} className="text-xs text-mm-text-secondary">
                    <span className="font-medium">{label}:</span>{' '}
                    {entries.filter(e => e.value).map((e, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        {e.value} <span className="text-mm-text-faint">({e.dataset})</span>
                      </span>
                    ))}
                  </p>
                )
              })
            })()}
          </div>
        </div>
        )
      })()}
    </div>
  )
}
