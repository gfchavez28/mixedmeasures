/**
 * #1420 — the CLIENT half of a cross-language contract. The Word export (server) keeps a link's
 * address by `services/canvas_export.py::exportable_href`, a Python twin of `exportableHref`
 * (#1339 D8). Both run `export-href-vectors-1420.json`; the server half is
 * `backend/tests/test_canvas_export_word_1458.py`, which also reads `EXPORT_LINK_SCHEMES` from
 * `canvas-export.ts`. A security predicate in two languages agrees only if both read one table.
 */
import { describe, expect, it } from 'vitest'
import { exportableHref } from './canvas-export'
import vectors from './export-href-vectors-1420.json'

describe('#1420 — the shared link vectors, through the client', () => {
  it('has rows on both sides (a table that lost its rows would pass)', () => {
    expect(vectors.kept.length).toBeGreaterThanOrEqual(5)
    expect(vectors.refused.length).toBeGreaterThanOrEqual(10)
  })

  for (const href of vectors.kept) {
    it(`keeps ${JSON.stringify(href)}`, () => {
      expect(exportableHref(href)).not.toBeNull()
    })
  }

  for (const href of vectors.refused) {
    it(`refuses ${JSON.stringify(href)}`, () => {
      expect(exportableHref(href)).toBeNull()
    })
  }
})
