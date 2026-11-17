/**
 * #1544 — the saturation curve reads the selection by the comparison's rule (#1297): nothing
 * selected → no list (every source); anything selected → exactly the selection's passage
 * sources, an unselected kind as `''` (none of it). ONE builder, `saturationParams`, for the
 * page's query and the Canvas (`buildQualSaturationParams`, which the embed and its export
 * share).
 *
 * Until #1544 both sent only the kinds that held a selection, and the route read an absent
 * kind as every source of it: one selected interview walked every document and clip in the
 * project (the 2026-11-06e audit measured 5 sources where 1 was selected).
 *
 * ⚠️ The page half is a SOURCE scan, stated as such: no unit test mounts
 * `QualitativeAnalysisView` on its saturation chart. The builder halves are behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { saturationParams, type QualSourceSelection } from '@/lib/qual-comparison'
import {
  buildQualSaturationParams, extractQualComputeParams,
} from '@/components/canvas/inline-chart-params'

const BASE = { exclude_facilitator: true, category_level: false, coder_ids: '4', layer_scope: 'human' as const }
const sel = (over: Partial<Record<keyof QualSourceSelection, number[]>> = {}): QualSourceSelection => ({
  conversations: [], textColumns: [], documents: [], observations: [], ...over,
})

describe('saturationParams — the one builder', () => {
  it('one conversation selected: the other passage kinds are sent as none', () => {
    expect(saturationParams(BASE, sel({ conversations: [7] }))).toEqual({
      ...BASE, conversation_ids: '7', document_ids: '', observation_ids: '',
    })
  })

  it('documents only, and a mixed selection, are exactly the selection', () => {
    expect(saturationParams(BASE, sel({ documents: [3, 9] }))).toMatchObject({
      conversation_ids: '', document_ids: '3,9', observation_ids: '',
    })
    expect(saturationParams(BASE, sel({ conversations: [2], observations: [5] }))).toMatchObject({
      conversation_ids: '2', document_ids: '', observation_ids: '5',
    })
  })

  it('questions only: every passage kind is none — an empty curve, never the whole project', () => {
    expect(saturationParams(BASE, sel({ textColumns: [11] }))).toEqual({
      ...BASE, conversation_ids: '', document_ids: '', observation_ids: '',
    })
  })

  it('never sends the question list — the route has no such parameter', () => {
    const out = saturationParams(BASE, sel({ textColumns: [11], conversations: [7] })) as Record<string, unknown>
    expect('text_column_ids' in out).toBe(false)
  })

  it('control: nothing selected sends no list at all — every source, as before', () => {
    const out = saturationParams(BASE, sel())
    expect(out).toEqual(BASE)
    expect('conversation_ids' in out).toBe(false)
  })
})

function qualConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tab: 'descriptives', source: 'all', code_mode: 'codes', code_ids: [65],
    conversation_ids: [], text_column_ids: [], document_ids: [], observation_ids: [],
    exclude_facilitator: true, participant_ids: [9], coder_ids: [4], layer_scope: 'human',
    chart_type: 'saturation', ...over,
  }
}

describe('the Canvas builder IS the page builder', () => {
  const cases: [string, Partial<Record<keyof QualSourceSelection, number[]>>][] = [
    ['one conversation', { conversations: [7] }],
    ['documents only', { documents: [3] }],
    ['questions only', { textColumns: [11] }],
    ['questions beside a clip', { textColumns: [11], observations: [5] }],
    ['nothing saved', {}],
  ]
  it.each(cases)('%s: the embed sends what the page sends', (_name, picked) => {
    const s = sel(picked)
    const config = qualConfig({
      conversation_ids: s.conversations, text_column_ids: s.textColumns,
      document_ids: s.documents, observation_ids: s.observations,
    })
    expect(buildQualSaturationParams(extractQualComputeParams(config))).toEqual(saturationParams(BASE, s))
  })
})

const PAGE = stripComments(readFileSync(join(__dirname, '..', 'pages', 'QualitativeAnalysisView.tsx'), 'utf8'))

describe('the page’s saturation query (source scan)', () => {
  const block = PAGE.match(/const saturationRequest = useMemo\(\(\) => saturationParams\([\s\S]*?\n {2}\}\)\n/)?.[0] ?? ''

  it('builds its request with the one builder, from the WHOLE selection', () => {
    expect(block).not.toBe('')
    // The SELECTION object, not the deps array beside it (which names all four either way).
    expect(block).toMatch(/\}, \{\s*conversations: qa\.selectedConversationIds, textColumns: qa\.selectedTextColumnIds,\s*documents: qa\.selectedDocumentIds, observations: qa\.selectedObservationIds,\s*\}\)/)
    // #454: the effective (blind-forced) scope, which rides inside the request.
    expect(block).toMatch(/coder_ids: effectiveCoderIncludeCsv/)
  })

  it('keys on the request it sends — so the key moves with everything sent', () => {
    expect(block).toMatch(/queryKey: \['qual-saturation', pid, saturationRequest\]/)
    expect(block).toMatch(/queryFn: \(\) => codeAnalysisApi\.saturation\(pid, saturationRequest\)/)
    // Positive control for the absence: the page asks for saturation exactly once.
    expect(PAGE.match(/codeAnalysisApi\.saturation\(/g)?.length).toBe(1)
  })
})
