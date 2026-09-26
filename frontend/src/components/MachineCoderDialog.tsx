import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { authApi, type Coder } from '@/lib/api'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import MachineProvenanceFields, {
  type MachineProvenanceValues,
} from '@/components/MachineProvenanceFields'
import {
  formatParameters, parseParameters, provenanceLockReason,
} from '@/lib/machine-coder'
import { serverDetailMessage } from '@/lib/api/error-utils'

/**
 * Edit a MACHINE coder — its name, and the configuration that produced its
 * labels (#999, closed by queue row 49).
 *
 * 🔴 **The rename half is the defect this closes.** `PATCH /auth/me` renames the
 * ACTIVE coder (J1's rule that only a coder edits their own name) and
 * `switch-coder` refuses a machine, so before `PATCH /auth/coders/{id}` a machine
 * imported under a bad name was stuck with it through every endpoint. It had to
 * be renamed in SQL during #989's own drive.
 *
 * 🔴 **The configuration half FREEZES once the coder has coded, and the SERVER
 * decides that.** Two configurations of one model are two coders; editing it
 * afterwards would silently re-label work a different configuration produced. The
 * lock rides `Coder.provenance_locked` — never re-derived here, or the form is
 * offered for an act the server 409s (the #806 shape, #974's rule).
 */
export default function MachineCoderDialog({
  coder, open, onOpenChange,
}: {
  coder: Coder | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  // 🔴 **Seeded in the INITIALISERS, and the caller KEYS this component on the
  // coder's id.** A `useEffect` that setStates the fields from props is the
  // cascading-render shape the React-Compiler lint flags, and it also has to
  // guess when to re-seed; a key makes the mount itself the re-seed, which is
  // #870 (c)'s rule (`MagnitudeStrip` is keyed on `(segmentId, code.id)` for the
  // same reason — the cursor and focus effect initialise once).
  const provenance = coder?.machine_provenance
  const [username, setUsername] = useState(coder?.username ?? '')
  const [fields, setFields] = useState<MachineProvenanceValues>(() => ({
    model: provenance?.model ?? '',
    access: provenance?.access ?? '',
    prompt: provenance?.prompt ?? '',
    parameters: formatParameters(provenance?.parameters),
  }))

  const locked = coder ? provenanceLockReason(coder) : null

  const save = useMutation({
    mutationFn: async () => {
      if (!coder) return
      const { model, access, prompt, parameters } = fields
      const trimmedModel = model.trim()
      const params = parseParameters(parameters)
      return authApi.updateCoder(coder.id, {
        username: username.trim(),
        // 🔴 Omitted while LOCKED, rather than sent unchanged: an unchanged
        // value would still be a provenance CHANGE to the endpoint, which
        // refuses one — so the researcher could not rename a coder that has
        // coded, which is exactly what #999 is about.
        ...(locked
          ? {}
          : {
            machine_provenance: trimmedModel
              ? {
                model: trimmedModel,
                ...(access ? { access } : {}),
                ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
                ...(Object.keys(params).length ? { parameters: params } : {}),
              }
              : null,
          }),
      })
    },
    onSuccess: () => {
      // Prefix-matched, so Settings' `['coders', 'all']` refreshes too.
      queryClient.invalidateQueries({ queryKey: ['coders'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(
      serverDetailMessage(err) ?? 'The coder could not be updated.',
    ),
  })

  if (!coder) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Machine coder — {coder.username}</DialogTitle>
          <DialogDescription>
            Which model produced these labels, how it was reached, and under what
            instructions. Recording it is what makes the coding citable; without
            it nobody, including you later, can say what produced these codes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="machine-name">Name</Label>
            <Input
              id="machine-name"
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>

          {locked && (
            <p
              className="text-xs rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 px-2.5 py-2 text-amber-900 dark:text-amber-100"
            >
              {locked}
            </p>
          )}

          <fieldset disabled={!!locked}>
            <MachineProvenanceFields
              idPrefix="machine"
              values={fields}
              onChange={patch => setFields(prev => ({ ...prev, ...patch }))}
            />
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {/* ⚠️ `aria-disabled` + a click guard while saving, never `disabled` —
              Chrome blurs a focused element that becomes disabled (#959's rule,
              and the list-load-state manual's). */}
          <Button
            aria-disabled={save.isPending}
            onClick={() => { if (!save.isPending) save.mutate() }}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
