/**
 * #938 — the toast is painted in the app's colours, in the app's theme.
 *
 * The defect was that `App.tsx` said exactly this in a `toastOptions.className`
 * and it never applied: sonner styles the toast with
 * `[data-sonner-toast][data-styled='true']`, two attribute selectors, which
 * outranks a single Tailwind class whatever order the sheets land in. So every
 * toast was a white card in dark mode while the source claimed otherwise.
 *
 * 🔴 **Both halves are asserted, because either alone is wrong.** `theme` fixes
 * sonner's secondary styling and lands its `#000` default on a `230 14% 9%`
 * app — a toast that reads as recessed. The custom properties fix the surface
 * and would leave the description text and buttons resolving for the wrong mode.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { toast } from 'sonner'
import { ThemeProvider } from '@/lib/theme-context'
import { ThemedToaster } from './ThemedToaster'

/** jsdom has no `matchMedia`; `ThemeProvider`'s system-mode resolution asks for it. */
const stubPrefersDark = (matches: boolean) =>
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })

/**
 * ⚠️ **Sonner does not render `[data-sonner-toaster]` until a toast exists.**
 * Mounting the component alone leaves only the empty `<section>` live region,
 * so a test that queried straight after `render` would find nothing and — for
 * the two theme cases — read `undefined`, which is indistinguishable from the
 * wrong theme. Raise one toast and let the state flush, then read the element
 * the props actually land on.
 */
async function mountAndToast() {
  const { container } = render(<ThemeProvider><ThemedToaster /></ThemeProvider>)
  act(() => { toast('probe') })
  await act(async () => { await new Promise(r => setTimeout(r, 60)) })
  const el = container.ownerDocument.querySelector('[data-sonner-toaster]')
  expect(el, 'sonner rendered no toaster — the assertions below would be vacuous').toBeTruthy()
  return el as HTMLElement
}

describe('ThemedToaster', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('🔴 follows the app into dark mode', async () => {
    localStorage.setItem('mm-theme', 'dark')
    stubPrefersDark(false)
    expect((await mountAndToast()).getAttribute('data-sonner-theme')).toBe('dark')
  })

  it('stays light when the app is light', async () => {
    localStorage.setItem('mm-theme', 'light')
    stubPrefersDark(true)
    expect((await mountAndToast()).getAttribute('data-sonner-theme')).toBe('light')
  })

  it('🔴 resolves SYSTEM itself rather than handing sonner "system"', async () => {
    /**
     * The app's own toggle is the authority. Passing `mode` straight through
     * would let sonner read `prefers-color-scheme` independently, so a
     * researcher in explicit light mode on a dark OS would get a dark toast on
     * a light app — and it would install a second matchMedia listener beside
     * ThemeProvider's. Here the stored mode is `system` and the OS is dark, so
     * a correct implementation reports `dark`, never the literal `system`.
     */
    localStorage.setItem('mm-theme', 'system')
    stubPrefersDark(true)
    expect((await mountAndToast()).getAttribute('data-sonner-theme')).toBe('dark')
  })

  it('paints the surface from the app tokens, not sonner\'s palette', async () => {
    /**
     * The channel matters: these are custom properties on the TOASTER element
     * (where sonner declares its own), delivered as an inline style, which is
     * the only thing that beats its stylesheet. Asserting a class here would
     * re-create the defect this component exists to fix.
     */
    localStorage.setItem('mm-theme', 'dark')
    stubPrefersDark(false)
    const el = await mountAndToast()
    expect(el.style.getPropertyValue('--normal-bg')).toBe('hsl(var(--mm-surface))')
    expect(el.style.getPropertyValue('--normal-text')).toBe('hsl(var(--mm-text))')
    expect(el.style.getPropertyValue('--normal-border')).toBe('hsl(var(--mm-surface-border))')
  })
})
