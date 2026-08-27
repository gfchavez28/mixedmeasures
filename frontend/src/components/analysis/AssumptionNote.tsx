import type { ComparisonRow } from '@/lib/api'
import { formatPValue } from '@/lib/chart-data'
import { undefinedTooltip } from '@/lib/stat-format'
import { assumptionTestLabel, worstNormalityCaveat, leveneCaveat } from '@/lib/assumption-basis'

/**
 * #525 — normality and equal-variance beside the test that assumes them.
 *
 * The Comparisons panel has always offered *"Use non-parametric test — for
 * non-normal or ordinal data"* without telling the researcher whether their data
 * IS non-normal. jamovi and JASP show these beside every test.
 *
 * ## The caveat is not decoration
 *
 * Shapiro–Wilk misleads in BOTH directions: above n ≈ 200 it rejects normality
 * for departures too small to matter, and below n ≈ 10 it has almost no power to
 * find real ones. A bare p-value next to a toggle would make the tool more
 * confidently wrong than saying nothing, so the number and the sentence ship
 * together or not at all.
 *
 * ## What it deliberately does NOT do
 *
 * ⛔ It does not recommend a test. "Your data is non-normal, use Mann–Whitney"
 * is the automation this project has declined; the one place it does auto-pick
 * (#506) is where a real bug came from. Report the numbers; the researcher
 * decides.
 */
export default function AssumptionNote({ row }: { row: ComparisonRow }) {
  const variance = row.variance_homogeneity
  const normalities = row.group_stats
    .map(g => ({ group: g.group, n: g.n, check: g.normality }))
    .filter(x => x.check != null)

  if (!variance && normalities.length === 0) return null

  const computed = normalities.filter(x => x.check!.p != null)
  const failing = computed.filter(x => (x.check!.p as number) < 0.05)
  const caveat = worstNormalityCaveat(computed.map(x => x.n))
  // 🔴 Groups the test could not run on are NAMED, not dropped from the
  // denominator. Found by reading the live output: nine schools produced
  // "1 of 8 groups", and nothing said a ninth existed and was skipped for being
  // too small. A count that quietly shrinks reads as a complete one — the same
  // rule as the box plot's `outliers_omitted`.
  const untested = normalities.filter(x => x.check!.p == null)
  const varianceCaveat = leveneCaveat(variance)

  return (
    <div className="px-2 pb-1 text-[11px] text-mm-text-faint font-sans">
      <span className="mr-3">
        {computed.length === 0 ? (
          <span title={undefinedTooltip(normalities[0]?.check?.undefined_reason)}>
            Normality: not computable
          </span>
        ) : (
          <>
            Normality ({assumptionTestLabel(computed[0].check!.test)}):{' '}
            {failing.length === 0
              ? `no group departs at p < .05 (${computed.length} tested)`
              : `${failing.length} of ${computed.length} group${computed.length === 1 ? '' : 's'} `
                + `depart${failing.length === 1 ? 's' : ''} at p < .05 (${failing.map(f => f.group).join(', ')})`}
            {untested.length > 0 && (
              <span title={undefinedTooltip(untested[0].check!.undefined_reason)}>
                {' '}— {untested.length} not testable ({untested.map(u => u.group).join(', ')})
              </span>
            )}
          </>
        )}
      </span>
      {variance && (
        <span>
          {variance.p == null ? (
            <span title={undefinedTooltip(variance.undefined_reason)}>
              Equal variances: not computable
            </span>
          ) : (
            <>
              Equal variances ({assumptionTestLabel(variance.test, variance.center)}):{' '}
              {formatPValue(variance.p)}
              {/* 🔴 #525b — a group can be in the COMPARISON and not in the
                  TEST, and neither case used to be reported. An empty group is
                  dropped outright; a group of ONE contributes a deviation of
                  exactly zero, which reads as perfect homogeneity rather than as
                  an absence of evidence (measured: levene([1],[1,2,3,4]) gives
                  a confident p = .219 resting on that point). Same rule as the
                  normality line above — a count that quietly shrinks reads as a
                  complete one. */}
              {varianceCaveat && (
                <span className="text-mm-text-faint"> — {varianceCaveat}</span>
              )}
            </>
          )}
        </span>
      )}
      {caveat && <div className="mt-0.5 italic">{caveat}</div>}
    </div>
  )
}
