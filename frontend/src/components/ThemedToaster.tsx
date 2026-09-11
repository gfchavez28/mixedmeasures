import { Toaster } from 'sonner'
import type { CSSProperties } from 'react'
import { useTheme } from '@/lib/theme-context'

/**
 * The app's one toast surface, painted in the app's own colours (#936/#938).
 *
 * 🔴 **Every toast rendered as a WHITE card in dark mode**, and the intent was
 * in the code the whole time: `App.tsx` passed
 * `toastOptions.className = 'bg-mm-surface text-mm-text border-mm-surface-border'`
 * and it never took effect. **That was not a load-order accident.** Sonner
 * styles the toast with `[data-sonner-toast][data-styled='true']` — TWO
 * attribute selectors, specificity (0,2,0) — which outranks a single Tailwind
 * class (0,1,0) whatever order the stylesheets land in. No amount of
 * reordering, and no `@layer` move, could have made that className win.
 *
 * ⚠️ **`theme` alone is NOT the fix either.** Sonner's dark palette is
 * `--normal-bg: #000`, and this app's dark background is `230 14% 9%` — so a
 * themed-but-untokened toast is a pure-black card floating on dark grey, i.e.
 * it reads as RECESSED where a toast is the most raised thing on screen
 * (`frontend-visual.md`'s elevation rule, #857). Both halves are needed:
 *
 *   * `theme` so sonner's own secondary styling — the description text, the
 *     action/cancel/close buttons — resolves for the right mode; and
 *   * the three CSS custom properties, which is sonner's documented theming
 *     surface and the only channel that beats its stylesheet. They are
 *     declared on `[data-sonner-toaster]`, sonner spreads our `style` onto
 *     exactly that element (verified in its dist, not assumed), and an inline
 *     style wins. Custom properties inherit, so every toast picks them up.
 *
 * ⚠️ **The RESOLVED theme, never `mode`.** Sonner accepts `'system'` and would
 * then read `prefers-color-scheme` itself — so a researcher running the app in
 * explicit light mode on a dark OS would get a dark toast on a light app. The
 * app's own toggle is the authority, and passing `isDark` also avoids a second
 * `matchMedia` listener beside `ThemeProvider`'s.
 *
 * ⚠️ **This is a COMPONENT and not three props on `App`** because `App` is what
 * RENDERS `ThemeProvider` — `useTheme()` there would throw. It also gives the
 * behaviour a test that does not have to mount the router.
 */
export function ThemedToaster() {
  const { isDark } = useTheme()

  return (
    <Toaster
      position="bottom-right"
      theme={isDark ? 'dark' : 'light'}
      style={{
        '--normal-bg': 'hsl(var(--mm-surface))',
        '--normal-text': 'hsl(var(--mm-text))',
        '--normal-border': 'hsl(var(--mm-surface-border))',
      } as CSSProperties}
    />
  )
}
