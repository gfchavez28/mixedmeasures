/**
 * #1537/#1538 (1.6.0, D122–D125, D127) — the *Filters* panel is CONTROLLED and writes only on a
 * researcher's act.
 *
 * Before, the panel held the chosen values itself and an effect rewrote the applied list from them
 * on every mount and every change of the list (the 2026-11-06b probe, in that
 * review's git-ignored kit: S1 a mount with a list wrote `[]`; S3 a
 * list changed elsewhere was rewritten to the panel's own). The page-level paths are pinned by
 * `pages/QualitativeAnalysisView.filter-state-1537.test.tsx`; this file pins the panel alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import QualFilterBar from './QualFilterBar'
import {
  NO_PARTICIPANT_MATCHES_VALUES, PARTICIPANT_FILTER_RULE, givenFilterNote, type ParticipantFilterState,
} from '@/lib/participant-filter'

afterEach(cleanup)

const OPTIONS = [
  { subtype: 'group', label: 'Group', values: [
    { value: 'X', participant_ids: [501], count: 1 }, { value: 'Y', participant_ids: [502], count: 1 },
  ] },
  { subtype: 'site', label: 'Site', values: [
    { value: 'North', participant_ids: [501], count: 1 }, { value: 'South', participant_ids: [502], count: 1 },
  ] },
]
const Y: ParticipantFilterState = { kind: 'values', values: { group: new Set(['Y']) }, ids: [502] }
const NOBODY: ParticipantFilterState = { kind: 'nobody', values: { group: new Set(['X']), site: new Set(['South']) } }

function mount(state: ParticipantFilterState) {
  const onChooseValues = vi.fn()
  const onClear = vi.fn()
  const view = render(<QualFilterBar options={OPTIONS} state={state} onChooseValues={onChooseValues} onClear={onClear} />)
  const rerender = (next: ParticipantFilterState) =>
    view.rerender(<QualFilterBar options={OPTIONS} state={next} onChooseValues={onChooseValues} onClear={onClear} />)
  return { onChooseValues, onClear, rerender }
}

describe('#1537 — the panel never writes on its own', () => {
  it.each<[string, ParticipantFilterState]>([
    ['a list with no values behind it (S1: a link, a reload, a saved analysis)', { kind: 'given', ids: [502] }],
    ['chosen values (S2: the panel reopened)', Y],
    ['values that match no one', NOBODY],
    ['no filter', { kind: 'none' }],
  ])('mounting over %s writes nothing', (_name, state) => {
    const { onChooseValues, onClear } = mount(state)
    expect(onChooseValues).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
  })

  it('S3/S3b — the applied list changing elsewhere while it is open writes nothing back', () => {
    const { onChooseValues, onClear, rerender } = mount(Y)
    rerender({ kind: 'given', ids: [501] })  // a saved analysis loaded
    rerender({ kind: 'none' })               // an unfiltered one
    expect(onChooseValues).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
  })

  it('a researcher\'s choice is reported with the values already held — the page resolves it', () => {
    const { onChooseValues } = mount(Y)
    fireEvent.click(screen.getByRole('button', { name: /^Site$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^South \(/ }))
    expect(onChooseValues).toHaveBeenCalledTimes(1)
    const values = onChooseValues.mock.calls[0][0]
    expect([...values.group]).toEqual(['Y'])
    expect([...values.site]).toEqual(['South'])
  })

  it('a choice over a given list REPLACES it — the list\'s values are not known', () => {
    const { onChooseValues } = mount({ kind: 'given', ids: [502] })
    fireEvent.click(screen.getByRole('button', { name: /^Group$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^X \(/ }))
    expect(onChooseValues).toHaveBeenCalledWith({ group: new Set(['X']) })
  })
})

describe('#1537 D124 — a list with no values behind it is said, with a Clear', () => {
  it('says how many participants it keeps and offers Clear filter, beside the rule line', () => {
    const { onClear } = mount({ kind: 'given', ids: [502] })
    expect(screen.getByText(givenFilterNote(1))).toBeInTheDocument()
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clear all/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Clear filter/ }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('is not said over chosen values, nor with no filter', () => {
    mount(Y)
    expect(screen.queryByTestId('participant-filter-given')).not.toBeInTheDocument()
    cleanup()
    mount({ kind: 'none' })
    expect(screen.queryByTestId('participant-filter-given')).not.toBeInTheDocument()
  })
})

describe('#1538 D125 — values that match no one', () => {
  it('says so in an always-mounted status region, keeps the values shown, and offers Clear all', () => {
    const { onClear } = mount(NOBODY)
    expect(screen.getByRole('status')).toHaveTextContent(NO_PARTICIPANT_MATCHES_VALUES)
    expect(screen.getByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Site, 1 chosen' })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Clear all/ }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('the status region is there, empty, before the state arrives — so its sentence is announced', () => {
    const { rerender } = mount(Y)
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()
    rerender(NOBODY)
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent(NO_PARTICIPANT_MATCHES_VALUES)
  })
})

describe('#1537 D127 — the panel\'s controls say their state', () => {
  it('the trigger says whether its list is open, and its count with a space ("Group, 1 chosen")', () => {
    mount(Y)
    const trigger = screen.getByRole('button', { name: 'Group, 1 chosen' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^Site$/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('each value says whether it is chosen', () => {
    mount(Y)
    fireEvent.click(screen.getByRole('button', { name: 'Group, 1 chosen' }))
    expect(screen.getByRole('button', { name: /^Y \(/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^X \(/ })).toHaveAttribute('aria-pressed', 'false')
  })
})
