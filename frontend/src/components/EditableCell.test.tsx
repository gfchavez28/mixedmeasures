/**
 * computeDisplayValue — the dataset-grid cell display logic.
 *
 * #561: the .sav adapter's dedupe suffix (#541a) bakes the code into the
 * label ("Agree (1)"), and the grid's own `(value)` annotation then rendered
 * "Agree (1) (1)". The annotation is suppressed ONLY when the label's
 * trailing (N) equals the displayed numeric — when they differ (REVERSE, or
 * a label whose parenthetical is unrelated) it carries information and stays.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@/lib/theme-context'
import EditableCell, { computeDisplayValue } from './EditableCell'
import type { DatasetColumn, DatasetValueCell, RecodeDefinitionSummary } from '@/lib/api'

const column = { id: 1, column_type: 'ordinal' } as unknown as DatasetColumn

const cell = (text: string): DatasetValueCell =>
  ({ id: 1, value_text: text, value_numeric: null }) as unknown as DatasetValueCell

const def = (
  mapping: Record<string, number | string>,
  recodeType: 'scale_map' | 'reverse' | 'category_group' = 'scale_map',
): RecodeDefinitionSummary =>
  ({
    id: 1,
    recode_type: recodeType,
    mapping,
    exclude_values: [],
  }) as unknown as RecodeDefinitionSummary

describe('computeDisplayValue — #561 double-parenthesis suppression', () => {
  it('suppresses the annotation when the label already ends in (mapped value)', () => {
    // The #541a dedupe shape: "Agree (1)" → 1, "Agree (2)" → 2
    const d = def({ 'Agree (1)': 1, 'Agree (2)': 2 })
    expect(computeDisplayValue(cell('Agree (1)'), column, d).display).toBe('Agree (1)')
    expect(computeDisplayValue(cell('Agree (2)'), column, d).display).toBe('Agree (2)')
  })

  it('keeps the annotation when the trailing (N) differs from the displayed value', () => {
    // The differing case (e.g. a reversed display where the label carries the
    // forward code but the cell shows the reflected one): the annotation
    // disambiguates and must stay — per the locked decision, suppress ONLY
    // on exact equality.
    const differing = def({ 'Agree (1)': 5 })
    expect(computeDisplayValue(cell('Agree (1)'), column, differing).display).toBe('Agree (1) (5)')
  })

  it('keeps the annotation for plain labels (no trailing parenthetical)', () => {
    const d = def({ Agree: 2 })
    const out = computeDisplayValue(cell('Agree'), column, d)
    expect(out.display).toBe('Agree (2)')
    expect(out.isNumeric).toBe(true)
    expect(out.numericValue).toBe(2)
  })

  it('does not suppress on a non-numeric parenthetical', () => {
    const d = def({ 'Agree (a)': 1 })
    expect(computeDisplayValue(cell('Agree (a)'), column, d).display).toBe('Agree (a) (1)')
  })

  it('suppresses for decimal-rendered codes too', () => {
    const d = def({ 'Agree (1.5)': 1.5 })
    expect(computeDisplayValue(cell('Agree (1.5)'), column, d).display).toBe('Agree (1.5)')
  })

  it('tooltip still spells out raw → recoded even when suppressed', () => {
    const d = def({ 'Agree (1)': 1 })
    const out = computeDisplayValue(cell('Agree (1)'), column, d)
    expect(out.titleText).toBe('raw Agree (1) → recoded 1')
  })
})

describe('computeDisplayValue — #578 reverse reflects the stored forward code', () => {
  // A REVERSE def stores FORWARD codes; the displayed/scored value is the
  // reflection (min+max − code), matching value_numeric. offset = 1+5 = 6.
  const rev = def({ 'Strongly Disagree': 1, 'Neutral': 3, 'Strongly Agree': 5 }, 'reverse')

  it('reflects the highest response to the lowest score', () => {
    const out = computeDisplayValue(cell('Strongly Agree'), column, rev)
    expect(out.numericValue).toBe(1)   // 6 − 5
    expect(out.display).toBe('Strongly Agree (1)')
  })

  it('reflects the lowest response to the highest score', () => {
    const out = computeDisplayValue(cell('Strongly Disagree'), column, rev)
    expect(out.numericValue).toBe(5)   // 6 − 1
    expect(out.display).toBe('Strongly Disagree (5)')
  })

  it('leaves the midpoint unchanged', () => {
    expect(computeDisplayValue(cell('Neutral'), column, rev).numericValue).toBe(3)
  })

  it('a scale_map with the SAME mapping is NOT reflected (verbatim)', () => {
    const sm = def({ 'Strongly Disagree': 1, 'Strongly Agree': 5 }, 'scale_map')
    expect(computeDisplayValue(cell('Strongly Agree'), column, sm).numericValue).toBe(5)
  })

  it('reflects a bare-numeric reverse cell and keeps the disambiguating annotation', () => {
    // 0-based/gapped codes: offset = 2+10 = 12; "10" scores 2.
    const bare = def({ '2': 2, '6': 6, '10': 10 }, 'reverse')
    const out = computeDisplayValue(cell('10'), column, bare)
    expect(out.numericValue).toBe(2)
    expect(out.display).toBe('10 (2)')
  })
})

describe('#823(d) — the grid resolves RANGE bands, not just mapping keys', () => {
  /**
   * 🔴 The consumer test, not the predicate test. `lib/recode-ranges.test.ts`
   * proves `resolveRangeOutput` is right (against a fixture the Python suite
   * runs too); this proves the GRID actually calls it.
   *
   * Without it the Data view renders a banded cell as unmapped plain text while
   * `value_numeric` holds the band's code — the #578 display-vs-storage drift,
   * on the one surface a researcher checks a recode against. The project's own
   * rule: a component test proves the COMPONENT, not the MOUNT — here the
   * component IS the consumer, so this is the mount.
   */
  const banded = (
    recodeType: 'scale_map' | 'category_group' | 'reverse' = 'scale_map',
    mapping: Record<string, number | string> = {},
  ): RecodeDefinitionSummary =>
    ({
      id: 1,
      recode_type: recodeType,
      mapping,
      exclude_values: [],
      ranges: [
        { lo: 18, hi: 29, output: 1 },
        { lo: 30, hi: null, output: 2 },
      ],
    }) as unknown as RecodeDefinitionSummary

  it('resolves a cell through a band when no mapping key matches', () => {
    expect(computeDisplayValue(cell('22'), column, banded()).numericValue).toBe(1)
    expect(computeDisplayValue(cell('80'), column, banded()).numericValue).toBe(2)
  })

  it('🔴 lets an explicit mapping key beat a band, as the backend does', () => {
    const d = banded('scale_map', { '22': 9 })
    expect(computeDisplayValue(cell('22'), column, d).numericValue).toBe(9)
  })

  it('leaves a cell outside every band unmapped', () => {
    expect(computeDisplayValue(cell('4'), column, banded()).isNumeric).toBe(false)
  })

  it('🔴 derives the scale top from the BANDS when the mapping is empty', () => {
    // A pure-band rule has no mapping, so `Math.max(...[])` is -Infinity and the
    // intensity tint silently disappears — on exactly the rules that produce a
    // small ordered set of codes, where it reads best.
    expect(computeDisplayValue(cell('80'), column, banded()).maxValue).toBe(2)
  })

  it('never bands a REVERSE, which reflects its source instead', () => {
    expect(computeDisplayValue(cell('22'), column, banded('reverse')).isNumeric).toBe(false)
  })

  it('is unchanged for a definition carrying no bands at all', () => {
    // The old payload shape: `ranges` absent entirely.
    const d = def({ Agree: 1 })
    expect(computeDisplayValue(cell('Agree'), column, d).numericValue).toBe(1)
    expect(computeDisplayValue(cell('22'), column, d).isNumeric).toBe(false)
  })

  it('🔴 #861 — an EXCLUDED response is not banded, on this side either', () => {
    /**
     * This lens already ordered the channels correctly — the exclude check runs
     * before the mapping and the band — and the BACKEND did not, which is how
     * #861 was found: the grid said "excluded" while the server stored the
     * band's code. Both sides agree now, and this pins the client half so a
     * later tidy-up that moves the exclude test below the band cannot re-open it
     * silently.
     *
     * ⚠️ Per VALUE, not per definition — `30` is in the same open-topped band
     * and must still resolve. Without that half, "bands off whenever
     * `exclude_values` is non-empty" passes.
     */
    const d = { ...banded('scale_map'), exclude_values: ['22'] } as RecodeDefinitionSummary

    const excluded = computeDisplayValue(cell('22'), column, d)
    expect(excluded.isExcluded).toBe(true)
    expect(excluded.numericValue).toBeNull()

    expect(computeDisplayValue(cell('30'), column, d).numericValue).toBe(2)
  })
})

