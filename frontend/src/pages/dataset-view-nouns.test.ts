/**
 * #939 / #940 — the Data view's own nouns, and the count beside them.
 *
 * Row 47 made a hand-authored table an ordinary thing to have, and the surface
 * had not caught up: the toolbar read **"1 records"** while the caption 230 lines
 * below pluralised correctly, and deleting a row of a table of DEPARTMENTS asked
 * *"Delete response?"* and promised to *"remove all their answers"*. There is no
 * respondent and no answer in a reference table.
 *
 * ⚠️ **A source scan, because this page needs a live query client, a router and a
 * DndContext to mount** — the same reason `dataset-empty-state.test.ts` gives.
 * It carries that file's self-check (#729: a walk that resolves to nothing passes
 * by finding nothing) and asserts EXACT strings rather than searching for the
 * word "response", which still appears in local identifiers — a scan that needs
 * exclusions is the #772 phantom shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { stripComments } from '@/lib/strip-comments'

const raw = readFileSync(join(__dirname, 'DatasetView.tsx'), 'utf-8')
const src = stripComments(raw)

describe('the Data view counts records the way the rest of the app does', () => {
  it('read a real file', () => {
    expect(raw.length).toBeGreaterThan(20_000)
    expect(src).toContain('DataGridBody')
  })

  it('🔴 does not hand-roll the plural on the record counter (#939)', () => {
    // `plural`/`countLabel` exist in `lib/format.ts` and were written for this
    // exact defect — its own docstring cites "Preview (1 rows)" (#640). Both
    // sites on this page had inlined it; one of them wrongly.
    expect(src).toContain("plural(totalRows, 'record', 'records')")
    expect(
      src,
      'the toolbar counter must not append a hard-coded plural',
    ).not.toMatch(/<\/strong>\s*records/)
  })

  it('routes the caption through the same helper', () => {
    // It was correct and hand-rolled; a second implementation of one rule is how
    // the two come to disagree again.
    expect(src).toContain("countLabel(totalRows, 'record', 'records')")
    expect(src).not.toMatch(/totalRows === 1 \? 'record' : 'records'/)
  })
})

describe('the Data view calls a row a record (#940)', () => {
  it('says record in the delete confirm, not response', () => {
    expect(src).toContain('title="Delete record?"')
    expect(src).not.toContain('Delete response?')
  })

  it('does not promise to remove "their answers"', () => {
    // A departments table has no "their".
    expect(src).not.toContain('remove all their answers')
    expect(src).toContain('Every value in it is deleted with it')
  })

  it('says record in the toast', () => {
    expect(src).toContain("toast.success('Record deleted')")
    expect(src).not.toContain("toast.success('Response deleted')")
  })

  it('tells the Code Text tooltip to talk about text, not responses', () => {
    expect(src).toMatch(/open text in the Variables view to code its text\./)
  })
})

describe('a new variable starts on a type that suits the table (#941)', () => {
  it('passes the default from whether anything was imported', () => {
    // The signal is a property of the DATASET, so it is decided here and handed
    // to the dialog; `ColumnFormDialog.test.tsx` pins what the dialog does with it.
    expect(src).toContain("defaultColumnType={hasImportedColumns ? 'ordinal' : 'nominal'}")
    expect(src).toMatch(/const hasImportedColumns[\s\S]{0,200}source === 'imported'/)
  })
})
