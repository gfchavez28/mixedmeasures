/**
 * #963 — the wiring scan for the two Tier 1 surfaces jsdom cannot render.
 *
 * `AnalysisView` (32+ URL params, recharts, the whole metric stack) and
 * `CanvasView` (Tiptap, react-resizable-panels, a spatial SVG graph) have no
 * render harness in this suite, and standing one up for a load state would be a
 * larger and more fragile thing than the fix. So the RENDERED result on those
 * two is live-driven in Chrome and recorded in the commit; what this file pins
 * is the wiring a later edit could quietly undo.
 *
 * ⚠️ **Stated residual: a scan cannot see what a branch renders.** It proves the
 * query is asked, that a `ListLoad` is derived from it, and that the empty claim
 * sits behind a readiness test — not that the notice appears. Where a surface
 * CAN be rendered, render it (`RecodeWorkbench.new-rule-load-state.test.tsx`,
 * `ObservationWorkbench.test.tsx`, `creatable-combobox.test.tsx`,
 * `ParticipantCell.test.tsx` all do).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

interface Surface {
  file: string
  /** A fragment of the real source that must survive stripping — the #814
   *  self-check per narrowing: a scan that can no longer see its target passes. */
  sentinel: string
  /** The query object the claim rests on. */
  query: string
  /** The `ListLoad` derived from it. */
  load: string
  /** The words that may only be said of an answered list. */
  claim: string
  /** The array the claim is rendered from — must be a `useMemo`, never a
   *  destructuring default, which is a FRESH array on every render. */
  list: string
}

const SURFACES: Surface[] = [
  {
    file: 'pages/AnalysisView.tsx',
    sentinel: 'const submitTest = (testType: string',
    query: 'testsQuery',
    load: 'testsLoad',
    claim: 'No reliability tests yet',
    list: 'allTests',
  },
  {
    file: 'pages/CanvasView.tsx',
    sentinel: 'Create your first canvas',
    query: 'canvasesQuery',
    load: 'canvasesLoad',
    claim: 'Create your first canvas',
    list: 'allCanvases',
  },
  {
    file: 'pages/CanvasView.tsx',
    sentinel: 'No snapshots yet',
    query: 'snapshotsQuery',
    load: 'snapshotsLoad',
    claim: 'No snapshots yet',
    list: 'snapshots',
  },
]

const sources = new Map(
  // Keyed by file, de-duplicated: two of these surfaces live in ONE file.
  [...new Set(SURFACES.map(s => s.file))].map(file => [
    file,
    stripComments(readFileSync(join(SRC_DIR, file), 'utf8'), file.split('/').pop()),
  ]),
)

describe('#963 — the load-state wiring on the surfaces jsdom cannot render', () => {
  it('scans a non-empty population', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(3)
  })

  for (const s of SURFACES) {
    describe(`${s.file} — ${s.load}`, () => {
      const src = () => sources.get(s.file)!

      it('can still see the code it is scanning', () => {
        // Per file, not once for the set: a stripper that blanked one file would
        // otherwise hide behind the other one's assertions.
        expect(src()).toContain(s.sentinel)
        expect(src().length).toBeGreaterThan(5_000)
      })

      it('asks the query whether the list is known, and does not retry an answered refusal', () => {
        expect(src()).toMatch(new RegExp(`const\\s+${s.query}\\s*=\\s*useQuery\\(`))
        expect(src()).toMatch(new RegExp(`const\\s+${s.load}\\s*=\\s*useListLoad\\(\\s*${s.query}\\s*\\)`))
        // `retryUnanswered` belongs to the same query: a silent second ask only
        // doubles a wait the server already answered (#961).
        const queryBlock = src().slice(src().indexOf(`const ${s.query} = useQuery(`))
        expect(queryBlock.slice(0, 600)).toContain('retry: retryUnanswered')
      })

      it('keeps the list out of a destructuring default, which is a fresh array per render', () => {
        expect(src()).toMatch(new RegExp(`const\\s+${s.list}\\s*=\\s*useMemo\\(`))
        expect(src()).not.toMatch(new RegExp(`data:\\s*${s.list}\\s*=\\s*\\[\\]`))
      })

      it('says its empty claim only behind a readiness test', () => {
        const at = src().indexOf(s.claim)
        expect(at).toBeGreaterThan(-1)
        // The guard is within the enclosing render branch, so look back a bounded
        // way rather than at the whole file — anchored on the load object's name,
        // which is what makes this specific rather than "the file mentions ready".
        const before = src().slice(Math.max(0, at - 4_000), at)
        expect(before).toMatch(new RegExp(`${s.load}\\.status\\s*(!==|===)\\s*'ready'`))
      })
    })
  }

  it('the readiness predicate is falsifiable', () => {
    // A scan whose predicate matches anything is a scan that certifies nothing.
    const fake = "if (somethingElse.length === 0) return <p>Create your first canvas</p>"
    expect(fake).not.toMatch(/canvasesLoad\.status\s*(!==|===)\s*'ready'/)
  })

  it("AnalysisView's duplicate-test guard refuses an unanswered list", () => {
    // #395's guard reads `allTests`, which is `[]` before the list answers — so
    // during that window the saved test was invisible AND its duplicate was
    // creatable. Nothing on the server refuses a second identical test.
    const src = sources.get('pages/AnalysisView.tsx')!
    const at = src.indexOf('const submitTest = (testType: string')
    const body = src.slice(at, at + 1_200)
    expect(body).toMatch(/testsLoad\.status !== 'ready'/)
    // …and it returns rather than falling through to `createTestMutation`.
    expect(body.slice(0, body.indexOf('const existing'))).toContain('return')
  })
})

