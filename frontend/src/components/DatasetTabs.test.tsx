import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router'
import DatasetTabs from './DatasetTabs'

afterEach(cleanup)

function renderAt(path: string, variableCount?: number) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DatasetTabs projectId={1} datasetId={2} variableCount={variableCount} />
    </MemoryRouter>,
  )
}

describe('DatasetTabs', () => {
  it('is a NAV of links, not an ARIA tablist', () => {
    // Activating one of these NAVIGATES — `role="tab"` would promise a tabpanel
    // this control shows and hides in the same document, which is not what
    // happens. The house shape (TopRail) is a nav of links.
    renderAt('/projects/1/datasets/2')
    expect(screen.getByRole('navigation', { name: 'Dataset views' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('marks the Data view current when on the dataset root', () => {
    renderAt('/projects/1/datasets/2')
    expect(screen.getByRole('link', { name: /Data/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /Variables/ })).not.toHaveAttribute('aria-current')
  })

  it('marks the Variables view current when on it', () => {
    renderAt('/projects/1/datasets/2/variables')
    expect(screen.getByRole('link', { name: /Variables/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /Data/ })).not.toHaveAttribute('aria-current')
  })

  it('points each tab at its own route', () => {
    renderAt('/projects/1/datasets/2')
    expect(screen.getByRole('link', { name: /Data/ }))
      .toHaveAttribute('href', '/projects/1/datasets/2')
    expect(screen.getByRole('link', { name: /Variables/ }))
      .toHaveAttribute('href', '/projects/1/datasets/2/variables')
  })

  it('carries the variable count in the Variables tab, and folds it into the name', () => {
    renderAt('/projects/1/datasets/2', 41)
    // Asserted through the accessible NAME, because that is the channel a
    // screen-reader user meets it on — a getByText would pass on a count
    // rendered where nothing announces it.
    expect(screen.getByRole('link', { name: 'Variables 41' })).toBeInTheDocument()
  })

  it('renders no count while the columns query is still loading', () => {
    renderAt('/projects/1/datasets/2')
    expect(screen.getByRole('link', { name: 'Variables' })).toBeInTheDocument()
  })

  it('shows a count of 0 rather than hiding it — 0 variables is a fact', () => {
    // The falsy-zero shape: `count && <span>` would drop this.
    renderAt('/projects/1/datasets/2', 0)
    expect(screen.getByRole('link', { name: 'Variables 0' })).toBeInTheDocument()
  })
})
