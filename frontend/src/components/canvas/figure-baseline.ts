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
 * so it makes no claim until the researcher accepts one. 🔴 **One exception
 * (#1323 D12):** an embed of a chart kind that gained its FIRST fingerprint after
 * the embed was placed — its numbers are known to have changed with the release
 * that added it, so it speaks (`figurePredatesBaseline`, `CURRENT_FIGURE_EPOCH`).
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
  /**
   * The fingerprint GENERATION this projection arrived in (#1323 D12): 0 for the
   * projections #808 shipped with, higher for a chart kind that gained its first
   * fingerprint later. An embed placed before its kind had one carries no baseline,
   * and that is the one case where "no baseline" must still speak — see
   * `figurePredatesBaseline`.
   */
  epoch: number
  /** For a projection with `epoch > 0`: what changed for embeds placed before it. */
  epochNote?: string
}

/**
 * 🔴 The generation THIS build places embeds under — `ThemeEditor.insertChart`
 * writes it as the node's `figureEpoch`. Raise it in the same change that gives a
 * chart kind its first fingerprint, and give that projection the new value; until
 * then every embed of that kind placed earlier would adopt today's figures silently,
 * which is exactly how #1323's comparison would have changed its numbers under every
 * canvas with no word. ⚠️ A test pins that no projection's epoch exceeds this one.
 */
export const CURRENT_FIGURE_EPOCH = 3

interface Generation { epoch: number; note?: string }
const FIRST_GENERATION: Generation = { epoch: 0 }

/** `[key, ...numbers]` rows, sorted by key, hashed together. */
function fingerprintOf(
  rows: [string, ...number[]][], headline: string, generation: Generation = FIRST_GENERATION,
): FigureFingerprint {
  const body = rows
    .map(([key, ...nums]) => `${key}:${nums.map(round).join(',')}`)
    .sort()
    .join('|')
  return { hash: hash(body), headline, epoch: generation.epoch, epochNote: generation.note }
}

/**
 * #1323 D12 — the code-by-group comparison had no fingerprint until 1.5.9, and 1.5.9
 * changed every number it draws (participants, not passages; adjusted p-values). The
 * note names the change and not a version: whether that release is 1.5.9 or 1.6.0 is
 * still undecided, and "an update" stays true for a researcher who skips one.
 */
const QUAL_COMPARISON_GENERATION: Generation = {
  epoch: 1,
  note: 'An update changed how this comparison is counted: it now counts participants, not passages, and adjusts its p-values across the codes compared.',
}

/**
 * #1527 D90 — the co-occurrence matrix had no fingerprint until 1.5.9, and 1.5.9 changed
 * the numbers it draws three ways (#1335: a pair needs one coder; #1527 D84: a selection
 * is counted exactly; D85: an answer treated as no response is left out) and its N (D83).
 */
const COOCCURRENCE_GENERATION: Generation = {
  epoch: 2,
  note: 'An update changed how this co-occurrence is counted: a pair counts only where one coder applied both codes, the sources selected are counted exactly, answers treated as no response are left out, and N counts every passage and clip.',
}

/**
 * #1544 — the saturation curve had no fingerprint until #1544 changed which sources it walks
 * (a saved selection is counted exactly; an unselected kind was walked in full). ⚠️ This
 * generation speaks only for SATURATION embeds: each projection carries its own epoch, so an
 * embed of another kind placed under generation 2 still seeds (`figurePredatesBaseline`).
 */
const SATURATION_GENERATION: Generation = {
  epoch: 3,
  note: 'An update changed which sources this saturation curve counts: now only the ones selected. Before, it also counted every source of a kind with nothing selected — every document and clip beside the interviews chosen, for example.',
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

/**
 * A qualitative source-frequency chart: per source, per code, the counts — and, when the embed
 * draws a share of the CODED total, which rows have none.
 *
 * 🔴 #1529 D94 (1.5.9): a universal row's share of the coded total is withheld (#1526 D79 on the
 * summary table; #1529 D91 under *Per Category*; D92 leaves the row off a *Coded only* chart) —
 * a change to what the embed DRAWS that moves no count, so a counts-only projection saw nothing
 * and an embed placed before it kept quiet over a "150%" that now reads "—". With `codedShare`
 * (`inline-chart-params.ts::sourceFrequencyDrawsCodedShare`) each universal row adds one
 * `withheld/<id>` key; every other embed hashes exactly as it did, so an embed speaks only if it
 * draws a coded share AND has a universal row on it. No new generation: this kind has had a
 * fingerprint since #808, and a missing baseline is still not a change.
 */
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
    codes?: { id: number; is_universal: boolean }[]
  },
  opts: { codedShare: boolean },
): FigureFingerprint {
  const rows: [string, ...number[]][] = []
  for (const s of data.sources) {
    rows.push([`${s.source_type}${s.source_id}`, s.coded_segments])
    for (const [codeId, c] of Object.entries(s.code_counts ?? {})) {
      rows.push([`${s.source_type}${s.source_id}/${codeId}`, c.count])
    }
  }
  if (opts.codedShare) {
    for (const c of data.codes ?? []) {
      if (c.is_universal) rows.push([`withheld/${c.id}`, 1])
    }
  }
  const coded = data.totals?.coded_segments
  return fingerprintOf(rows, coded != null ? `${coded} coded` : '')
}

