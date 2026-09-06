/**
 * #869 (b) — the merge dialog's rating-scale disclosure.
 *
 * A code merge has no undo and the server REFUSES one whose ratings would not
 * fit the target's scale, so this dialog's job is to say what will happen to
 * the ratings BEFORE the act. These pins are about that sentence: that it is
 * rendered per source, and — the half that was actually broken — that it
 * REACHES THE ANNOUNCED DESCRIPTION of the control that performs the merge.
 *
 * Driven live 2026-09-04 (all three `describeScaleCrossing` branches in a real
 * browser). The defect the population test below pins was found there and is
 * invisible to a render-only assertion: the text was in the DOM the whole time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import MergeCodesDialog from './MergeCodesDialog'
import type { CodebookTreeResponse, CodebookCodeNode } from '@/lib/api'

afterEach(cleanup)

const code = (over: Partial<CodebookCodeNode> & { id: number; name: string }): CodebookCodeNode => ({
  numeric_id: over.id,
  description: null,
  color: null,
  is_active: true,
  is_universal: false,
  segment_count: 10,
  source_count: 2,
  excerpt_count: 0,
  category_id: null,
  ...over,
})

/** 0–10 and −1…+1: zero is INTERIOR on the second, per the degenerate-fixture rule. */
const SCALED = code({
  id: 3, name: 'Curriculum fidelity', segment_count: 17,
  magnitude_scale: { min: 0, max: 10, step: 1, anchors: [] },
})
const OTHER_SCALE = code({
  id: 5, name: 'Materials use', segment_count: 15,
  magnitude_scale: { min: -1, max: 1, step: 0.5, anchors: [] },
})
const UNSCALED = code({ id: 7, name: 'Pacing adherence', segment_count: 15 })

const treeOf = (...codes: CodebookCodeNode[]): CodebookTreeResponse => ({
  universal_codes: [],
  uncategorized_codes: codes,
  tree: [],
})

const renderDialog = (codes: CodebookCodeNode[]) =>
  render(
    <MergeCodesDialog
      open
      onOpenChange={() => {}}
      sourceCodeIds={codes.map(c => c.id)}
      treeData={treeOf(...codes)}
      onConfirm={() => {}}
    />,
  )

describe('MergeCodesDialog — the rating-scale disclosure', () => {
  it('names both scales when the source and target are rated differently', () => {
    // Target defaults to the most segments (SCALED, 17), so OTHER_SCALE is the source.
    renderDialog([SCALED, OTHER_SCALE])
    expect(
      screen.getByText(/“Materials use” is rated −1–1 and “Curriculum fidelity” 0–10/),
    ).toBeInTheDocument()
  })

  it('says the ratings cannot be shown when the target has no scale', () => {
    renderDialog([UNSCALED, SCALED]) // both 15/17 → SCALED is target… so flip:
    // SCALED has 17 segments and wins the default target; assert the branch that
    // fires for a scaled SOURCE onto an unscaled target by making it the source.
    cleanup()
    renderDialog([code({ ...UNSCALED, segment_count: 99 }), SCALED])
    expect(screen.getByText(/has a rating scale \(0–10\).*has none\./s)).toBeInTheDocument()
  })

  it('says nothing crosses when only the target is rated', () => {
    renderDialog([SCALED, UNSCALED]) // SCALED (17) is target, UNSCALED the source
    expect(screen.getByText(/nothing on “Pacing adherence” is rated, so nothing crosses/))
      .toBeInTheDocument()
  })

  it('renders no note at all when the scales agree', () => {
    const twin = code({ ...SCALED, id: 9, name: 'Twin', segment_count: 5 })
    renderDialog([SCALED, twin])
    expect(screen.queryByText(/is rated|has a rating scale|nothing crosses/)).toBeNull()
  })

  /**
   * 🔴 THE ONE THAT MATTERS, and a render assertion cannot see it.
   *
   * The Merge button is `aria-describedby="merge-summary"`, so its announced
   * description is computed FROM THAT SUBTREE — and name-from-content takes a
   * descendant's own accessible NAME in place of its text. An `aria-label` on
   * the notes list therefore replaced the whole disclosure with two words
   * ("Rating scales") on the control that performs an act with no undo.
   * Measured in Chrome's accessibility tree; jsdom computes no accname, so this
   * pins the MECHANISM instead: nothing inside the description subtree may
   * carry an accessible name.
   *
   * POPULATION assertion over every descendant, with a floor so it cannot pass
   * vacuously on an empty or missing subtree.
   */
  it('no descendant of the description subtree carries a name that would replace its text', () => {
    renderDialog([SCALED, OTHER_SCALE])
    const summary = document.getElementById('merge-summary')
    expect(summary).not.toBeNull()

    const descendants = Array.from(summary!.querySelectorAll('*'))
    expect(descendants.length).toBeGreaterThan(0) // the subtree is really populated

    const named = descendants.filter(
      el => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'),
    )
    expect(named.map(el => el.tagName.toLowerCase() + '[' + (el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby')) + ']'))
      .toEqual([])

    // …and the sentence really is inside that subtree, not merely elsewhere on
    // screen. The TARGET here is the 0–10 code (most segments wins the default),
    // so the ratings are re-read on ITS scale — the direction is the point.
    expect(summary!.textContent).toMatch(/Ratings inside 0–10 are re-read on that scale/)
  })
})