/**
 * The import wizards' own shape, which is NOT "render a load state": the check
 * that rests on the list is a GATE on proceeding, and the two non-ready states
 * were deliberately split.
 *
 * Nothing on the server refuses a duplicate dataset or conversation NAME (no
 * unique index, no 409), and the speaker↔participant collision warning has no
 * server equivalent at all — so in both wizards the client check is the only
 * one there is, and read from an unanswered list it simply does not fire.
 */
describe('#963 — the import wizards gate on their checks, and split loading from failed', () => {
  const src = (file: string) =>
    stripComments(readFileSync(join(SRC_DIR, file), 'utf8'), file.split('/').pop())

  const CASES = [
    {
      file: 'pages/DatasetImport.tsx',
      gate: 'configureStepValid',
      loads: ['existingDatasetsLoad'],
      sentinel: 'A dataset with this name already exists',
      note: 'could not be loaded, so this name was not',
    },
    {
      file: 'pages/ConversationImport.tsx',
      gate: 'speakersStepValid',
      loads: ['existingConversationsLoad', 'existingParticipantsLoad'],
      sentinel: 'A conversation with this name already exists',
      note: 'could not be loaded, so this',
    },
  ]

  for (const c of CASES) {
    describe(c.file, () => {
      const code = src(c.file)

      it('can still see the code it is scanning', () => {
        expect(code).toContain(c.sentinel)
        expect(code).toContain(`const ${c.gate} = useMemo(`)
      })

      it('blocks the step while a check is LOADING', () => {
        const at = code.indexOf(`const ${c.gate} = useMemo(`)
        const body = code.slice(at, at + 1_400)
        for (const load of c.loads) {
          expect(body).toContain(`if (${load}.status === 'loading') return false`)
        }
      })

      it('does NOT block on a failure — an unfinishable import loses the work', () => {
        const at = code.indexOf(`const ${c.gate} = useMemo(`)
        const body = code.slice(at, at + 1_400)
        for (const load of c.loads) {
          expect(body).not.toContain(`${load}.status === 'failed'`)
          expect(body).not.toContain(`${load}.status !== 'ready'`)
        }
      })

      it('says which check could not run instead of staying silent', () => {
        expect(code).toContain(c.note)
      })
    })
  }

  it("the dataset wizard's identity-pollution callout treats unknown as NOT empty", () => {
    // Read from an unanswered list the gate was `false`, so the callout was
    // SUPPRESSED and the researcher was not told that none of their IDs matched
    // anyone already in the project.
    const code = src('pages/DatasetImport.tsx')
    expect(code).toContain('hadParticipants !== false && report.created > 0 && report.matched === 0')
    expect(code).toMatch(/useRef<boolean \| undefined>/)
    // The snapshot records "unknown", never a bare length-of-nothing.
    expect(code).not.toMatch(/hadParticipantsRef\.current = \(participantsData\?\./)
  })
})

/**
 * #963 **Tier 2** — the same scan, for the Tier 2 surfaces with no render
 * harness in this suite.
 *
 * ⚠️ **Deliberately WITHOUT the `retry: retryUnanswered` assertion above.** That
 * one belongs to a query whose retry policy was measured and changed; these four
 * keep the client-wide default, and asserting a policy nobody decided would pin
 * an accident. Where a retry was reasoned about it is stated at the query.
 *
 * ⚠️ Same stated residual: a scan cannot see what a branch renders. These four
 * were read and reasoned about rather than driven, and the entry says so.
 */
describe('#963 Tier 2 — the load-state wiring on the surfaces with no harness', () => {
  interface T2 {
    file: string
    sentinel: string
    load: string
    /** The exact readiness expression guarding the claim. */
    ready: string
    claim: string
    /**
     * False when the surface is HANDED its `ListLoad` rather than deriving one.
     * `CodebookHidePanel` takes it as a prop — the page owns the two source
     * queries and two claims rest on them, so deriving a second load here would
     * be a second reader of one question.
     */
    derivesLoad?: boolean
    /**
     * False when the right answer is to SUPPRESS the claim rather than to
     * render a notice. `CodebookView`'s "All sources are hidden" is one branch
     * of a message whose other branches read the TREE — which the page gate
     * already covers with its own notice — so a second notice inside the empty
     * state would be a notice under a notice.
     */
    rendersNotice?: boolean
  }

  const T2_SURFACES: T2[] = [
    {
      file: 'components/CrossAnalysisPanel.tsx',
      sentinel: "queryKey: ['text-filtered-freq'",
      load: 'freqLoad',
      ready: "freqLoad.status !== 'ready'",
      // The claim lives in the CHILD; what this pins is that the parent — which
      // owns the query — decides before mounting it.
      claim: '<FrequencyComparisonChart',
    },
    {
      file: 'components/SubgroupFilterPanel.tsx',
      sentinel: "queryKey: ['project-columns', projectId]",
      load: 'columnsLoad',
      ready: "columnsLoad.status !== 'ready'",
      claim: 'No filter columns available',
    },
    {
      file: 'components/CopyToEquivalentsDialog.tsx',
      sentinel: "queryKey: ['equivalence-groups', projectId]",
      load: 'eqLoad',
      ready: "eqLoad.status !== 'ready'",
      claim: 'No other variables in this linked group.',
    },
    {
      file: 'components/ScratchpadSection.tsx',
      sentinel: "queryKey: ['scratchpad', projectId, false]",
      load: 'scratchpadLoad',
      ready: "scratchpadLoad.status !== 'ready'",
      claim: 'Use Jot to capture thoughts',
    },
    {
      file: 'pages/ParticipantsPage.tsx',
      sentinel: "queryKey: ['linkable-rows', projectId, linkingDatasetId]",
      load: 'linkableLoad',
      ready: "linkableLoad.status !== 'ready'",
      claim: 'No records in this dataset',
    },
    {
      file: 'pages/CodebookView.tsx',
      sentinel: "queryKey: ['text-columns', projectId]",
      load: 'sourcesLoad',
      ready: 'sourcesKnown',
      claim: 'All sources are hidden',
      rendersNotice: false,
    },
    {
      file: 'components/codebook/CodebookHidePanel.tsx',
      sentinel: 'const hasAnySources =',
      load: 'sourcesLoad',
      ready: 'sourcesKnown',
      claim: 'No codes or sources available.',
      derivesLoad: false,
    },
  ]

  const t2Sources = new Map(
    T2_SURFACES.map(s => [
      s.file,
      stripComments(readFileSync(join(SRC_DIR, s.file), 'utf8'), s.file.split('/').pop()),
    ]),
  )

  it('scans a non-empty population', () => {
    expect(T2_SURFACES).toHaveLength(7)
  })

  for (const s of T2_SURFACES) {
    describe(s.file, () => {
      const src = () => t2Sources.get(s.file)!

      it('can still see the code it is scanning', () => {
        expect(src()).toContain(s.sentinel)
        expect(src().length).toBeGreaterThan(2_000)
      })

      it('gets its ListLoad from the query object, or is handed one', () => {
        if (s.derivesLoad === false) {
          // Handed in: assert the prop exists and is REQUIRED, which is what
          // makes the page decide rather than this component guessing.
          expect(src()).toMatch(new RegExp(`${s.load}:\\s*ListLoad`))
        } else {
          expect(src()).toMatch(new RegExp(`const\\s+${s.load}\\s*=\\s*useListLoad\\(`))
        }
      })

      it('says its empty claim only behind a readiness test on that load', () => {
        const at = src().indexOf(s.claim)
        expect(at).toBeGreaterThan(-1)
        expect(src().slice(Math.max(0, at - 3_000), at)).toContain(s.ready)
      })

      it('renders the shared notice, or deliberately renders nothing', () => {
        if (s.rendersNotice === false) {
          // Suppression, not a notice — and the file must still say so, so the
          // next reader does not "finish the job" by adding one.
          expect(src()).toContain(s.ready)
        } else {
          expect(src()).toContain('<LoadState')
        }
      })
    })
  }

  it('the readiness predicate is falsifiable', () => {
    const fake = "{rows.length === 0 && <p>No filter columns available</p>}"
    for (const s of T2_SURFACES) expect(fake).not.toContain(s.ready)
  })

  it("the scratchpad picker asks about the ONE list each entity type reads", () => {
    // `entityOptions` switches on the type, so a single combined status would
    // make the Codes branch wait on the conversations request and vice versa.
    const src = t2Sources.get('components/ScratchpadSection.tsx')!
    const at = src.indexOf('const entityOptionsStatus')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 700)
    expect(body).toContain('listStatus(conversationsQuery)')
    expect(body).toContain('listStatus(codesQuery)')
    expect(body).toContain('listStatus(collectionDetailQuery)')
    // The `analysis` arm's query is disabled with no collection, and a project
    // with no collection has no analyses — an answer, not a wait.
    expect(body).toContain("defaultCollectionId == null ? 'ready'")
  })
})