/**
 * #1323 D12 — the code-by-group comparison (table or bar): per group its n, per
 * code and group the count, share and passages, per code Δ and its interval, the
 * test's raw and adjusted p, its star and its "can't reach" marker, and the basis
 * (unit, correction, family size) — everything `QualComparisonTable` prints.
 *
 * ⚠️ A value that can be ABSENT (a share with no material, a Δ, an interval, an
 * effect size, a test) contributes a row only when present, so "—" and a real 0
 * hash differently — the table prints them differently.
 */
export function fingerprintQualComparison(
  data: {
    // Loose on purpose, like the source-frequency projection above.
    groups: string[]
    group_totals?: Record<string, { n: number }> | null
    codes: {
      code_id: number
      by_group: Record<string, { count: number; proportion: number | null; passages?: number }>
      delta_proportion: number | null
      delta_ci?: { lower: number; upper: number } | null
      test: {
        p_value: number
        p_adjusted: number | null
        significant: boolean
        effect_size: number | null
        can_reach_significance?: boolean | null
      } | null
    }[]
    basis?: { unit: string; correction: string; family_size: number } | null
  },
): FigureFingerprint {
  const rows: [string, ...number[]][] = []
  for (const g of data.groups) {
    const n = data.group_totals?.[g]?.n
    if (n != null) rows.push([`n/${g}`, n])
  }
  if (data.basis) {
    rows.push([`basis/${data.basis.unit}/${data.basis.correction}`, data.basis.family_size])
  }
  let starred = 0
  for (const c of data.codes) {
    for (const g of data.groups) {
      const cell = c.by_group[g]
      if (!cell) continue
      rows.push([`${c.code_id}/${g}`, cell.count, cell.passages ?? 0])
      if (cell.proportion != null) rows.push([`${c.code_id}/${g}/share`, cell.proportion])
    }
    if (c.delta_proportion != null) rows.push([`${c.code_id}/delta`, c.delta_proportion])
    if (c.delta_ci) rows.push([`${c.code_id}/ci`, c.delta_ci.lower, c.delta_ci.upper])
    const t = c.test
    if (t) {
      rows.push([`${c.code_id}/test`, t.p_value, t.p_adjusted ?? t.p_value, t.significant ? 1 : 0,
                 t.can_reach_significance === false ? 1 : 0])
      if (t.effect_size != null) rows.push([`${c.code_id}/effect`, t.effect_size])
      if (t.significant) starred += 1
    }
  }
  // The headline is what the table makes of it: how many codes carry a star, of
  // how many tested. No test (passages, or under two groups) has no headline.
  const tested = data.basis?.family_size ?? 0
  return fingerprintOf(rows, tested > 0 ? `${starred} of ${tested} codes starred` : '', QUAL_COMPARISON_GENERATION)
}

/**
 * #1527 D90 — a co-occurrence matrix: every cell of its upper triangle (the matrix is
 * symmetric) keyed by the two code ids, and its N. The proportion view is derived from
 * the same counts, so it moves only when they do. ⚠️ The key orders the two ids, so a
 * reordering of the codes — which moves no number — does not read as a change.
 */
export function fingerprintCooccurrence(
  data: {
    // Loose on purpose, like the projections above.
    codes: { id: number }[]
    matrix: number[][]
    n_units: number
  },
): FigureFingerprint {
  const rows: [string, ...number[]][] = [['n', data.n_units]]
  data.codes.forEach((a, i) => {
    for (let j = i; j < data.codes.length; j++) {
      const b = data.codes[j].id
      rows.push([`${Math.min(a.id, b)}/${Math.max(a.id, b)}`, data.matrix[i]?.[j] ?? 0])
    }
  })
  return fingerprintOf(rows, `N = ${data.n_units}`, COOCCURRENCE_GENERATION)
}

