/**
 * Has this embed's figure moved since the prose around it was written? (#808)
 *
 * **The thing a researcher wants from a canvas and the app could not answer.**
 * A canvas is the reporting artifact: prose with charts embedded in it. The
 * exposure is that the sentence says *"trust rises with education"* and the
 * chart beside it now shows something else, because the data changed after the
 * sentence was written. Nothing detected that, because no baseline was stored
 * anywhere to diff against — every embed is LIVE and always draws current
 * figures.
 *
 * ⚠️ **#795 is NOT this.** That signal says an upstream computed variable needs
 * recomputing. It fires only for computed columns and says nothing about
 * whether any number moved relative to what the author saw.
 *
 * ⚠️ **This had to ship AFTER #817.** A baseline captured while a comparison
 * embed drew the pooled frequency distribution would have fingerprinted the
 * WRONG figure and then faithfully reported "unchanged" forever — a wrong number
 * with a reassurance attached to it.
 *
 * ## What counts as changed
 *
 * Three decisions, each of which could have made this feature noise:
 *
 * 1. **A PROJECTION, never a hash of the payload.** Payloads carry `computed_at`
 *    timestamps and row ids that move without any figure moving; hashing them
 *    would fire on every recompute and teach the researcher to dismiss the
 *    marker — the argument #707(b) makes about the warning channel, one surface
 *    over. Each branch projects the numbers it DRAWS, and nothing else.
 * 2. **Rounded before hashing.** Float noise is not a change a reader can see.
 *    `PRECISION` is deliberately finer than any chart's display precision, so
 *    the fingerprint never claims two visibly-different numbers are the same.
 * 3. **Deterministically ordered.** Entries are sorted by a stable key, so a
 *    reordering that moves no number does not fire.
 *
 * ## What it deliberately does NOT do
 *
 * ⚠️ **A missing baseline is NOT a change.** Every embed inserted before this
 * shipped has no `figureHash`, and we cannot know what it showed last week —
 * so it makes no claim until the researcher accepts one.
 * ⚠️ **The attrs are inert in all four EXPORTS** (this directory's the internal design notes:
 * only `displayText`, `sourceContext` and `materialTag` reach them). That is
 * correct here: a baseline is a working signal for the author, not something a
 * reader of the exported document should see.
 */

/** Finer than any chart's display precision, coarse enough to kill float noise. */
const PRECISION = 4

function round(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(PRECISION)) : 0
}

/**
 * The HEADLINE reads the way the chart does — 2 dp, not the hash's 4.
 *
 * ⚠️ Found by driving: the seeded headline read `F = 690.8795` beside a chart
 * printing `690.88`, so the marker's before/after would have quoted a number
 * the researcher never saw. The two precisions answer different questions —
 * the hash must not miss a visible change, the headline must be the visible
 * number — so they are deliberately not the same constant.
 */