/**
 * #963 Tier 2 — `DatasetTabs`' variable count, and why the guard belongs at the
 * CALL SITES.
 *
 * The component was already right and already tested: `variableCount` is
 * optional, its docstring said *"omitted while the columns query is loading"*,
 * and `DatasetTabs.test.tsx` has carried a case asserting the badge is absent
 * when it is `undefined` since the prop shipped. **Neither caller ever passed
 * `undefined`** — both handed it `columns.length` unconditionally, so the strip
 * read "Variables 0" over a payload still in flight while a green test certified
 * the behaviour nobody used. The prop is REQUIRED now, so the compiler names the
 * call sites; this scan is what keeps them honest once they compile.
 */
describe('#963 — every DatasetTabs caller gates its count on an answered list', () => {
  const CALLERS = [
    { file: 'pages/DatasetView.tsx', ready: 'columnsKnown', query: 'dataQuery' },
    { file: 'pages/RecodeWorkbench.tsx', ready: 'columnsKnown', query: 'columnsQuery' },
  ]

  const callerSources = new Map(
    CALLERS.map(c => [
      c.file,
      stripComments(readFileSync(join(SRC_DIR, c.file), 'utf8'), c.file.split('/').pop()),
    ]),
  )

  it('scans every caller, derived from the source rather than listed by hand', () => {
    // A hand-written list of two is a count that rots (#729). Re-derive it: any
    // file mounting the component must appear above.
    const mounts = [...callerSources.values()].filter(src => src.includes('<DatasetTabs'))
    expect(mounts).toHaveLength(CALLERS.length)
  })

  for (const c of CALLERS) {
    it(`${c.file} passes undefined until its list answers`, () => {
      const src = callerSources.get(c.file)!
      expect(src).toContain('<DatasetTabs')
      expect(src).toMatch(new RegExp(`const\\s+${c.ready}\\s*=\\s*listStatus\\(${c.query}\\)\\s*===\\s*'ready'`))
      const at = src.indexOf('<DatasetTabs')
      const tag = src.slice(at, src.indexOf('/>', at))
      expect(tag).toContain(`variableCount={${c.ready} ?`)
      expect(tag).toContain(': undefined}')
    })
  }

  it('the predicate is falsifiable', () => {
    expect('<DatasetTabs projectId={1} datasetId={2} variableCount={columns.length} />')
      .not.toContain('variableCount={columnsKnown ?')
  })
})

