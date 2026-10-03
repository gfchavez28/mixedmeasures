import { useQuery } from '@tanstack/react-query'
import { Bot } from 'lucide-react'
import { codeAnalysisApi, type MachinePairAgreement } from '@/lib/api'
import { LoadState } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { formatPercent, formatStat } from '@/lib/stat-format'
import { describeProvenance } from '@/lib/machine-coder'
import { bandWord } from '@/lib/reliability-band'
import {
  MACHINE_AGREEMENT_COVERAGE_NOTE,
  MACHINE_AGREEMENT_EXPLAINER,
  MACHINE_AGREEMENT_NO_PROVENANCE,
  machineAgreementUnavailableNote,
} from '@/lib/machine-agreement-copy'

/**
 * How far each MACHINE layer reproduces each person's coding (queue row 49).
 *
 * 🔴 **Its own tab since #1030 (`ModelComparisonTab`), never inside a reliability
 * table.** It sat below the Reliability tab's tables until a lone researcher with a
 * model layer turned out never to see it: that tab needs two PEOPLE. These numbers
 * describe a MODEL. They are not inter-rater reliability,
 * they are not evidence the coding is correct, and none of them enters the
 * headline α — which is what #989's coder-kind exclusion guarantees at the
 * server. The sentences that say so are identity-pinned in
 * `lib/machine-agreement-copy.ts`; do not paraphrase them here.
 *
 * ⚠️ **Rendered only when it can return something.** The tab that mounts it is
 * offered only when a model has coded THIS project (`isModelComparisonTabVisible`,
 * from coder coverage — not the install-wide roster, #1038 g), so a project with
 * no model layer never fetches and never shows an empty section (the
 * `availableLayerScopes` rule — offering a layer that can return nothing is the
 * #806 shape).
 */
export default function MachineAgreementTable({ projectId, humanId }: {
  projectId: number
  /**
   * #1030 — ONE person to compare, or `null` for every person. Blind mode passes
   * the viewer, so a colleague's row never reaches the wire. REQUIRED: a new mount
   * must decide, because the default that leaks is the easy one to write.
   */
  humanId: number | null
}) {
  const query = useQuery({
    // The scope rides the KEY (#454): a key without it would serve every person's
    // rows from cache the moment blind mode turned on.
    queryKey: ['machine-agreement', projectId, humanId],
    queryFn: () => codeAnalysisApi.machineAgreement(projectId, humanId),
    enabled: !!projectId,
  })
  const load = useListLoad(query)

  if (load.status !== 'ready') {
    return (
      <section className="space-y-2">
        <Heading />
        <LoadState
          load={load}
          loadingLabel="Working out how closely the model matches your coding…"
          failedTitle="The model comparison could not be loaded."
          size="panel"
        />
      </section>
    )
  }

  const data = query.data
  if (!data?.available) {
    const note = machineAgreementUnavailableNote(data?.unavailable_reason)
    // ⚠️ A reason this build does not know renders NOTHING rather than a made-up
    // sentence — the stated-basis family's silence rule. A known one always
    // speaks: a blank section reads as "still thinking" (#963 Tier 3).
    if (!note) return null
    return (
      <section className="space-y-2">
        <Heading />
        <p className="text-xs text-mm-text-muted max-w-3xl">{note}</p>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <Heading />
      <p className="text-xs text-mm-text-muted max-w-3xl">{MACHINE_AGREEMENT_EXPLAINER}</p>
      {data.pairs.map(pair => <Pair key={`${pair.human_id}-${pair.machine_id}`} pair={pair} />)}
    </section>
  )
}

function Heading() {
  return (
    <h3 className="text-sm font-semibold text-mm-text flex items-center gap-1.5">
      <Bot className="w-4 h-4" aria-hidden="true" />
      Model comparison
    </h3>
  )
}

function Pair({ pair }: { pair: MachinePairAgreement }) {
  const caption =
    `${pair.machine_name} compared with ${pair.human_name}, `
    + `over ${pair.n_units} units they both worked on`
  return (
    <div className="space-y-1.5">
      <div>
        <h4 className="text-sm text-mm-text">
          {pair.machine_name} <span className="text-mm-text-muted">vs</span> {pair.human_name}
        </h4>
        {/* 🔴 The configuration, or the fact that there is none. A comparison
            against an unrecorded configuration is a number nobody can
            reproduce, and hiding that makes an undocumented model look like a
            documented one. */}
        <p className="text-xs text-mm-text-muted">
          {pair.machine_provenance
            ? describeProvenance(pair.machine_provenance)
            : MACHINE_AGREEMENT_NO_PROVENANCE}
        </p>
      </div>
      <ScrollableTable maxHeight="20rem">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-left text-xs text-mm-text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">Code</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">{pair.human_name}</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">{pair.machine_name}</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">Both</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">Agreement</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">Prevalence</th>
              <th scope="col" className="py-1 font-medium text-right">κ</th>
            </tr>
          </thead>
          <tbody>
            {pair.per_code.map(row => (
              <tr key={row.code_id} className="border-t border-border">
                {/* The whole fact in the row's accessible name — the IrrMatrix
                    idiom, so a reader is not left assembling seven cells. */}
                <th
                  scope="row"
                  className="py-1.5 pr-3 font-normal text-mm-text text-left"
                  aria-label={
                    `${row.code_name}: ${pair.human_name} applied it to ${row.human_applied} `
                    + `of ${row.n_units} units, ${pair.machine_name} to ${row.machine_applied}, `
                    + `both to ${row.both_applied}. `
                    + (row.kappa != null
                      ? `Kappa ${formatStat(row.kappa)}${row.kappa_interpretation ? `, ${bandWord(row.kappa_interpretation)}` : ''}.`
                      : 'Kappa is not defined here.')
                  }
                >
                  {row.code_name}
                </th>
                <td className="py-1.5 pr-3 text-right tabular-nums text-mm-text-muted">
                  {row.human_applied}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-mm-text-muted">
                  {row.machine_applied}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-mm-text-muted">
                  {row.both_applied}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-mm-text">
                  {formatPercent(row.percent_agreement)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-mm-text-muted">
                  {row.prevalence != null ? formatStat(row.prevalence) : '—'}
                </td>
                <td className="py-1.5 text-right tabular-nums text-mm-text">
                  {/* 🔴 An undefined statistic is a REASON, never 0.0 (#689). */}
                  {row.kappa != null
                    ? formatStat(row.kappa)
                    : <span className="text-mm-text-muted">
                      {row.undefined_reason === 'no_variance'
                        ? 'no variation'
                        : row.undefined_reason === 'insufficient_n'
                          ? 'too few units'
                          : '—'}
                    </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>
      <p className="text-xs text-mm-text-muted max-w-3xl">{MACHINE_AGREEMENT_COVERAGE_NOTE}</p>
    </div>
  )
}
