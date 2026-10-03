/**
 * #1029 — every coverage figure on a coding surface leaves a MACHINE coder's labels
 * out, and gets the set from `useMachineCoderIds`.
 *
 * `lib/coding-progress.ts` makes the machine set a REQUIRED argument, so a caller
 * that forgets does not compile. What the compiler cannot see is a caller passing
 * the WRONG set — `new Set()` satisfies the type and puts every model label back
 * into the gauge. Only the conversation page has a render harness for this, so the
 * other surfaces are pinned here: a POPULATION scan (every file that calls the two
 * coverage functions), its self-check, and a predicate falsifier.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import { stripComments } from '@/lib/strip-comments'

const CALL = /\b(computeCoverage|isSegmentCodedVisible)\(/g

/** Each call's argument text, found by bracket depth (a call can span lines). */
export function coverageCalls(src: string): { fn: string; args: string }[] {
  const out: { fn: string; args: string }[] = []
  for (const m of src.matchAll(CALL)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      i++
    }
    out.push({ fn: m[1], args: src.slice(start, i - 1) })
  }
  return out
}

/** The call's LAST top-level argument — where the machine set goes. */
function lastArg(args: string): string {
  let depth = 0
  let cut = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0 && args.slice(i + 1).trim()) cut = i + 1
  }
  return args.slice(cut).trim().replace(/,$/, '').trim()
}

function surfaces() {
  const found: { file: string; src: string; calls: { fn: string; args: string }[] }[] = []
  for (const abs of sourceFiles({ ext: 'tsx', floor: 100 })) {
    const src = stripComments(readFileSync(abs, 'utf8'), abs)
    const calls = coverageCalls(src)
    if (calls.length) found.push({ file: srcRel(abs), src, calls })
  }
  return found
}