/**
 * #963 **Tier 3** — `MergeProject`, the one surface of this tier with no render
 * harness, and the row where proceeding CORRUPTS rather than merely misleads.
 *
 * The reconcile and review steps read the LOCAL codebook. Both were gated on
 * `!codesLoading`, and `isLoading` is `isPending && isFetching` — false the
 * moment a failure settles — so a failed request left `localCodes` as `[]`:
 * the reconcile step then offers no local code to collapse or link ONTO, so
 * "create new" is the only action left for every divergent code, and the review
 * step draws its provenance matrix over nothing.
 *
 * 🔴 **The server does not catch it.** `_assert_merge_compatible` refuses only
 * UNDECIDED divergent codes, and "create new" for all of them is a perfectly
 * decided mapping — so the merge duplicates the colleague's whole codebook into
 * the target, and the way back is the pre-merge safety copy.
 *
 * ⚠️ **This one BLOCKS, which is the OPPOSITE of Tier 1's decision for the
 * import wizards, deliberately.** There the failed list was an auxiliary
 * duplicate-NAME check and blocking would have lost an import; proceeding cost
 * a rename. Here the failed list IS the substance of the step. Same rule —
 * weigh what is lost by waiting against what is lost by proceeding — pointing
 * the other way, and a mutant for the "make these consistent" over-correction
 * is below.
 *
 * ⚠️ Same stated residual as the blocks above: a scan cannot see what a branch
 * renders. This page stages a `File` in component state from a Dashboard
 * handoff, so standing up a render harness for it is a larger and more fragile
 * thing than the fix; the wiring is what is pinned.
 */
