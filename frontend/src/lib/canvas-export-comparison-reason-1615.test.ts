/**
 * #1615 (lead addition from r6's found-beside) — a Canvas comparison the server answered with no
 * rows and a REASON exports that reason, as the embed shows it on screen. Before, the file printed
 * nothing for it (the embed said D275's "This comparison uses a rating score, which is hidden
 * while blind." and the document said nothing at all).
 *
 * Positive control: an empty answer with no reason (a server that predates the field) still
 * exports nothing, exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {},
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { comparisonsApi } from '@/lib/api'
import { fetchChartTables } from './canvas-export'

const NO_MACHINES: ReadonlySet<number> = new Set()
const LENS = { blind: true, self: 7, machineCoderIds: NO_MACHINES }
const COMPARISON = {
  column_ids: [1], domain_ids: [], compare_by: 9, rc_view: 'comparisons',
  test_type: 'auto', nonparametric: false,
}

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{ id: 1, content: { type: 'doc', content: [
    { type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } },
  ] } } as unknown as CanvasTheme]
}

beforeEach(() => {
  vi.mocked(comparisonsApi.groupComparison).mockReset()
})

describe('an emptied comparison exports its reason (#1615)', () => {
  it('a rating score withheld while blind: the file says so, in the embed’s words', async () => {
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue(
      { rows: [], groups: [], unavailable_reason: 'rating_withheld_blind' } as never,
    )
    const entry = (await fetchChartTables(themeWithChart(COMPARISON), 4, LENS)).get(1)
    expect(entry?.md).toContain('This comparison uses a rating score, which is hidden while blind.')
    expect(entry?.html).toContain('This comparison uses a rating score, which is hidden while blind.')
  })

  it('positive control: no reason sent — the file stays empty, as before', async () => {
    vi.mocked(comparisonsApi.groupComparison).mockResolvedValue({ rows: [], groups: [] } as never)
    // An empty export is no entry at all (`md: ''` is dropped from the map) — today's behaviour.
    const tables = await fetchChartTables(themeWithChart(COMPARISON), 4, LENS)
    expect(tables.has(1)).toBe(false)
    expect(comparisonsApi.groupComparison).toHaveBeenCalledTimes(1)
  })
})
