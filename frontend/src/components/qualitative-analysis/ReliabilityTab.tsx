import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { observationsApi, type Code, type Observation } from '@/lib/api'
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
  /** Selected OPEN observation id, or null = the pooled matrix. */
  selectedId: number | null
  onSelect: (id: number | null) => void
}

/** Controlled view — exported for tests (Radix Select can't be driven in jsdom). */
export function ReliabilityTabView({ projectId, codes, observations, selectedId, onSelect }: ViewProps) {
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
          <IrrMatrix projectId={projectId} codes={codes} />
        </>
      )}
    </div>
  )
}

export default function ReliabilityTab({ projectId, codes }: { projectId: number; codes?: Code[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const { data: observations = [] } = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
    enabled: !!projectId,
  })
  return (
    <ReliabilityTabView
      projectId={projectId}
      codes={codes}
      observations={observations}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  )
}
