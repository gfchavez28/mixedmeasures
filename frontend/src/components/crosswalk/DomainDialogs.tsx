/**
 * CreateDomainDialog + RenameDomainDialog + ZeroMemberDialog — shadcn
 * Dialog wrappers for the three domain-editing dialogs on the crosswalk.
 * Kept together since they share Radix Dialog primitives and the shared
 * a11y guarantees those provide (focus trap, Escape close, focus
 * restoration on close).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { CATEGORY_COLORS, ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import type { BracketData, ProjectColumnInfo } from './crosswalk-types'
import type { DomainMemberInput } from '@/lib/api'

interface CreateDomainData {
  name: string
  description?: string | null
  color?: string | null
  members?: DomainMemberInput[]
}

interface CreateDomainDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (data: CreateDomainData) => void
  loading?: boolean
  /** Phase 3.5 / #322 — column IDs currently multi-selected in the Unassigned
   * panel. When non-empty, the dialog renders an opt-out checkbox to include
   * these as members of the new domain on confirm. */
  initialSelectedColumnIds?: Set<number>
  /** Resolved column lookup used to build the human-readable summary line. */
  columnsById?: Map<number, ProjectColumnInfo>
}

export function CreateDomainDialog({
  open,
  onOpenChange,
  onConfirm,
  loading = false,
  initialSelectedColumnIds,
  columnsById,
}: CreateDomainDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(CATEGORY_COLORS[0])
  const [includeMembers, setIncludeMembers] = useState(true)

  const initialIds = useMemo(
    () => (initialSelectedColumnIds ? Array.from(initialSelectedColumnIds) : []),
    [initialSelectedColumnIds],
  )
  const hasInitialSelection = initialIds.length > 0

  // Build a human-readable summary — first 3 column codes, then "+ N more".
  const summary = useMemo(() => {
    if (!hasInitialSelection) return ''
    const codes: string[] = []
    for (const id of initialIds) {
      const col = columnsById?.get(id)
      if (col?.column_code) codes.push(col.column_code)
      if (codes.length >= 3) break
    }
    const remaining = initialIds.length - codes.length
    if (codes.length === 0) return `${initialIds.length} columns`
    if (remaining > 0) return `${codes.join(', ')} and ${remaining} more`
    return codes.join(', ')
  }, [hasInitialSelection, initialIds, columnsById])

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset create-form fields when the dialog opens
      setName('')
      setDescription('')
      setColor(CATEGORY_COLORS[0])
      setIncludeMembers(true)
    }
  }, [open])

  const canSubmit = name.trim().length > 0 && !loading

  const submit = () => {
    const members: DomainMemberInput[] | undefined =
      hasInitialSelection && includeMembers
        ? initialIds.map((id) => ({ member_type: 'column' as const, member_id: id }))
        : undefined
    onConfirm({
      name: name.trim(),
      description: description.trim() || null,
      color,
      members,
    })
  }

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New variable group</DialogTitle>
          <DialogDescription>
            A variable group bundles related items (e.g., all Self Esteem items) for scale-score
            analysis. After creating, drag columns into this group's rows.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium" htmlFor="domain-name">
              Name
            </label>
            <Input
              id="domain-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Self Esteem"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
          <div>
            <label className="text-xs font-medium" htmlFor="domain-description">
              Description (optional)
            </label>
            <Textarea
              id="domain-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Color</label>
            <div className="mt-1.5">
              <ColorSwatchPicker value={color} onChange={setColor} />
            </div>
          </div>
          {hasInitialSelection && (
            <label
              className="flex items-start gap-2 rounded border border-mm-border-subtle bg-mm-bg px-3 py-2 cursor-pointer"
            >
              <Checkbox
                checked={includeMembers}
                onCheckedChange={(v) => setIncludeMembers(v === true)}
                className="mt-0.5"
                aria-label="Include selected columns as members"
              />
              <span className="text-xs flex-1 min-w-0">
                <span className="text-mm-text font-medium">
                  Include {initialIds.length} selected column{initialIds.length === 1 ? '' : 's'}
                </span>
                <span className="block text-mm-text-muted mt-0.5 truncate">Adds {summary}.</span>
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {loading ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface RenameDomainDialogProps {
  bracket: BracketData | null
  onClose: () => void
  onConfirm: (
    domainId: number,
    data: { name: string; description?: string | null; color?: string | null },
  ) => void
  loading?: boolean
}

export function RenameDomainDialog({
  bracket,
  onClose,
  onConfirm,
  loading = false,
}: RenameDomainDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(CATEGORY_COLORS[0])

  useEffect(() => {
    if (bracket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- populate rename-form fields from the selected domain when it changes
      setName(bracket.name)
      setDescription(bracket.description ?? '')
      setColor(bracket.color ?? CATEGORY_COLORS[0])
    }
  }, [bracket])

  const open = bracket != null
  const canSubmit = name.trim().length > 0 && !loading

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (loading) return
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename variable group</DialogTitle>
          <DialogDescription>
            Renaming updates the scale score metric name too.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium" htmlFor="rename-domain-name">
              Name
            </label>
            <Input
              id="rename-domain-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && bracket) {
                  e.preventDefault()
                  onConfirm(bracket.domain_id, {
                    name: name.trim(),
                    description: description.trim() || null,
                    color,
                  })
                }
              }}
            />
          </div>
          <div>
            <label className="text-xs font-medium" htmlFor="rename-domain-description">
              Description (optional)
            </label>
            <Textarea
              id="rename-domain-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Color</label>
            <div className="mt-1.5">
              <ColorSwatchPicker value={color} onChange={setColor} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              bracket &&
              onConfirm(bracket.domain_id, {
                name: name.trim(),
                description: description.trim() || null,
                color,
              })
            }
            disabled={!canSubmit}
          >
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ZeroMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  domainName: string
  onKeepEmpty: () => void
  onDeleteGroup: () => void
  loadingKeepEmpty?: boolean
  loadingDeleteGroup?: boolean
}

/**
 * Three-option confirm shown when the user removes the last member of a
 * variable group. Asks whether to keep the now-empty group or delete it;
 * Cancel aborts the removal entirely. Migrated to Radix Dialog (audit
 * Batch C, P4 step 5) for focus trap / Escape close / focus restoration
 * parity with the other crosswalk dialogs.
 */
export function ZeroMemberDialog({
  open,
  onOpenChange,
  domainName,
  onKeepEmpty,
  onDeleteGroup,
  loadingKeepEmpty = false,
  loadingDeleteGroup = false,
}: ZeroMemberDialogProps) {
  const busy = loadingKeepEmpty || loadingDeleteGroup
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Empty the variable group?</DialogTitle>
          <DialogDescription>
            This removal will leave "{domainName}" with no members. You can
            delete the group, keep it empty (to restructure later), or
            cancel.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onKeepEmpty}
            disabled={busy}
          >
            {loadingKeepEmpty ? 'Working…' : 'Keep group empty'}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onDeleteGroup}
            disabled={busy}
          >
            {loadingDeleteGroup ? 'Deleting…' : 'Delete group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
