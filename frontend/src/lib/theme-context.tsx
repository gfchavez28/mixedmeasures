import { createContext, useContext, useState, useEffect, useCallback, startTransition, useRef } from 'react'
import { CHART_COLORS, CHART_COLORS_DARK } from './chart-data'
import type { ChartColorPalette } from './chart-data'

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  isDark: boolean
  mode: ThemeMode
  toggleTheme: () => void
  setTheme: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function getStoredMode(): ThemeMode {
  const stored = localStorage.getItem('mm-theme')
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'system'
}

function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode)
  const [isDark, setIsDark] = useState(() => resolveIsDark(getStoredMode()))
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  useEffect(() => {
    const root = document.documentElement
    if (isDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [isDark])

  // Listen for OS preference changes when in system mode
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      if (modeRef.current === 'system') {
        setIsDark(e.matches)
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode])

  const setTheme = useCallback((newMode: ThemeMode) => {
    startTransition(() => {
      setModeState(newMode)
      localStorage.setItem('mm-theme', newMode)
      setIsDark(resolveIsDark(newMode))
    })
  }, [])

  const toggleTheme = useCallback(() => {
    const cur = modeRef.current
    // Cycle: system → light → dark → system, but skip if the next mode
    // resolves to the same visual state (e.g. system=light → light is redundant)
    const order: ThemeMode[] = ['system', 'light', 'dark']
    const curIndex = order.indexOf(cur)
    const curIsDark = resolveIsDark(cur)
    for (let i = 1; i <= order.length; i++) {
      const next = order[(curIndex + i) % order.length]
      if (resolveIsDark(next) !== curIsDark) {
        setTheme(next)
        return
      }
    }
    // Fallback (all modes resolve the same — shouldn't happen)
    setTheme(order[(curIndex + 1) % order.length])
  }, [setTheme])

  return (
    <ThemeContext.Provider value={{ isDark, mode, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** Returns the correct chart color palette for the current theme. */
// eslint-disable-next-line react-refresh/only-export-components
export function useChartColors(): ChartColorPalette {
  const { isDark } = useTheme()
  return isDark ? CHART_COLORS_DARK : CHART_COLORS
}
