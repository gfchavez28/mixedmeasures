import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { observationsApi, type Code, type Observation } from '@/lib/api'
import { LoadFailedNotice } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import type { ListLoad } from '@/lib/list-status'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'
import IrrMatrix from './IrrMatrix'
import OpenCutReliability from './OpenCutReliability'
import { openObservations, selectableObservations } from '@/lib/reconciliation-source'
import { RELIABILITY_EXPLAINER_FROZEN, RELIABILITY_EXPLAINER_OPEN } from '@/lib/source-kind-copy'

const POOLED = '__pooled__'

/**
 * The Reliability tab's scope switch (slab 6b-A item 3, mounted by #624).
 *
 * Two kinds of reliability live behind one tab because they answer the same
 * question over different unit sets: the pooled IRR matrix covers every source
 * whose units are SHARED (conversations, documents, and frozen observations —
 * the 6b-B gather), while an OPEN observation's clips are each coder's own, so
 * it gets the open-cut panel instead. The picker is the seam between them;
 * frozen observations deliberately don't appear in it — they're already inside
 * the pooled number, and offering them separately would double-report.
 *
 * Selection is plain component state, not a URL param, mirroring
 * ReconciliationGrid's source narrowing.
 */

interface ViewProps {
  projectId: number
  codes?: Code[]
  observations: Observation[]
  /**
   * #963 Tier 3 — whether `observations` is an ANSWER. The picker, and #859's
   * signpost beside it, are the only things that say open-cut reliability
   * exists; read off an unanswered list both vanish, so a failed request
   * withdraws the capability and the sentence announcing it at once — which is
   * #859's own defect, re-created by a failure.
   *
   * REQUIRED: the test view is a second mount and must decide too.
   */
  observationsLoad: ListLoad
  /** Selected OPEN observation id, or null = the pooled matrix. */
  selectedId: number | null
  onSelect: (id: number | null) => void
}

/** Controlled view — exported for tests (Radix Select can't be driven in jsdom). */
export function ReliabilityTabView({
  projectId, codes, observations, observationsLoad, selectedId, onSelect,
}: ViewProps) {
  const open = openObservations(observations)
  const frozen = selectableObservations(observations)
  // Falls back to pooled when the selection is stale — an observation frozen (or
  // deleted) after being picked stops being an open-cut source (revocable
  // eligibility, the D18 unfreeze direction).
  const selected = open.find(o => o.id === selectedId) ?? null

  return (
    <div className="flex flex-col gap-3">
      {open.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            value={selected ? String(selected.id) : POOLED}
            onValueChange={(v) => onSelect(v === POOLED ? null : Number(v))}
          >
            <SelectTrigger className="w-[260px] h-8 text-xs" aria-label="Reliability scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={POOLED}>All sources — pooled</SelectItem>
              <SelectGroup>
                <SelectLabel>Observations (open clips)</SelectLabel>
                {open.map(o => (
                  <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* ⚠️ SILENT while merely loading, on purpose: `IrrMatrix` below already
          mounts its own `role="status"` line, and a second one for a list whose
          only job is to add a picker would be a duplicate on screen and a
          second announcement (Tier 2's one-region rule — check what the
          neighbour renders). A FAILURE still gets a word, because otherwise
          nothing on the tab says the scope list is missing. */}
      {observationsLoad.status === 'failed' && (
        <div className="max-w-3xl">
          <LoadFailedNotice
            title="The reliability scope list could not be loaded."
            load={observationsLoad}
            size="panel"
          />
          <p className="text-xs text-mm-text-muted text-center">
            Observations with open clips are measured separately and are not offered here until
            the list loads. The pooled figures below are unaffected.
          </p>
        </div>
      )}

      {selected ? (
        <>
          <p className="text-xs text-mm-text-muted max-w-3xl">{RELIABILITY_EXPLAINER_OPEN}</p>
          <OpenCutReliability
            projectId={projectId}
            observationId={selected.id}
            observationName={selected.name}
          />
        </>
      ) : (
        <>
          {frozen.length > 0 && (
            <p className="text-xs text-mm-text-muted max-w-3xl">
              Frozen observations are included in the numbers below. {RELIABILITY_EXPLAINER_FROZEN}
            </p>
          )}
          {/* 🔴 #859 — the SIGNPOST, at gate 4.
              `OpenCutReliability` renders only after a NON-DEFAULT selection in
              the picker above, and this tab opens on "All sources — pooled". So
              a researcher who installed because the marketing site describes
              open-cut reliability lands here and sees a pooled matrix with no
              hint that the other measure exists — four decisions deep, three of
              them individually defensible.

              ⚠️ The remedy is deliberately NOT to weaken blind mode (gate 2 is
              a methodological choice, DEC-G) and NOT to change the default
              (pooled is the right answer for most projects). It is to SAY, where
              the pooled number renders, that these observations are not in it
              and where to look. */}
          {open.length > 0 && (
            <p className="text-xs text-mm-text-muted max-w-3xl">
              {open.length === 1 ? 'One observation has' : `${open.length} observations have`}
              {' '}open cuts, so {open.length === 1 ? 'it is' : 'they are'} not part of the pooled
              figures below — each coder marked their own clips, so agreement there is about
              <em> how the recording was carved up</em> as well as how it was coded. Choose
              {open.length === 1 ? ` "${open[0].name}"` : ' one'} in <strong>Reliability
              scope</strong> above to see it.
            </p>
          )}
          <IrrMatrix projectId={projectId} codes={codes} />
        </>
      )}

      {/* ⚠️ #1030 — the person-vs-model table USED to render here, below the
          reliability figures. It moved to its own tab (`ModelComparisonTab`):
          this tab needs two PEOPLE, so the researcher the table exists for — one
          person and an imported model layer — never reached it. Do not mount it
          back here; the tab is reachable whenever this one is. */}
    </div>
  )
}

export default function ReliabilityTab({ projectId, codes }: { projectId: number; codes?: Code[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // ⚠️ NOT `data: observations = []` — a destructuring default is a fresh array
  // on every render AND makes "no answer" indistinguishable from "none", which
  // is the whole defect (#963 §1).
  const observationsQuery = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
    enabled: !!projectId,
  })
  const observations = useMemo(() => observationsQuery.data ?? [], [observationsQuery.data])
  const observationsLoad = useListLoad(observationsQuery)
  return (
    <ReliabilityTabView
      projectId={projectId}
      codes={codes}
      observations={observations}
      observationsLoad={observationsLoad}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  )
}
