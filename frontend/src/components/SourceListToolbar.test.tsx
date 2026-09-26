/**
 * #1008 — the toolbar the four source list pages share.
 *
 * ⚠️ Radix `Select` cannot be driven in jsdom, so the sort's CHOICES are pinned as
 * data (every direction reachable) and the arrow-flip defect is covered by that
 * property rather than by clicking. The live drive is recorded in ISSUES #1008.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import SourceListToolbar from './SourceListToolbar'
import { DATE_AND_NAME_SORTS, type SortChoice } from '@/lib/source-list-toolbar'

afterEach(cleanup)

function renderToolbar(over: Partial<Parameters<typeof SourceListToolbar>[0]> = {}) {
  const props = {
    title: 'All Conversations',
    count: 4,
    accent: 'green' as const,
    noun: 'conversations',
    onOpenCodebook: vi.fn(),
    showListControls: true,
    searchText: '',
    onSearchChange: vi.fn(),
    sortChoices: DATE_AND_NAME_SORTS,
    sortBy: 'date' as const,
    sortDir: 'desc' as const,
    onSortChange: vi.fn(),
    onImport: vi.fn(),
    ...over,
  }
  render(<SourceListToolbar {...props} />)
  return props
}

describe('the title', () => {
  it('is the page HEADING, with the count separated by a real space (#908)', () => {
    renderToolbar()
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('All Conversations 4')
  })

  it('is no longer a button that does nothing', () => {
    renderToolbar()
    expect(screen.queryByRole('button', { name: /All Conversations/ })).not.toBeInTheDocument()
  })
})

describe('search', () => {
  it('says it searches NAMES, in its name and its placeholder', () => {
    renderToolbar()
    const box = screen.getByRole('textbox', { name: 'Search conversations by name' })
    expect(box).toHaveAttribute('placeholder', 'Search by name…')
  })

  it('reports typing and offers a clear once there is text', () => {
    const props = renderToolbar({ searchText: 'Arel' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Arell' } })
    expect(props.onSearchChange).toHaveBeenCalledWith('Arell')
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(props.onSearchChange).toHaveBeenLastCalledWith('')
  })
})

describe('an empty list', () => {
  it('shows no search and no sort — there is nothing to search or sort', () => {
    renderToolbar({ count: 0, showListControls: false })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    // POSITIVE control on the same render: the two actions are still there.
    expect(screen.getByRole('button', { name: 'Codebook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
  })
})

describe('the sort', () => {
  it('is named for its list (#892)', () => {
    renderToolbar({ noun: 'observations' })
    expect(screen.getByRole('combobox', { name: 'Sort observations' })).toBeInTheDocument()
  })

  it('offers BOTH directions of every key it offers — re-picking an option never flipped one', () => {
    const lists: SortChoice[][] = [
      DATE_AND_NAME_SORTS,
      [...DATE_AND_NAME_SORTS,
        { key: 'progress', dir: 'desc', label: 'Most coded' },
        { key: 'progress', dir: 'asc', label: 'Least coded' }],
    ]
    for (const choices of lists) {
      for (const key of new Set(choices.map(c => c.key))) {
        const dirs = choices.filter(c => c.key === key).map(c => c.dir).sort()
        expect(dirs, `${key} must be reachable both ways`).toEqual(['asc', 'desc'])
      }
      const values = choices.map(c => `${c.key}:${c.dir}`)
      expect(new Set(values).size).toBe(values.length)
    }
  })
})

describe('the actions', () => {
  it('Codebook carries its icon and opens the codebook', () => {
    const props = renderToolbar()
    const button = screen.getByRole('button', { name: 'Codebook' })
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    expect(props.onOpenCodebook).toHaveBeenCalled()
  })

  it('Import calls through', () => {
    const props = renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(props.onImport).toHaveBeenCalled()
  })

  it('renders a section’s own tabs and actions', () => {
    renderToolbar({
      extraTabs: <button type="button">Variable Groups</button>,
      actions: <button type="button">Blank table</button>,
    })
    expect(screen.getByRole('button', { name: 'Variable Groups' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Blank table' })).toBeInTheDocument()
  })
})