describe('#963 Tier 3 — the merge wizard waits for the codebook it reconciles against', () => {
  const code = () => stripComments(
    readFileSync(join(SRC_DIR, 'pages/MergeProject.tsx'), 'utf8'), 'MergeProject.tsx',
  )

  it('can still see the code it is scanning', () => {
    expect(code()).toContain('const codesQuery = useQuery(')
    expect(code().length).toBeGreaterThan(20_000)
  })

  it('derives a ListLoad from the codebook query rather than a loading boolean', () => {
    expect(code()).toMatch(/const\s+codesLoad\s*=\s*useListLoad\(\s*codesQuery\s*\)/)
    // The boolean it replaced must be gone, not merely unused: `!codesLoading`
    // is exactly the gate that let a settled failure through.
    expect(code()).not.toContain('codesLoading')
  })

  it('BLOCKS both steps until the codebook is in hand', () => {
    for (const step of ['reconcile', 'review']) {
      expect(code()).toContain(`{step === '${step}' && codesLoad.status === 'ready' && (`)
    }
  })

  it('does NOT proceed on a failure — the import wizards’ arm must not be copied here', () => {
    // The mutant this kills is the "make these consistent" over-correction:
    // `pages/DatasetImport.tsx` and `ConversationImport.tsx` deliberately
    // proceed after a failed check, and doing that here ships a duplicated
    // codebook.
    expect(code()).not.toMatch(/step === 'reconcile' && codesLoad\.status !== 'failed'/)
    expect(code()).not.toMatch(/step === 'review' && codesLoad\.status !== 'failed'/)
  })

  it('says which non-ready state it is in, and offers a way on', () => {
    const at = code().indexOf("(step === 'reconcile' || step === 'review') && codesLoad.status !== 'ready'")
    expect(at).toBeGreaterThan(-1)
    const block = code().slice(at, at + 600)
    expect(block).toContain('<LoadState')
    expect(block).toContain('load={codesLoad}')
    expect(block).toContain('Loading your codebook…')
    expect(block).toContain('could not be loaded, so this merge cannot be set up.')
  })

  it('the predicate is falsifiable', () => {
    const fake = "{step === 'reconcile' && !codesLoading && ("
    expect(fake).not.toContain("codesLoad.status === 'ready'")
  })
})
