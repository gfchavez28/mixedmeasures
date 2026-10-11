/**
 * #1174 — the out-of-date marker: a name in plain words, no tab stop, motion
 * only when the researcher allows it, and a colour that can be SEEN.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrast, parseTailwindPalette, readToken, NON_TEXT } from '@/lib/contrast'
import { SRC_DIR } from '@/test-support/source-tree'
import { OutOfDateDot, OUT_OF_DATE_DOT_COLOR } from './OutOfDateDot'

afterEach(cleanup)

describe('OutOfDateDot', () => {
  it('is a named image — "out of date", not a title and not "stale"', () => {
    render(<OutOfDateDot />)
    const dot = screen.getByRole('img', { name: /out of date/i })
    expect(dot).toHaveAccessibleName('Out of date — recompute')
    expect(dot).not.toHaveAttribute('title')
    expect(dot.textContent).toBe('')
  })

  it('takes a variant name for a site whose fix is elsewhere', () => {
    render(<OutOfDateDot label="Out of date — recompute in Analysis" />)
    expect(screen.getByRole('img', { name: 'Out of date — recompute in Analysis' })).toBeInTheDocument()
  })

  it('is NOT a tab stop — a static badge, one per row would cost a stop per row (#559)', () => {
    render(<OutOfDateDot />)
    const dot = screen.getByRole('img', { name: /out of date/i })
    expect(dot).not.toHaveAttribute('tabindex')
    expect(dot.tabIndex).toBe(-1)
  })

  it('pulses only under motion-safe, never bare', () => {
    render(<OutOfDateDot />)
    const classes = screen.getByRole('img', { name: /out of date/i }).className.split(/\s+/)
    expect(classes).toContain('motion-safe:animate-pulse')
    expect(classes).not.toContain('animate-pulse')
  })
})

/**
 * WCAG 1.4.11 — a graphic that carries meaning needs 3:1 against what it sits
 * on. Measured from the SHIPPED palette (`tailwindcss/theme.css`) and tokens
 * (`index.css`), the same sources `palette-contrast.test.ts` reads. The old
 * `amber-400` measured 1.45–1.68:1 on the light surfaces.
 *
 * The surfaces are the ones the dot sits on: the grid's header band
 * (`bg-mm-bg`), an analysis row (`bg-mm-surface`) and its hover.
 */
describe('#1174 — the dot is visible on every surface it sits on', () => {
  const PALETTE = parseTailwindPalette(
    readFileSync(join(SRC_DIR, '../node_modules/tailwindcss/theme.css'), 'utf8'),
  )
  const CSS = readFileSync(join(SRC_DIR, 'index.css'), 'utf8')
  const SURFACES = ['mm-bg', 'mm-surface', 'mm-surface-hover']

  const shadeFor = (theme: 'light' | 'dark') => {
    const parts = OUT_OF_DATE_DOT_COLOR.split(/\s+/)
    const util = theme === 'dark'
      ? parts.find(p => p.startsWith('dark:bg-'))
      : parts.find(p => p.startsWith('bg-'))
    return util?.replace(/^(dark:)?bg-/, '')
  }

  it('reads a fill for each theme (the guard below is not vacuous)', () => {
    expect(shadeFor('light')).toMatch(/^amber-\d00$/)
    expect(shadeFor('dark')).toMatch(/^amber-\d00$/)
    expect(PALETTE.get(shadeFor('light')!)).toBeDefined()
    expect(PALETTE.get(shadeFor('dark')!)).toBeDefined()
  })

  it.each(['light', 'dark'] as const)('%s: at least 3:1 against each surface', (theme) => {
    const fill = PALETTE.get(shadeFor(theme)!)!
    for (const surface of SURFACES) {
      const ratio = contrast(fill, readToken(CSS, theme, surface))
      expect(ratio, `${shadeFor(theme)} on ${surface} (${theme}) = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(NON_TEXT)
    }
  })
})