/**
 * #1544 — a saturation curve: per step its source kind, the codes it adds and the running
 * total, and the two totals — everything the curve and its summary line draw.
 *
 * ⚠️ Keyed by POSITION, because the payload names no source id: a renamed source moves no
 * number and does not speak; a different source with the same counts at the same step does
 * not either (the stated residual — its label is the only difference drawn).
 */
export function fingerprintSaturation(
  data: {
    // Loose on purpose, like the projections above.
    points: { source_index: number; source_type: string; cumulative_unique_codes: number; new_codes_this_source: number }[]
    total_unique_codes: number
    total_sources: number
    category_level: boolean
  },
): FigureFingerprint {
  const rows: [string, ...number[]][] = [['total', data.total_sources, data.total_unique_codes]]
  for (const p of data.points) {
    rows.push([`${p.source_index}/${p.source_type}`, p.new_codes_this_source, p.cumulative_unique_codes])
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const found = data.category_level
    ? plural(data.total_unique_codes, 'category', 'categories')
    : plural(data.total_unique_codes, 'code', 'codes')
  return fingerprintOf(rows, `${plural(data.total_sources, 'source', 'sources')}, ${found}`, SATURATION_GENERATION)
}

/**
 * Joint display (ROADMAP row 56, D168.5) — ONE ROW's cells as the Compact view prints them
 * (`lib/joint-display.ts::rowCells`, the one projection the view and its drift line share).
 *
 * ⚠️ Hashed as PRINTED, not at `PRECISION`: the row stores the cells themselves beside the hash
 * so its drift line can say WHICH cell moved ("Low gain: 4 of 11 → 5 of 11"), and a change the
 * view cannot show is not one the meta-inference beside it can be wrong about.
 *
 * ⚠️ The FIRST generation, and no `CURRENT_FIGURE_EPOCH` raise: that rule exists for embeds
 * placed BEFORE a kind had a fingerprint, and no joint display predates this one. A row is not
 * seeded either — its baseline is stamped when its meta-inference is saved (D168.5), so a row
 * nobody has written about makes no claim.
 */
export function fingerprintJointDisplayRow(cells: Record<string, string>): FigureFingerprint {
  const body = Object.keys(cells).sort().map(k => `${k}=${cells[k]}`).join('|')
  return { hash: hash(body), headline: '', epoch: FIRST_GENERATION.epoch }
}

/**
 * #1323 D12 — this embed has no baseline because it was placed before its chart kind
 * HAD a fingerprint (its `figureEpoch` is older than the projection's), so its figures
 * may have changed without anything recording what they were. The ONE predicate: the
 * seed (`ChartEmbedView`) must not adopt today's figures for such an embed, and
 * `figureDrift` must speak for it — two readers, one answer.
 *
 * ⚠️ A missing `figureEpoch` reads as 0: every embed placed before the attribute
 * existed. ⚠️ Only an embed with NO baseline: once a researcher marks it reviewed it
 * carries a hash, and the hash decides from then on.
 */
export function figurePredatesBaseline(
  stored: { hash?: string | null; epoch?: number | null },
  current: FigureFingerprint | null,
): boolean {
  return !stored.hash && current != null && (stored.epoch ?? 0) < current.epoch
}

/**
 * What the embed should say about its baseline.
 *
 * ⚠️ **Three states, and only one of them speaks.** No baseline says nothing
 * (we cannot know what it showed before) — except when the embed predates its
 * kind's fingerprint (`figurePredatesBaseline`), where the figures are known to
 * have changed and `note` says how. A matching baseline says nothing —
 * silence is the signal that everything is fine, and a green tick on every
 * embed would be the noise this feature must not become.
 */
export function figureDrift(
  stored: { hash?: string | null; headline?: string | null; stampedAt?: string | null; epoch?: number | null },
  current: FigureFingerprint | null,
): { changed: boolean; was: string; now: string; stampedAt: string | null; note: string } | null {
  if (figurePredatesBaseline(stored, current)) {
    return { changed: true, was: '', now: current!.headline, stampedAt: null, note: current!.epochNote ?? '' }
  }
  if (!stored.hash || !current) return null
  if (stored.hash === current.hash) return null
  return {
    changed: true,
    was: stored.headline ?? '',
    now: current.headline,
    stampedAt: stored.stampedAt ?? null,
    note: '',
  }
}