function display(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

/**
 * A small, stable, non-cryptographic hash (FNV-1a).
 *
 * ⚠️ Not a security primitive and never used as one — it answers "are these the
 * same numbers?", where a collision costs a missed warning, not a breach.
 */
function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export interface FigureFingerprint {
  /** Identifies the numbers drawn. */
  hash: string
  /** The one figure worth showing a before/after for; '' when there isn't one. */
  headline: string
}

/** `[key, ...numbers]` rows, sorted by key, hashed together. */
function fingerprintOf(rows: [string, ...number[]][], headline: string): FigureFingerprint {
  const body = rows
    .map(([key, ...nums]) => `${key}:${nums.map(round).join(',')}`)
    .sort()
    .join('|')
  return { hash: hash(body), headline }
}

interface GroupStatLike { group: string; n: number; mean?: number | null; sd?: number | null }
interface ComparisonRowLike {
  label: string
  full_label?: string
  group_stats: GroupStatLike[]
  test?: { test_type: string; statistic: number; p: number } | null
}

/**
 * A group comparison: per group its n and mean, plus the test.
 *
 * Mirrors what `GroupComparisonTable` prints — the SD and the effect size ride
 * along because they are on screen too, and a change in either is a change the
 * prose may be wrong about.
 */
export function fingerprintComparison(
  data: { groups: string[]; rows: ComparisonRowLike[] },
): FigureFingerprint {
  const rows: [string, ...number[]][] = []
  for (const row of data.rows) {
    for (const g of row.group_stats) {
      rows.push([`${row.label}/${g.group}`, g.n, g.mean ?? 0, g.sd ?? 0])
    }
    if (row.test) rows.push([`${row.label}/test`, row.test.statistic, row.test.p])
  }
  const first = data.rows[0]?.test
  return fingerprintOf(
    rows,
    first ? `${first.test_type === 'one_way_anova' ? 'F' : 'statistic'} = ${display(first.statistic)}` : '',
  )
}

interface MetricResultLike {
  group_value: string | null
  valid_n: number
  result_data: unknown
}
interface MetricLike {
  id: number
  input_source_label?: string | null
  results: MetricResultLike[]
}

/**
 * A metric chart: every numeric leaf of every result, keyed by metric and group.
 *
 * ⚠️ Walks `result_data` rather than naming its fields, because its shape
 * differs per metric type (counts/percentages, mean/sd/min/max, proportion) —
 * and a named-field projection would silently stop covering a metric type
 * added later. Non-numeric leaves are ignored: a label is not a figure.
 */
export function fingerprintMetrics(metrics: MetricLike[]): FigureFingerprint {
  const rows: [string, ...number[]][] = []
  for (const m of metrics) {
    for (const r of m.results) {
      const nums: number[] = [r.valid_n]
      const walk = (v: unknown) => {
        if (typeof v === 'number') nums.push(v)
        else if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') {
          for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            walk((v as Record<string, unknown>)[k])
          }
        }
      }
      walk(r.result_data)
      rows.push([`${m.id}/${r.group_value ?? ''}`, ...nums])
    }
  }
  const firstN = metrics[0]?.results[0]?.valid_n
  return fingerprintOf(rows, firstN != null ? `n = ${firstN}` : '')
}

/** A qualitative source-frequency chart: per source, per code, the counts. */
export function fingerprintSourceFrequencies(
  data: {
    // Structurally typed and deliberately LOOSE: the payload carries more per
    // source than this reads, and naming the response type here would couple
    // the fingerprint to fields it does not fingerprint.
    sources: {
      source_id: number
      source_type: string
      coded_segments: number
      // ⚠️ NULLABLE on the wire, and a `?? {}` at the use site is what keeps
      // a source with no coded segments from throwing here.
      code_counts: Record<string, { count: number }> | null
    }[]
    totals?: { coded_segments?: number } | null
  },
): FigureFingerprint {
  const rows: [string, ...number[]][] = []
  for (const s of data.sources) {
    rows.push([`${s.source_type}${s.source_id}`, s.coded_segments])
    for (const [codeId, c] of Object.entries(s.code_counts ?? {})) {
      rows.push([`${s.source_type}${s.source_id}/${codeId}`, c.count])
    }
  }
  const coded = data.totals?.coded_segments
  return fingerprintOf(rows, coded != null ? `${coded} coded` : '')
}

/**
 * What the embed should say about its baseline.
 *
 * ⚠️ **Three states, and only one of them speaks.** No baseline says nothing
 * (we cannot know what it showed before). A matching baseline says nothing —
 * silence is the signal that everything is fine, and a green tick on every
 * embed would be the noise this feature must not become.
 */
export function figureDrift(
  stored: { hash?: string | null; headline?: string | null; stampedAt?: string | null },
  current: FigureFingerprint | null,
): { changed: boolean; was: string; now: string; stampedAt: string | null } | null {
  if (!stored.hash || !current) return null
  if (stored.hash === current.hash) return null
  return {
    changed: true,
    was: stored.headline ?? '',
    now: current.headline,
    stampedAt: stored.stampedAt ?? null,
  }
}
