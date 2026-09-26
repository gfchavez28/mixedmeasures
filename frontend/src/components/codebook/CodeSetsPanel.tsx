import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { codeSetsApi, codesApi, serverDetailMessage, type Code, type CodeSet } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { LoadState } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import { describeSetBasis } from '@/lib/code-set-basis'

/**
 * The exhaustiveness checkbox's visible words, declared ONCE (#997).
 *
 * Two controls render it — one per set, one in the create form — and each must
 * name itself with this string PLUS what it acts on. Keeping the sentence in a
 * constant is what stops the visible label and the accessible name drifting
 * apart, which would break WCAG 2.5.3 (the name must CONTAIN the visible text)
 * silently and in only one of the two places.
 */
const EXHAUSTIVE_LABEL = 'Every passage must take one of these values'

/**
 * Authoring surface for code sets — the variables a passage takes ONE value of
 * (row 48).
 *
 * ⚠️ **A set is AUTHORED, which is why this exists at all.** Its sibling
 * `CodeEquivalenceGroup` deliberately has no management UI: those are produced
 * by the merge reconcile flow as a consequence of two codebooks meeting. A code
 * set is a measurement instrument the researcher designs before coding starts,
 * so with no create affordance the capability is, for discovery, absent.
 *
 * 🔴 **Every refusal shown here is the SERVER's, verbatim.** The membership
 * rules (universal, inactive, already in another set, grouped with a code
 * outside the set) live in `services/code_sets.py`, and inventing a client-side
 * copy of them is how the two start disagreeing about which codes are offered.
 */
