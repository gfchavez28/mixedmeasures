/**
 * #1544 — what the saturation curve SAYS about its scope, now that it walks the selection.
 *
 * The curve walks interviews, documents and clips only (the route has no answer arm). With
 * the selection read exactly, a selection of survey questions alone draws no point — where
 * the old reading drew the whole project — so the empty curve must say why; and questions
 * selected beside passages are left out of the curve while the rest of the page counts their
 * answers, so it says that too (the Segments CSV's words, #1535 D112/D114).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { stubChartGlobals } from '@/test-support/recharts-render'
import { SATURATION_ANSWERS_NOTE, SATURATION_NO_PASSAGE } from '@/lib/qual-comparison'
import SaturationCurve from './SaturationCurve'

vi.mock('@/lib/theme-context', () => ({
  useChartColors: () => new Proxy({}, { get: () => '#000000' }),
}))

beforeAll(() => stubChartGlobals())
afterAll(() => vi.unstubAllGlobals())
afterEach(cleanup)

const curve = (n: number) => ({
  points: Array.from({ length: n }, (_, i) => ({
    source_index: i, source_label: `C${i + 1}`, source_type: 'conversation',
    cumulative_unique_codes: i + 1, new_codes_this_source: 1, new_code_names: [`Code ${i + 1}`],
  })),
  total_unique_codes: n, total_sources: n, category_level: false, ordering: 'import_date',
})

describe('the saturation curve says what it counts (#1544)', () => {
  it('no passage source in the selection: says so, never a bare "no data"', () => {
    render(<SaturationCurve data={curve(0)} answersSelected />)
    expect(screen.getByText(SATURATION_NO_PASSAGE)).toBeInTheDocument()
    expect(screen.queryByText(/No saturation data available/)).not.toBeInTheDocument()
  })

  it('questions beside passages: the curve draws and says the answers are not part of it', () => {
    render(<SaturationCurve data={curve(3)} answersSelected />)
    expect(screen.getByText(SATURATION_ANSWERS_NOTE)).toBeInTheDocument()
    expect(screen.getByText(/3 sources analyzed/)).toBeInTheDocument()
  })

  it('control: no question selected, no note', () => {
    render(<SaturationCurve data={curve(3)} answersSelected={false} />)
    expect(screen.queryByText(SATURATION_ANSWERS_NOTE)).not.toBeInTheDocument()
    expect(screen.getByText(/3 sources analyzed/)).toBeInTheDocument()
  })
})
