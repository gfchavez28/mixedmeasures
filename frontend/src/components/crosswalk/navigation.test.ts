/**
 * Regression test for #320: bracket Σ badge → AnalysisView nav must include
 * the source domain ID so the quantitative tab pre-selects the domain. Pre-fix,
 * `navigateToScaleScore` wrote only `metric_id` (which AnalysisView doesn't
 * parse), landing the user on a blank tab with a metric-type filter applied
 * but no domain selected.
 *
 * The `metric_id` param is preserved as a forward-compatible hint for Phase 4.7's
 * DomainPickerPopover. Today no consumer reads it; the URL just carries it.
 */
import { describe, it, expect, vi } from 'vitest'
import type { NavigateFunction } from 'react-router-dom'
import { navigateToScaleScore, parseFocusRow, formatFocusRow } from './navigation'

describe('navigateToScaleScore (#320)', () => {
  it('writes both domains and metric_id to the URL alongside tab + metricType', () => {
    const navigate = vi.fn() as unknown as NavigateFunction

    navigateToScaleScore(navigate, /* projectId */ 7, /* metricId */ 42, /* domainId */ 5)

    expect(navigate).toHaveBeenCalledOnce()
    const url = (navigate as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    expect(url).toContain('/projects/7/analysis/quantitative')
    expect(url).toContain('tab=descriptives')
    expect(url).toContain('metricType=domain_aggregate')
    expect(url).toContain('domains=5')
    expect(url).toContain('metric_id=42')
  })

  it('writes the domain ID before the metric_id hint (param order matters for stale-URL diagnostics)', () => {
    const navigate = vi.fn() as unknown as NavigateFunction
    navigateToScaleScore(navigate, 1, 100, 200)

    const url = (navigate as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    const domainIdx = url.indexOf('domains=200')
    const metricIdx = url.indexOf('metric_id=100')
    expect(domainIdx).toBeGreaterThan(-1)
    expect(metricIdx).toBeGreaterThan(-1)
    expect(domainIdx).toBeLessThan(metricIdx)
  })
})

// Tagged-form `?focusRow=` URL params (Phase 4.9). Replaces the legacy
// `?focusRowId=N` (which silently no-op'd post-Path-A because it scrolled
// to a dead `crosswalk-orphan-row-${id}` testid).
describe('parseFocusRow (Phase 4.9)', () => {
  it('parses a valid eg-tagged value', () => {
    expect(parseFocusRow('eg:42')).toEqual({ kind: 'eg', id: 42 })
  })

  it('parses a valid col-tagged value', () => {
    expect(parseFocusRow('col:7')).toEqual({ kind: 'col', id: 7 })
  })

  it('returns null for null/empty input', () => {
    expect(parseFocusRow(null)).toBeNull()
    expect(parseFocusRow('')).toBeNull()
  })

  it('tolerates URL-encoded colons', () => {
    expect(parseFocusRow('eg%3A42')).toEqual({ kind: 'eg', id: 42 })
  })

  it('rejects malformed values', () => {
    expect(parseFocusRow('eg:')).toBeNull()
    expect(parseFocusRow(':42')).toBeNull()
    expect(parseFocusRow('eg42')).toBeNull()
    expect(parseFocusRow('row:42')).toBeNull()
    expect(parseFocusRow('eg:abc')).toBeNull()
    expect(parseFocusRow('eg:0')).toBeNull()
    expect(parseFocusRow('eg:-1')).toBeNull()
    expect(parseFocusRow('eg:1.5')).toBeNull()
  })
})

describe('formatFocusRow (Phase 4.9)', () => {
  it('formats eg + col tagged values', () => {
    expect(formatFocusRow('eg', 42)).toBe('eg:42')
    expect(formatFocusRow('col', 7)).toBe('col:7')
  })

  it('round-trips through parseFocusRow', () => {
    const formatted = formatFocusRow('col', 99)
    expect(parseFocusRow(formatted)).toEqual({ kind: 'col', id: 99 })
  })
})