export function CodeSetsPanel({
  projectId,
  onClose,
}: {
  projectId: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [newLabel, setNewLabel] = useState('')
  const [newExhaustive, setNewExhaustive] = useState(false)
  const [addingTo, setAddingTo] = useState<number | null>(null)

  const setsQuery = useQuery({
    queryKey: ['code-sets', projectId],
    queryFn: () => codeSetsApi.list(projectId),
  })
  const codesQuery = useQuery({
    queryKey: ['codes', projectId, 'all'],
    queryFn: () => codesApi.list(projectId, true),
  })
  // A claim that rests on SEVERAL lists waits for all of them (#961): the
  // "codes not yet in a set" list below is a statement about both.
  const load = useListLoad(setsQuery, codesQuery)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['code-sets', projectId] })
    qc.invalidateQueries({ queryKey: ['codes', projectId] })
    // A membership change moves what the reliability tables say.
    qc.invalidateQueries({ queryKey: ['irr', projectId] })
    qc.invalidateQueries({ queryKey: ['reconciliation', projectId] })
  }
  const fail = (error: unknown) =>
    toast.error(serverDetailMessage(error) ?? 'That change could not be saved.')

  const createSet = useMutation({
    mutationFn: () =>
      codeSetsApi.create(projectId, { label: newLabel.trim(), exhaustive: newExhaustive }),
    onSuccess: () => { setNewLabel(''); setNewExhaustive(false); refresh() },
    onError: fail,
  })
  const deleteSet = useMutation({
    mutationFn: (setId: number) => codeSetsApi.remove(projectId, setId),
    onSuccess: refresh,
    onError: fail,
  })
  const addCode = useMutation({
    mutationFn: ({ setId, codeId }: { setId: number; codeId: number }) =>
      codeSetsApi.addCodes(projectId, setId, [codeId]),
    onSuccess: () => { setAddingTo(null); refresh() },
    onError: fail,
  })
  const removeCode = useMutation({
    mutationFn: ({ setId, codeId }: { setId: number; codeId: number }) =>
      codeSetsApi.removeCodes(projectId, setId, [codeId]),
    onSuccess: refresh,
    onError: fail,
  })
  const setExhaustive = useMutation({
    mutationFn: ({ setId, exhaustive }: { setId: number; exhaustive: boolean }) =>
      codeSetsApi.update(projectId, setId, { exhaustive }),
    onSuccess: refresh,
    onError: fail,
  })

  const sets: CodeSet[] = setsQuery.data?.sets ?? []
  const inASet = new Set(sets.flatMap((s) => s.members.map((m) => m.id)))
  // What MAY be offered. The server refuses a universal code and an inactive
  // one, so offering either is a control that 409s (#806's shape).
  const available: Code[] = (codesQuery.data?.codes ?? []).filter(
    (c) => !c.is_universal && c.is_active && !inASet.has(c.id),
  )

  return (
    <div className="absolute right-4 top-4 z-20 w-[380px] max-h-[calc(100%-2rem)] overflow-y-auto rounded-lg border border-mm-border-subtle bg-mm-surface shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-mm-border-subtle px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Code sets</h2>
          <p className="mt-0.5 text-xs text-mm-text-muted">
            A group of codes a passage takes exactly one of — a stance, a
            decision, a category. Coders choose one value; reliability is
            reported once for the set instead of once per code.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close code sets">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* ⚠️ `LoadState` NEVER returns null — it picks between the failure notice
          and the loading line — so it is rendered only when the lists have not
          answered. Rendering it unconditionally leaves "Loading code sets…" on
          screen forever, which is what the first draft of this panel did. */}
      {load.status !== 'ready' && (
        <div className="px-4 py-3">
          <LoadState
            load={load}
            loadingLabel="Loading code sets…"
            failedTitle="Code sets could not be loaded"
            size="panel"
          />
        </div>
      )}

      {load.status === 'ready' && (
        <div className="space-y-4 px-4 py-3">
          {sets.length === 0 && (
            <p className="text-xs text-mm-text-muted">
              No code sets yet. Create one below, then add the codes that are its
              values.
            </p>
          )}

          {sets.map((set) => (
            // 🔴 #997 — `role="group"` named by the heading, and every control
            // inside ALSO names its set. The group is #900's remedy for
            // identically-named controls in repeated blocks; it names the SET
            // and CANNOT name the members, which is why both halves ship.
            // ⚠️ `role="group"` rather than leaving the named `<section>` as a
            // landmark: N sets would put N regions in landmark navigation.
            // ⚠️ A heading alone is NOT enough — it disambiguates in browse mode
            // and says nothing to someone tabbing (#891a).
            <section
              key={set.id}
              role="group"
              aria-labelledby={`code-set-heading-${set.id}`}
              className="rounded-md border border-mm-border-subtle p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 id={`code-set-heading-${set.id}`} className="text-sm font-medium">
                  {set.label}
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete the set ${set.label}`}
                  onClick={() => deleteSet.mutate(set.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>

              <ul className="mt-2 space-y-1">
                {set.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className={m.is_active ? '' : 'text-mm-text-muted italic'}>
                      {m.name}
                      {!m.is_active && ' (inactive)'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${m.name} from ${set.label}`}
                      onClick={() => removeCode.mutate({ setId: set.id, codeId: m.id })}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
                {set.members.length < 2 && (
                  // The statistic refuses a one-value set (`degenerate`), and
                  // the MODEL permits it because a researcher adds values one at
                  // a time — so the explanation belongs here, before they go
                  // looking for a coefficient that will not come.
                  <li className="text-xs text-amber-700 dark:text-amber-400">
                    A set needs at least two values before agreement can be
                    measured on it.
                  </li>
                )}
              </ul>

              {addingTo === set.id ? (
                <div className="mt-2 max-h-40 overflow-y-auto rounded border border-mm-border-subtle">
                  {available.length === 0 ? (
                    <p className="p-2 text-xs text-mm-text-muted">
                      Every code is already in a set.
                    </p>
                  ) : (
                    available.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        // The sibling pattern this panel already demonstrates
                        // (`Remove {code} from {set}`): a bare code name says
                        // what it IS, never which set it would join.
                        aria-label={`Add ${c.name} to ${set.label}`}
                        className="block w-full px-2 py-1 text-left text-xs hover:bg-mm-surface-hover"
                        onClick={() => addCode.mutate({ setId: set.id, codeId: c.id })}
                      >
                        {c.name}
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  // ⚠️ CONTAINS the visible text, never replaces it (WCAG 2.5.3
                  // / #907): "Add a value" is what is on screen, and a reader
                  // meeting N of these needs the set to tell them apart.
                  aria-label={`Add a value to ${set.label}`}
                  onClick={() => setAddingTo(set.id)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Add a value
                </Button>
              )}

              <div className="mt-2 flex items-start gap-2">
                <Checkbox
                  id={`exhaustive-${set.id}`}
                  // 🔴 The flag this names is the one the panel's own copy says
                  // changes what every blank MEANS, so N sets offering N
                  // identically-named checkboxes is the worst place for it.
                  // The `<Label htmlFor>` below stays: it is the click target
                  // and the visible text this name must contain.
                  aria-label={`${EXHAUSTIVE_LABEL} — ${set.label}`}
                  checked={set.exhaustive}
                  onCheckedChange={(v) =>
                    setExhaustive.mutate({ setId: set.id, exhaustive: v === true })
                  }
                />
                <div>
                  <Label htmlFor={`exhaustive-${set.id}`} className="text-xs">
                    {EXHAUSTIVE_LABEL}
                  </Label>
                  {/* 🔴 The consequence, not the setting: this flag decides
                      whether a blank is missing data or the answer "none of
                      these", and the two produce different α on the same
                      coding. The words come from the same vocabulary the
                      reliability table states. */}
                  <p className="mt-0.5 text-[11px] text-mm-text-muted">
                    {describeSetBasis(set.set_basis)}
                  </p>
                </div>
              </div>

              {set.composition_warnings.map((w) => (
                <p key={w} className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                  {w}
                </p>
              ))}
            </section>
          ))}

          <form
            className="space-y-2 border-t border-mm-border-subtle pt-3"
            onSubmit={(e) => { e.preventDefault(); if (newLabel.trim()) createSet.mutate() }}
          >
            <Label htmlFor="new-code-set-label" className="text-xs">
              New code set
            </Label>
            <Input
              id="new-code-set-label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Stance"
              className="h-8 text-xs"
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="new-code-set-exhaustive"
                // The (N+1)th identical name before #997: this one acts on a set
                // that does not exist yet, and sat adjacent in the tab order to
                // the one that acts on an existing set.
                aria-label={`${EXHAUSTIVE_LABEL} — new code set`}
                checked={newExhaustive}
                onCheckedChange={(v) => setNewExhaustive(v === true)}
              />
              <Label htmlFor="new-code-set-exhaustive" className="text-xs">
                {EXHAUSTIVE_LABEL}
              </Label>
            </div>
            <Button type="submit" size="sm" disabled={!newLabel.trim() || createSet.isPending}>
              Create
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
