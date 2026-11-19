/**
 * Joint display slice 2, round-2 combine (Q1): the PAGE hosts every display dialog (D213) — the
 * case view (r5-2) beside the builder and the pin picker. Each request kind opens its own dialog
 * and no other. The dialogs themselves are tested in their own files; here they are markers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('./CaseView', () => ({ default: (p: { rowKey: string }) => <div>case view for {p.rowKey}</div> }))
vi.mock('./JointDisplayBuilder', () => ({ default: () => <div>the builder</div> }))
vi.mock('./PinPicker', () => ({ default: () => <div>the pin picker</div> }))

import DisplayDialogHost from './DisplayDialogHost'
import { useDisplayDialogs, type DisplayDialogRequest } from './display-store'
import { displayCoderScope, readDisplay } from '@/lib/joint-display'

function Opener({ request }: { request: DisplayDialogRequest }) {
  const open = useDisplayDialogs()
  return <button type="button" onClick={() => open?.(request)}>open</button>
}

const display = readDisplay({ title: 'T', group_by_column_id: 11, rows: [{ key: 'r1', construct: 'Planning' }] })

afterEach(cleanup)

describe('the page hosts each display dialog (Q1, D213)', () => {
  it('a cases request opens the case view, and nothing else', () => {
    render(
      <DisplayDialogHost projectId={1}>
        <Opener request={{ kind: 'cases', displayKey: 'k', display, rowKey: 'r1', scope: displayCoderScope(false, 1), noViewer: false }} />
      </DisplayDialogHost>,
    )
    expect(screen.queryByText('case view for r1')).toBeNull()
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByText('case view for r1')).toBeInTheDocument()
    expect(screen.queryByText('the builder')).toBeNull()
  })
})
