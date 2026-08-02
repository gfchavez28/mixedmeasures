/**
 * #644 / #648 — the only in-app keyboard-discovery surface.
 *
 * The dialog is a static reference list mounted globally in ProjectLayout, so
 * nothing else can catch it drifting from the workbenches it documents. These
 * pin the two things the audit found: Observations was absent entirely, and two
 * entries under "Coding (all views)" are false on that page.
 */
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'

import KeyboardHelpDialog from './KeyboardHelpDialog'

const open = () => render(<KeyboardHelpDialog open onOpenChange={() => {}} />)

// No global setup file in this project — each spec cleans up for itself, or a
// second render leaves the first dialog mounted and every getByText is ambiguous.
afterEach(cleanup)

describe('KeyboardHelpDialog', () => {
  it('documents the Observations surface', () => {
    open()
    expect(screen.getByText('Observations')).toBeInTheDocument()
  })

  it('lists the marking, transport and boundary keys the workbench actually binds', () => {
    open()
    // Verified against ObservationWorkbench's `extraKeys` + `onArrowHorizontal`.
    expect(screen.getByText('Mark clip in / out')).toBeInTheDocument()
    expect(screen.getByText('Point event')).toBeInTheDocument()
    expect(screen.getByText('Next gap or uncoded clip')).toBeInTheDocument()
    expect(screen.getByText('Shuttle back / play-pause / faster')).toBeInTheDocument()
    expect(screen.getByText('Nudge boundary (Shift: 1s)')).toBeInTheDocument()
  })

  it('does not claim j is "Next uncoded" everywhere', () => {
    open()
    // useCodeChordShortcuts claims `j` ONLY when the surface passes
    // onJumpUncoded; the observation workbench omits it so `J` can shuttle (D4).
    // A bare "Next uncoded" would be telling the researcher the wrong thing.
    expect(screen.queryByText('Next uncoded')).not.toBeInTheDocument()
    expect(screen.getByText('Next uncoded (not in Observations)')).toBeInTheDocument()
  })

  it('does not claim the arrows switch panel everywhere', () => {
    open()
    // Same shape as `j`: the observation workbench supplies onArrowHorizontal,
    // so the arrows nudge a clip boundary there and never move panel focus.
    expect(screen.queryByText('Switch panel')).not.toBeInTheDocument()
    expect(screen.getByText('Switch panel (not in Observations)')).toBeInTheDocument()
  })

  it('gives the dialog an accessible description (#648)', () => {
    open()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleDescription(/Shortcuts by area/)
  })
})