describe('#897 — a cell with no DatasetValue says so instead of swallowing the edit', () => {
  /**
   * 🔴 The claim is about SILENCE, so it is asserted on the channel silence
   * lived in: `onSave` is not called AND a toast IS raised.
   *
   * A row created after a manual variable existed used to arrive with no cell
   * for it — `PATCH …/values/{value_id}` is addressed by an existing
   * `DatasetValue.id` and there is no create — and `doSave` returned in
   * silence, so the researcher's typing vanished with no toast, no error and no
   * request. The backend now materialises a cell on every row-creating path, so
   * this branch should be unreachable; the toast exists so that if it is ever
   * reached again it is reported in days rather than never.
   *
   * ⚠️ A `not.toHaveBeenCalled()` on its own is indistinguishable from a pass
   * (#770's rule), so the toast assertion is the positive half that makes this
   * test able to fail.
   */
  it('raises a toast and does not call onSave', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react')
    const { toast } = await import('sonner')
    const { ThemeProvider } = await import('@/lib/theme-context')
    // jsdom has no matchMedia; ThemeProvider's system-mode listener asks for
    // it. Same stub `CodingWorkbench.test.tsx` installs for the same reason.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    })
    const onSave = vi.fn()
    const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '' as never)

    const manual = {
      id: 1, column_type: 'open_text', source: 'manual', column_text: 'Site',
    } as unknown as DatasetColumn

    render(
      <ThemeProvider><table><tbody><tr>
        <EditableCell
          answer={undefined}
          column={manual}
          activeDef={null}
          isSelected
          isEditing
          onSelect={() => {}}
          onStartEdit={() => {}}
          onSave={onSave}
          onCancel={() => {}}
          onTabNav={() => {}}
          onEnterNav={() => {}}
          onOpenText={() => {}}
        />
      </tr></tbody></table></ThemeProvider>
    )

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/no entry for this variable/i)
    expect(onSave).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('#927 — an open-text cell the researcher owns EDITS on click', () => {
  /**
   * 🔴 The claim is about WHICH of two handlers a click reaches, so both are
   * spied and both are asserted in both directions — a test that only checked
   * `onStartEdit` was called would pass under a branch that called BOTH.
   *
   * The defect: the branch sent every cell WITH CONTENT to the read-only
   * viewer, ignoring `isManual`. So a manual open-text cell was editable
   * exactly once — click an empty one and the editor opened; type into it and
   * from then on the click opened a dialog whose only control is Close. With
   * no F2, no double-click and no context-menu item, a typo in hand-typed text
   * was permanent short of deleting the record.
   *
   * ⚠️ The fixture must carry CONTENT. An empty manual cell takes the
   * `display === null` branch 50 lines above and edits correctly — which is
   * exactly why this shipped: the state everyone tests is the one that worked.
   */
  const stubMatchMedia = () =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    })

  const renderCell = (source: string, text: string | null) => {
    stubMatchMedia()
    const onStartEdit = vi.fn()
    const onOpenText = vi.fn()
    const col = {
      id: 7, source, column_type: 'open_text', column_text: 'Notes',
    } as unknown as DatasetColumn
    const answer = text === null
      ? undefined
      : ({ id: 4, value_text: text, value_numeric: null } as unknown as DatasetValueCell)
    const { container } = render(
      <ThemeProvider><table><tbody><tr>
        <EditableCell
          answer={answer}
          column={col}
          activeDef={null}
          isSelected={false}
          isEditing={false}
          onSelect={() => {}}
          onStartEdit={onStartEdit}
          onSave={() => {}}
          onCancel={() => {}}
          onTabNav={() => {}}
          onEnterNav={() => {}}
          onOpenText={onOpenText}
        />
      </tr></tbody></table></ThemeProvider>,
    )
    return { cell: container.querySelector('td')!, onStartEdit, onOpenText }
  }

  it('🔴 a MANUAL cell with content opens the editor, not the viewer', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const { cell, onStartEdit, onOpenText } = renderCell('manual', 'Ran late; rescheduled')
    fireEvent.click(cell)
    expect(onStartEdit).toHaveBeenCalledTimes(1)
    expect(onOpenText).not.toHaveBeenCalled()
  })

  it('an IMPORTED cell with content still opens the viewer', async () => {
    /** The half that must NOT change — a 200px column of survey prose is where
     *  the expand dialog earns its place, and those cells are not editable at
     *  all. A fix that made every open-text cell edit would pass the test above
     *  and delete a working feature. */
    const { fireEvent } = await import('@testing-library/react')
    const { cell, onStartEdit, onOpenText } = renderCell('imported', 'A long free-text answer')
    fireEvent.click(cell)
    expect(onOpenText).toHaveBeenCalledTimes(1)
    expect(onStartEdit).not.toHaveBeenCalled()
  })

  it('an empty MANUAL cell still opens the editor', () => {
    const { cell, onStartEdit } = renderCell('manual', null)
    cell.click()
    expect(onStartEdit).toHaveBeenCalledTimes(1)
  })

  it('the title tells the truth about what the click does', () => {
    /** #912's rule in the tooltip channel: "Click to expand" on a cell whose
     *  click opens the editor is a false claim about the act. An editable cell
     *  shows its own untruncated value instead, which is what hover on a
     *  truncated cell is wanted for anyway. */
    expect(renderCell('manual', 'Ran late').cell.getAttribute('title')).toBe('Ran late')
    expect(renderCell('imported', 'Ran late').cell.getAttribute('title')).toBe('Click to expand')
  })
})