describe('#1029 — coverage leaves the machine layer out on every surface', () => {
  it('every call passes the hook\'s machine set, and every caller asks the hook for it', () => {
    const offenders: string[] = []
    for (const s of surfaces()) {
      for (const c of s.calls) {
        if (lastArg(c.args) !== 'machineCoderIds') offenders.push(`${s.file}: ${c.fn}(… ${lastArg(c.args)})`)
      }
      // The set must come from the hook (or, for a component, from its prop).
      const fromHook = /useMachineCoderIds\(\)/.test(s.src)
      const fromProp = /machineCoderIds\s*[,}:]/.test(s.src) && /MachineCoderIds/.test(s.src)
      if (!fromHook && !fromProp) offenders.push(`${s.file}: no machine set from useMachineCoderIds`)
    }
    expect(offenders).toEqual([])
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('POPULATION: the scan sees all four workbenches and the progress bar', () => {
    const files = surfaces().map(s => s.file)
    for (const f of [
      'pages/CodingWorkbench.tsx', 'pages/DocumentCodingWorkbench.tsx',
      'pages/ObservationWorkbench.tsx', 'pages/TextCodingView.tsx',
      'components/SegmentProgressBar.tsx',
    ]) expect(files).toContain(f)
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('the progress bar is handed the workbench\'s set', () => {
    const src = stripComments(readFileSync(join(__dirname, 'CodingWorkbench.tsx'), 'utf8'))
    expect(src).toMatch(/<SegmentProgressBar\b[^>]*machineCoderIds=\{machineCoderIds\}/)
  })

  it('PREDICATE falsifier: an empty set is caught, a multi-line call is read whole', () => {
    const bad = coverageCalls('computeCoverage(items, s => s.codes, hidden, new Set())')
    expect(lastArg(bad[0].args)).toBe('new Set()')
    const good = coverageCalls('isSegmentCodedVisible(\n  seg.codes,\n  effectiveHidden,\n  machineCoderIds,\n)')
    expect(lastArg(good[0].args)).toBe('machineCoderIds')
  })
})

/**
 * #1077 — the scan above enumerates by the HELPER a surface should call, so it
 * was blind to the surfaces that called none: the document reader's *N coded*
 * (`s.codes.length > 0`), the conversation row's uncoded ring
 * (`applied_codes.length === 0`) — #1029's defect at three more sites, found by
 * an audit rather than by this file. So this one enumerates by what a surface
 * COMPUTES: every test of the LENGTH of a unit's applied codes. That is how a
 * client counts "coded" without the helper, and each remaining one is a recorded
 * decision — the `tests/test_layer_filter_sites.py` shape. A new one fails with
 * the question to answer: is this a COUNT of coding (route it through
 * `lib/coding-progress.ts` or read the server's count) or something else
 * (add it here with the reason)?
 */
const LENGTH_TEST = new RegExp(
  String.raw`\b\w+\.(?:applied_codes|applied_code_ids|applied_code_details)\??\.length\b`
  + String.raw`|\b(?:s|seg|segment|clip|comment|row|unit)\.codes\??\.length\b`,
  'g',
)

/** file → [how many, why each is not a count of coding]. */
const LENGTH_TEST_SITES: Record<string, [number, string]> = {
  'components/SegmentRow.tsx': [2,
    'the unmerge dialog\'s data-loss warning, both arms — every coder\'s codes are lost, a model\'s too'],
  'components/ByRecordPanel.tsx': [1, 'the chip list\'s render condition; the list applies the lens itself'],
  'components/qualitative-analysis/ContentBySource.tsx': [2,
    'the chip lists\' render conditions (the document reader\'s COUNT is the server\'s since #1077 a)'],
  'components/qualitative-analysis/QuoteBoardView.tsx': [3,
    'OPEN — #1077 (d): the Uncoded group; a model-only quote is filed under the model\'s code (#1060\'s class, a decision)'],
  'pages/DocumentCodingWorkbench.tsx': [3,
    'the chip row\'s render condition, and the unmerge dialog\'s data-loss warning and its count'],
  'pages/ObservationWorkbench.tsx': [2,
    'the delete-clip gate and its sentence — deleting a clip destroys a model\'s codes too'],
}

function lengthTestSites(): Map<string, number> {
  const out = new Map<string, number>()
  // Tests are excluded by the walk (`includeTests` defaults to false).
  for (const abs of sourceFiles({ ext: 'both', floor: 200 })) {
    const hits = stripComments(readFileSync(abs, 'utf8'), abs).match(LENGTH_TEST)
    if (hits) out.set(srcRel(abs), hits.length)
  }
  return out
}

describe('#1077 — a "coded" count derived from a code list\'s LENGTH is a recorded decision', () => {
  it('every length test on a unit\'s applied codes is listed, with its reason', () => {
    const found = lengthTestSites()
    const unexpected = [...found].filter(([f, n]) => LENGTH_TEST_SITES[f]?.[0] !== n)
    const vanished = Object.keys(LENGTH_TEST_SITES).filter(f => !found.has(f))
    expect({ unexpected, vanished }).toEqual({ unexpected: [], vanished: [] })
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('POPULATION: the scan finds the listed sites (a blind walk would find none)', () => {
    const total = [...lengthTestSites().values()].reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(10)
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('PREDICATE falsifier: the defect shapes match, an analysis payload\'s code list does not', () => {
    const hits = (src: string) => src.match(LENGTH_TEST)?.length ?? 0
    expect(hits('allSegments.filter(s => s.codes.length > 0).length')).toBe(1)          // #1077 (a)
    expect(hits('!segment.is_facilitator && segment.applied_codes.length === 0')).toBe(1) // #1077 (c)
    expect(hits('comment.applied_code_ids?.length > 0')).toBe(1)
    expect(hits('data.codes.length > 0 && section.codes.length')).toBe(0)
  })
})

/**
 * #1077 (b) — the Timeline's lens carries the machine set, and its three BUILDERS
 * take it from the hook. `TimedLens.machineCoderIds` is required, so a builder
 * that forgets does not compile — but `new Set()` satisfies the type and puts a
 * model's marks back on the Coders layer (the #1029 wiring rule, one seam over).
 * The analysis view's lens has no render harness that draws a timeline, so the
 * three are pinned here, as the progress bar's hand-off is above.
 */
describe('#1077 (b) — every Timeline lens gets the machine set from the hook', () => {
  const read = (rel: string) => stripComments(readFileSync(join(__dirname, '..', rel), 'utf8'))

  it('the analysis view', () => {
    const src = read('pages/QualitativeAnalysisView.tsx')
    expect(src).toMatch(/const machineCoderIds = useMachineCoderIds\(\)/)
    expect(src).toMatch(/useMemo<TimedLens>\(\s*\(\)\s*=>\s*\(\{[^}]*\bmachineCoderIds,/)
    // …and the LAYER from the view's own scope, or the Machine layer draws people.
    expect(src).toMatch(/layer: timedLayerFor\(qa\.layerScope\)/)
  })

  it('the canvas embed', () => {
    const src = read('components/canvas/QualTimelineEmbed.tsx')
    expect(src).toMatch(/const machineCoderIds = useMachineCoderIds\(\)/)
    expect(src).toMatch(/resolveTimelineCoderLens\([^)]*\bmachineCoderIds,/)
  })

  it('the canvas export', () => {
    const src = read('pages/CanvasView.tsx')
    expect(src).toMatch(/const machineCoderIds = useMachineCoderIds\(\)/)
    expect(src).toMatch(/blind: withholding, self: [^}]*, machineCoderIds \}/)
  })
})
