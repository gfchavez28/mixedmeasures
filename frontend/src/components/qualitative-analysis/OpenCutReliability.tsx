import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import SegmentedControl from '@/components/ui/segmented-control'
import { codeAnalysisApi, type OpenCutDisclosure } from '@/lib/api'
import { ciUnavailableNote } from '@/lib/ci-label'

/**
 * Reliability for an observation whose clips are still OPEN (slab 6b-A).
 *
 * Each coder marked their own time ranges, so there are no shared units and
 * agreement has to be defined before it can be measured. Two definitions are
 * offered because they answer different questions and can honestly disagree:
 * unitizing α scores how well the marked stretches line up (boundaries
 * included), time-binned κ asks whether the coders agreed moment by moment.
 *
 * The parameters and the modelling choices are rendered as CONTENT, not
 * footnotes. A reliability number whose bin width, tick resolution and
 * merge/drop decisions are invisible is not reproducible — which is the exact
 * opacity this feature exists to improve on.
 */

const BIN_CHOICES = [
  { value: '1', label: '1s' },
  { value: '5', label: '5s' },
  { value: '10', label: '10s' },
  { value: '30', label: '30s' },
]

interface Props {
  projectId: number
  observationId: number
  observationName: string
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

function coef(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(3)
}

export default function OpenCutReliability({ projectId, observationId, observationName }: Props) {
  const [method, setMethod] = useState<'binned' | 'unitizing'>('binned')
  const [binSeconds, setBinSeconds] = useState(1)

  const binned = useQuery({
    queryKey: ['binned-kappa', projectId, observationId, binSeconds],
    queryFn: () => codeAnalysisApi.binnedKappa(projectId, observationId, { bin_seconds: binSeconds }),
    enabled: !!projectId && !!observationId && method === 'binned',
  })
  const unitizing = useQuery({
    queryKey: ['unitizing-alpha', projectId, observationId],
    queryFn: () => codeAnalysisApi.unitizingAlpha(projectId, observationId),
    enabled: !!projectId && !!observationId && method === 'unitizing',
  })

  const active = method === 'binned' ? binned : unitizing
  const data = active.data

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          options={[
            { value: 'binned', label: 'Moment by moment' },
            { value: 'unitizing', label: 'How it was carved up' },
          ]}
          value={method}
          onChange={(v) => setMethod(v as 'binned' | 'unitizing')}
          ariaLabel="Which kind of agreement to measure"
          idPrefix="open-cut-method"
        />
        {method === 'binned' && (
          // NOT a <label>: a label names its first labelable descendant, and the
          // control's tabs are buttons — so the "1s" tab announced as "Bin size
          // Bin size in seconds" (live-drive find, 2026-07-19). The tablist's
          // own ariaLabel names the group; the visible text is decoration.
          <div className="flex items-center gap-2 text-xs text-mm-text-muted">
            <span aria-hidden="true">Bin size</span>
            <SegmentedControl
              options={BIN_CHOICES}
              value={String(binSeconds)}
              onChange={(v) => setBinSeconds(Number(v))}
              ariaLabel="Bin size in seconds"
              idPrefix="open-cut-bin"
            />
          </div>
        )}
      </div>

      <p className="text-xs text-mm-text-muted max-w-3xl">
        {method === 'binned'
          ? `The recording is cut into equal slices and each code is scored slice by slice — "at any moment, did the coders agree about what was happening?" A wider bin absorbs small timing differences and reads as more agreement, so the size is part of the result.`
          : `Scores how closely the coders' marked stretches line up, boundaries included — "did they carve the recording up the same way?" Two coders can spot every event and still score low here if they disagree about where each one starts and ends.`}
      </p>

      {active.isLoading && (
        <div className="flex items-center gap-2 text-sm text-mm-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Measuring agreement…
        </div>
      )}

      {data && !data.available && (
        <p className="text-sm text-mm-text-muted rounded-md border border-mm-surface-border bg-mm-surface px-3 py-2">
          {data.reason}
        </p>
      )}

      {data?.available && method === 'binned' && binned.data && (
        <ScrollableTable maxHeight="50vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
          <table className="w-full text-sm border-collapse">
            <caption className="sr-only">
              Time-binned agreement per code for {observationName}
            </caption>
            <thead>
              <tr className="border-b text-left text-mm-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Code</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Agreement</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">κ</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  {/* Never optional: with a rare behaviour most slices are empty
                      for everyone, so agreement can read ~99% while κ collapses.
                      The base rate is what tells a reader which they are seeing. */}
                  How often
                </th>
                <th scope="col" className="px-3 py-2 font-medium">Reading</th>
              </tr>
            </thead>
            <tbody>
              {binned.data.per_code.map(row => (
                <tr key={row.code_id} className="border-b last:border-b-0">
                  <th scope="row" className="px-3 py-2 font-normal text-left">{row.code_name}</th>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(row.percent_agreement)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {coef(row.cohens_kappa ?? row.krippendorff_alpha)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(row.prevalence)}</td>
                  <td className="px-3 py-2 text-mm-text-muted">{row.interpretation ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      )}

      {data?.available && method === 'unitizing' && unitizing.data && (
        <>
          <p className="text-sm">
            Overall α<sub>U</sub>{' '}
            <span className="font-mono tabular-nums">{coef(unitizing.data.overall?.alpha)}</span>
            {unitizing.data.overall?.interpretation && (
              <span className="text-mm-text-muted"> · {unitizing.data.overall.interpretation}</span>
            )}
          </p>
          <ScrollableTable maxHeight="50vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
            <table className="w-full text-sm border-collapse">
              <caption className="sr-only">
                Unitizing agreement per code for {observationName}
              </caption>
              <thead>
                <tr className="border-b text-left text-mm-text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">Code</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Marks</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">α<sub>U</sub></th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Share of recording</th>
                  <th scope="col" className="px-3 py-2 font-medium">Reading</th>
                </tr>
              </thead>
              <tbody>
                {unitizing.data.per_category.map(row => (
                  <tr key={row.code_id} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 font-normal text-left">{row.code_name}</th>
                    <td className="px-3 py-2 text-right tabular-nums">{row.n_units}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{coef(row.alpha)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(row.coverage_fraction)}</td>
                    <td className="px-3 py-2 text-mm-text-muted">{row.interpretation ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        </>
      )}

      {data?.available && method === 'binned' && (
        // The BQG report-both obligation (plan §8o): time-binned κ has a sibling —
        // event-matched agreement (6b-A-3) — that is specified but not built. Until
        // it ships, the panel must say so rather than present one number as "the"
        // answer; when it does ship, this line is REPLACED by the second table.
        <p className="text-xs text-mm-text-faint max-w-3xl">
          Time-binned agreement has a sibling this tool doesn’t compute yet: event-matched
          agreement, which pairs coders’ whole marks instead of slicing time. The methods
          literature recommends reporting both — until then, read this table alongside
          “How it was carved up.”
        </p>
      )}

      {data && <DisclosureNote data={data} binSeconds={method === 'binned' ? binSeconds : null} />}
    </div>
  )
}

/**
 * How the number was produced. Rendered as visible content, not a tooltip:
 * these are the choices a reader needs in order to reproduce or challenge the
 * result, and every one of them moves it.
 */
function DisclosureNote({
  data, binSeconds,
}: {
  data: { disclosure: OpenCutDisclosure }
  binSeconds: number | null
}) {
  const d = data.disclosure
  const bits: string[] = []
  if (binSeconds != null) bits.push(`${binSeconds}s bins`)
  bits.push(`${(d.tick_ms / 1000).toFixed(1)}s resolution`)
  bits.push(
    d.extent_source === 'recording'
      ? `measured over ${Math.round(d.continuum_seconds)}s of recording`
      // #622: never present a fallback denominator as the recording's length.
      : `measured over ${Math.round(d.continuum_seconds)}s of marked time — recording length unknown`,
  )
  if (d.n_merged_overlaps > 0) {
    bits.push(`${d.n_merged_overlaps} overlapping mark${d.n_merged_overlaps === 1 ? '' : 's'} merged`)
  }
  if (d.n_zero_length_dropped > 0) {
    bits.push(`${d.n_zero_length_dropped} instant mark${d.n_zero_length_dropped === 1 ? '' : 's'} not counted`)
  }
  if (d.n_clips_without_times > 0) {
    bits.push(`${d.n_clips_without_times} clip${d.n_clips_without_times === 1 ? '' : 's'} without times skipped`)
  }
  if (d.excluded_coder_ids.length > 0) {
    bits.push(`${d.excluded_coder_ids.length} coder${d.excluded_coder_ids.length === 1 ? '' : 's'} marked nothing here and are not counted`)
  }
  // #43 — the Reliability tab's κ and α now carry confidence intervals and
  // these coefficients do not. A silent blank reads as an oversight; the
  // refusal is deliberate and has a different reason for each statistic, so the
  // server sends which one and this renders it. An unknown reason renders
  // nothing rather than an invented sentence.
  const noInterval = ciUnavailableNote(d.ci_unavailable_reason)
  return (
    <>
      <p className="text-xs text-mm-text-faint max-w-3xl">
        How this was measured: {bits.join(' · ')}.
      </p>
      {noInterval && <p className="text-xs text-mm-text-faint max-w-3xl">{noInterval}</p>}
    </>
  )
}
