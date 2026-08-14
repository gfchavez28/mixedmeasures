/**
 * #701(a) — the source tree's structure and keyboard behaviour, at the consumer.
 *
 * ## A correction, recorded because it nearly became a false claim
 *
 * These tests were first written to pin that the consumer HONOURS
 * `onSetExpanded(item, true|false)` rather than toggling — after a mutant
 * (reverting the consumer's explicit `force` parameter to a plain toggle)
 * survived 120 tests.
 *
 * It survived the new tests too, and the reason is that **it is behaviourally
 * equivalent**: `useTreeKeyboardNav` only ever calls `onSetExpanded` to CHANGE
 * state — ArrowRight calls it solely when `aria-expanded="false"`, ArrowLeft
 * solely when `"true"`. A second ArrowRight on an open node steps INTO the first
 * child (the APG behaviour) and never reaches the consumer at all. So a toggling
 * consumer cannot be caught through the keyboard, because the hook's own guards
 * already close the hole.
 *
 * `force` is kept as a contract guard — a future caller that says "expand" about
 * an already-expanded node should not close it — but it is **belt-and-braces,
 * not the primary fix**, and this comment exists so nobody later mistakes an
 * untestable parameter for a tested one. The behaviour that actually protects
 * the user lives in the hook and is pinned in `useTreeKeyboardNav.test.tsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import SourceSelector from './SourceSelector'
import type { ConversationOption, TextColumnInfo } from '@/lib/api'

afterEach(cleanup)

const conversations = [
  { id: 1, name: 'Interview A', segment_count: 3, coded_count: 2 },
  { id: 2, name: 'Interview B', segment_count: 4, coded_count: 1 },
] as unknown as ConversationOption[]

function renderTree(textColumns: TextColumnInfo[] = []) {
  return render(
    <SourceSelector
      conversations={conversations}
      textColumns={textColumns}
      selectedConversationIds={new Set()}
      selectedTextColumnIds={new Set()}
      onConversationChange={vi.fn()}
      onTextColumnChange={vi.fn()}
    />,
  )
}

/**
 * The per-DATASET text-column sections, which are the branch that goes through
 * `toggleDatasetExpand`.
 *
 * ⚠️ Load-bearing fixture, and the first draft did not have it: the Conversations
 * section expands via a direct `setConvsExpanded(expand)` setter, which was
 * always correct. Testing only that branch left the toggle mutant alive through
 * SEVEN new assertions — the repro has to reach the code it indicts.
 */
const textColumns = [
  { column_id: 10, column_name: 'Q1', column_text: 'What worked?', dataset_id: 5, dataset_name: 'Survey', coded_count: 2 },
  { column_id: 11, column_name: 'Q2', column_text: 'What did not?', dataset_id: 5, dataset_name: 'Survey', coded_count: 1 },
] as TextColumnInfo[]

const tree = () => screen.getByRole('tree', { name: 'Source selection' })
const items = () => within(tree()).getAllByRole('treeitem')
const section = () => items().find(i => i.getAttribute('aria-expanded') != null)!
/** The dataset section, whose expansion runs through `toggleDatasetExpand`. */
const datasetSection = () =>
  items().find(i => (i.getAttribute('aria-owns') ?? '').startsWith('src-tree-group-dataset-'))!
const datasetChildCount = () =>
  document.getElementById(datasetSection().getAttribute('aria-owns')!)
    ?.querySelectorAll('[role="treeitem"]').length ?? 0
const childCount = () => items().filter(i => i.getAttribute('aria-level') === '2').length

/** Focus the dataset section fresh, then press — see the note in the test below. */
function press(key: string) {
  const el = datasetSection()
  el.focus()
  fireEvent.keyDown(el, { key })
}

describe('structure', () => {
  it('gives every item a level and a position in its own sibling set', () => {
    renderTree()
    for (const item of items()) {
      expect(item.getAttribute('aria-level')).toBeTruthy()
      expect(item.getAttribute('aria-posinset')).toBeTruthy()
      expect(item.getAttribute('aria-setsize')).toBeTruthy()
    }
  })

  /**
   * The section header and its children were SIBLINGS in the DOM — a
   * `role="treeitem"` followed by a `role="group"`, both inside a
   * `role="none"` wrapper. So `aria-expanded` owned nothing and a reader got a
   * flat list, losing exactly the structure a tree exists to express.
   *
   * `aria-owns` rather than nesting: the treeitem div IS the clickable row, so
   * moving the group inside it would make every child click bubble into the
   * parent's toggle.
   */
  it('points aria-owns at a group that exists', () => {
    renderTree()
    const owned = section().getAttribute('aria-owns')
    expect(owned).toBeTruthy()
    const group = document.getElementById(owned!)
    expect(group, 'aria-owns references an element that is not rendered').not.toBeNull()
    expect(group).toHaveAttribute('role', 'group')
  })

  it('counts only the sections that actually render', () => {
    // No documents, observations or text columns in this fixture, so the
    // top level is "Select all sources" + Conversations. A hand-authored set
    // size would have to know which conditional branches ran.
    renderTree()
    const roots = items().filter(i => i.getAttribute('aria-level') === '1')
    expect(roots).toHaveLength(2)
    expect(roots[0]).toHaveAttribute('aria-setsize', '2')
    expect(roots[1]).toHaveAttribute('aria-posinset', '2')
  })
})

describe('keyboard', () => {
  it('collapses with ArrowLeft and expands with ArrowRight', () => {
    renderTree()
    expect(childCount()).toBe(2)
    section().focus()
    fireEvent.keyDown(section(), { key: 'ArrowLeft' })
    expect(childCount()).toBe(0)
    fireEvent.keyDown(section(), { key: 'ArrowRight' })
    expect(childCount()).toBe(2)
  })

  /**
   * What actually protects the user: a repeated ArrowRight must never close the
   * node it just opened. It doesn't — because the hook steps INTO the subtree
   * instead of asking the consumer again. Pinned here on a real consumer, since
   * that is where a researcher meets it.
   *
   * ⚠️ Re-focus between presses. React replaces the row on re-render, so
   * `document.activeElement` falls to <body> and the hook returns early — an
   * unfocused second press is a silent no-op that passes for the wrong reason.
   * Found by probing the DOM rather than trusting a green run.
   */
  it('a repeated ArrowRight opens then steps in, never closing', () => {
    renderTree(textColumns)
    press('ArrowRight')
    expect(datasetChildCount()).toBe(2)
    press('ArrowRight')
    expect(datasetChildCount(), 'the second ArrowRight closed the node').toBe(2)
    expect(datasetSection()).toHaveAttribute('aria-expanded', 'true')
  })

  it('a repeated ArrowLeft collapses then leaves, never reopening', () => {
    renderTree(textColumns)
    press('ArrowRight')
    press('ArrowLeft')
    expect(datasetChildCount()).toBe(0)
    press('ArrowLeft')
    expect(datasetChildCount(), 'the second ArrowLeft reopened the node').toBe(0)
    expect(datasetSection()).toHaveAttribute('aria-expanded', 'false')
  })

  it('renumbers positions when the visible set changes', () => {
    renderTree()
    section().focus()
    fireEvent.keyDown(section(), { key: 'ArrowLeft' })
    const roots = items().filter(i => i.getAttribute('aria-level') === '1')
    // Collapsing removes children, not sections — the root set is unchanged,
    // and every remaining item still carries a coherent position.
    for (const r of roots) expect(r).toHaveAttribute('aria-setsize', String(roots.length))
  })
})
