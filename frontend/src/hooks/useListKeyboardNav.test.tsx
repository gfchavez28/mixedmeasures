/**
 * The shared list-navigation hook — and the search box that hands it its keys.
 *
 * The data grid's participant picker passes this hook's handler to its SEARCH BOX,
 * so typing a name, pressing ArrowDown, then Space LINKED the highlighted
 * participant to the record (overwriting its link, no message, no undo — measured
 * 2026-10-14). Space in a text field is a character. Enter still chooses.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { useListKeyboardNav } from './useListKeyboardNav'

const NAMES = ['Ines Duarte', 'Liam Novak', 'Jonas Berg']

function Picker({ onSelect }: { onSelect: (i: number) => void }) {
  const [q, setQ] = useState('')
  const { getItemProps, listProps } = useListKeyboardNav({ itemCount: NAMES.length, onSelect })
  return (
    <div>
      <input aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={listProps.onKeyDown} />
      <div ref={listProps.ref}>
        {NAMES.map((n, i) => (
          <button key={n} onMouseEnter={getItemProps(i).onMouseEnter}>{n}</button>
        ))}
      </div>
    </div>
  )
}

function Listbox({ onSelect }: { onSelect: (i: number) => void }) {
  const { getItemProps, listProps } = useListKeyboardNav({ itemCount: NAMES.length, onSelect })
  return (
    <div {...listProps} aria-label="Columns">
      {NAMES.map((n, i) => <div key={n} {...getItemProps(i)}>{n}</div>)}
    </div>
  )
}

// No user-event in this repo: a keydown that is NOT `preventDefault`ed is one the
// browser goes on to type, so `fireEvent.keyDown(...)` returning true is "a space was typed".
describe('useListKeyboardNav from a search box', () => {
  it('types a space after an arrow, and chooses nothing', () => {
    const onSelect = vi.fn()
    render(<Picker onSelect={onSelect} />)
    const box = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(box, { target: { value: 'Ines' } })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(box, { key: ' ' })).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('types a space while the pointer rests on a result, and chooses nothing', () => {
    const onSelect = vi.fn()
    render(<Picker onSelect={onSelect} />)
    const box = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Liam Novak' }))
    fireEvent.change(box, { target: { value: 'Liam' } })
    expect(fireEvent.keyDown(box, { key: ' ' })).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still chooses the highlighted entry on Enter — the positive control', () => {
    const onSelect = vi.fn()
    render(<Picker onSelect={onSelect} />)
    const box = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false)
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})

describe('useListKeyboardNav on a focusable list', () => {
  it('chooses on Space where no text field has focus (the column pickers)', () => {
    // The hook scrolls the highlighted row into view; jsdom has no scrollIntoView.
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const onSelect = vi.fn()
    render(<Listbox onSelect={onSelect} />)
    const list = screen.getByRole('listbox', { name: 'Columns' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(list, { key: ' ' })).toBe(false)
    expect(onSelect).toHaveBeenCalledWith(0)
  })
})