describe('#927 — the editor CONSUMES its own keys', () => {
  /**
   * 🔴 Found by driving, not by reading. `DatasetView` keeps a `window` keydown
   * listener (Escape to deselect, and since #927 F2/Enter to edit), and React 18
   * flushes a discrete event's state updates before the event finishes bubbling
   * to `window` — so that listener saw `editingCell === null` on the very
   * keystroke that had just cleared it. Two measured consequences:
   *
   *   * Escape cancelled the edit AND deselected in one press, so the
   *     selected-not-editing state was unreachable on a manual column and F2
   *     would have been dead code on exactly the columns it exists for;
   *   * Enter on the LAST row leaves no cell below, so the same keystroke
   *     re-opened the editor it had just closed.
   *
   * The assertion is on PROPAGATION because that is the channel the property
   * lives in — `preventDefault` was already there and does not stop a window
   * listener from firing.
   */
  const renderEditor = () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    })
    const col = {
      id: 9, source: 'manual', column_type: 'nominal', column_text: 'Site',
    } as unknown as DatasetColumn
    return render(
      <ThemeProvider><table><tbody><tr>
        <EditableCell
          answer={{ id: 12, value_text: 'A', value_numeric: null } as unknown as DatasetValueCell}
          column={col}
          activeDef={null}
          isSelected
          isEditing
          onSelect={() => {}}
          onStartEdit={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
          onTabNav={() => {}}
          onEnterNav={() => {}}
          onOpenText={() => {}}
        />
      </tr></tbody></table></ThemeProvider>,
    )
  }

  it.each(['Escape', 'Enter', 'Tab'])('%s does not reach a window listener', async (key) => {
    const { fireEvent } = await import('@testing-library/react')
    const seen: string[] = []
    const spy = (e: KeyboardEvent) => seen.push(e.key)
    window.addEventListener('keydown', spy)
    try {
      renderEditor()
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Site' }), { key, bubbles: true })
      expect(seen).not.toContain(key)
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('a key the editor does NOT handle still reaches the window', () => {
    /** The positive control. Without it, "stop everything" passes the three
     *  cases above and would silently swallow Ctrl+Z — the grid's undo — from
     *  inside a cell editor. */
    const seen: string[] = []
    const spy = (e: KeyboardEvent) => seen.push(e.key)
    window.addEventListener('keydown', spy)
    try {
      renderEditor()
      screen.getByRole('textbox', { name: 'Edit Site' }).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
      )
      expect(seen).toContain('z')
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })
})

describe('#914 — every cell editor names the variable it edits', () => {
  /**
   * Measured in Chrome's tree (a11y sweep run 5): the ordinal editor announced
   * as a bare `combobox` carrying only its value, and the number and text
   * inputs had no name at all — a screen-reader user typing into a cell could
   * not tell which column they were in. The row is announced by its
   * `<th scope="row">`; the column is the half the editor must supply, and it
   * is `columnDisplayLabel`, the same words the header shows.
   *
   * FOUR editors, one per type family — a per-type fix would leave the next
   * family nameless, so every arm is asserted.
   */
  const stubMatchMedia = () =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    })

  const renderEditor = (column: Partial<DatasetColumn>) => {
    stubMatchMedia()
    const col = { id: 3, source: 'manual', column_text: 'Department', ...column } as unknown as DatasetColumn
    return render(
      <ThemeProvider><table><tbody><tr>
        <EditableCell
          answer={{ id: 11, value_text: '', value_numeric: null } as unknown as DatasetValueCell}
          column={col}
          activeDef={null}
          isSelected
          isEditing
          onSelect={() => {}}
          onStartEdit={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
          onTabNav={() => {}}
          onEnterNav={() => {}}
          onOpenText={() => {}}
        />
      </tr></tbody></table></ThemeProvider>,
    )
  }

  it('ordinal → a combobox named for the column', () => {
    renderEditor({ column_type: 'ordinal', scale_labels: ['Clinical', 'Operations'] })
    expect(screen.getByRole('combobox', { name: 'Edit Department' })).toBeTruthy()
  })

  it('numeric → a spinbutton named for the column', () => {
    renderEditor({ column_type: 'numeric' })
    expect(screen.getByRole('spinbutton', { name: 'Edit Department' })).toBeTruthy()
  })

  it('nominal → a textbox named for the column', () => {
    renderEditor({ column_type: 'nominal' })
    expect(screen.getByRole('textbox', { name: 'Edit Department' })).toBeTruthy()
  })

  it('open text → a textarea named for the column, not a generic "cell value"', () => {
    renderEditor({ column_type: 'open_text' })
    expect(screen.getByRole('textbox', { name: 'Edit Department' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Edit cell value' })).toBeNull()
  })

  it('prefers the short name when the column has one, matching the header', () => {
    renderEditor({ column_type: 'nominal', column_name: 'dept' })
    expect(screen.getByRole('textbox', { name: 'Edit dept' })).toBeTruthy()
  })
})
