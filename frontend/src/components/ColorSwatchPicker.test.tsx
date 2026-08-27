import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ColorSwatchPicker, CATEGORY_COLORS } from './ColorSwatchPicker'
import { colorName, unnamedPaletteColors, CATEGORY_COLOR_NAMES } from '@/lib/color-names'

afterEach(cleanup)

/**
 * #788 — the shared colour picker.
 *
 * ⚠️ Filed against the create-category dialog; measured, this is ONE component with
 * ~27 mount points (codebook panels, canvas, participants, settings, datasets,
 * conversation import, crosswalk). Every one of them cost 16 tab stops.
 */

describe('palette names', () => {
  /**
   * Fail-closed over the palette itself: a seventeenth colour added without a name
   * fails here rather than shipping a swatch that announces its hex.
   */
  it('names EVERY palette colour', () => {
    expect(unnamedPaletteColors()).toEqual([])
  })

  /**
   * ⚠️ Three reds (Red/Rose/Pink) and three purples (Indigo/Violet/Purple) sit close
   * together. Individually plausible names are not enough — two swatches sharing a
   * name would be no better than two sharing a hex.
   */
  it('gives every colour a DISTINCT name', () => {
    const names = CATEGORY_COLORS.map(colorName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('is case-insensitive and falls back to the hex for anything off-palette', () => {
    expect(colorName('#3B82F6')).toBe('Blue')
    expect(colorName('#123456')).toBe('#123456')
  })

  it('has no name entry that is itself a hex string', () => {
    for (const name of Object.values(CATEGORY_COLOR_NAMES)) {
      expect(name).not.toMatch(/^#/)
    }
  })
})

describe('#788 — the picker is one radiogroup, not sixteen tab stops', () => {
  const renderPicker = (value = CATEGORY_COLORS[0], onChange = vi.fn(), label?: string) => {
    const utils = render(<ColorSwatchPicker value={value} onChange={onChange} label={label} />)
    return { ...utils, onChange }
  }

  /**
   * ⚠️ POPULATION assertion, not "the first one is tabbable". The defect was every
   * swatch carrying a tab stop; asserting the whole set is what catches a
   * seventeenth arriving with `tabIndex` spelled by hand.
   */
  it('exposes exactly ONE tab stop across the whole palette', () => {
    renderPicker()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(CATEGORY_COLORS.length)
    expect(radios.filter(r => r.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('puts the tab stop on the CHECKED colour, so Tab returns where you were', () => {
    renderPicker(CATEGORY_COLORS[5])
    const radios = screen.getAllByRole('radio')
    expect(radios[5]).toHaveAttribute('tabindex', '0')
    expect(radios[5]).toHaveAttribute('aria-checked', 'true')
  })

  it('falls back to the first swatch when nothing is chosen yet', () => {
    renderPicker('')
    const radios = screen.getAllByRole('radio')
    expect(radios[0]).toHaveAttribute('tabindex', '0')
    expect(radios.every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)
  })

  it('names the group and every swatch in words', () => {
    renderPicker(CATEGORY_COLORS[0], vi.fn(), 'Line color')
    const group = screen.getByRole('radiogroup', { name: 'Line color' })
    expect(within(group).getByRole('radio', { name: 'Blue' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Stone' })).toBeInTheDocument()
    expect(within(group).queryByRole('radio', { name: /^#/ })).toBeNull()
  })

  it('defaults the group name when a call site does not supply one', () => {
    renderPicker()
    expect(screen.getByRole('radiogroup', { name: 'Color' })).toBeInTheDocument()
  })

  describe('keyboard', () => {
    it('arrows move the tab stop, wrapping at the ends', () => {
      renderPicker(CATEGORY_COLORS[0])
      const group = screen.getByRole('radiogroup')
      fireEvent.keyDown(group, { key: 'ArrowRight' })
      expect(screen.getAllByRole('radio')[1]).toHaveAttribute('tabindex', '0')

      fireEvent.keyDown(group, { key: 'ArrowLeft' })
      fireEvent.keyDown(group, { key: 'ArrowLeft' })
      // Wraps to the end rather than sticking — the APG radiogroup behaviour.
      expect(screen.getAllByRole('radio')[CATEGORY_COLORS.length - 1]).toHaveAttribute('tabindex', '0')
    })

    it('Home and End jump to the ends', () => {
      renderPicker(CATEGORY_COLORS[5])
      const group = screen.getByRole('radiogroup')
      fireEvent.keyDown(group, { key: 'End' })
      expect(screen.getAllByRole('radio')[CATEGORY_COLORS.length - 1]).toHaveAttribute('tabindex', '0')
      fireEvent.keyDown(group, { key: 'Home' })
      expect(screen.getAllByRole('radio')[0]).toHaveAttribute('tabindex', '0')
    })

    /**
     * 🔴 THE LOAD-BEARING ONE. Two call sites close their popover inside `onChange`
     * (`SettingsPage`, `ThemeRelationshipPopover`). If arrowing selected — the usual
     * radiogroup reading — the picker would shut on the first keypress and be
     * unusable by keyboard at exactly those sites. If this ever goes green for
     * "arrow calls onChange", those two are broken and nothing else will say so.
     */
    it('arrowing does NOT select — selection has side effects at two call sites', () => {
      const { onChange } = renderPicker()
      const group = screen.getByRole('radiogroup')
      fireEvent.keyDown(group, { key: 'ArrowRight' })
      fireEvent.keyDown(group, { key: 'ArrowRight' })
      fireEvent.keyDown(group, { key: 'End' })
      expect(onChange).not.toHaveBeenCalled()
    })

    /**
     * Space/Enter commit through the native button click, which is why the keydown
     * handler deliberately does not touch them — handling them there would fire
     * `onChange` twice.
     */
    it('clicking a swatch selects it', () => {
      const { onChange } = renderPicker()
      fireEvent.click(screen.getByRole('radio', { name: 'Teal' }))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('#14b8a6')
    })
  })
})
