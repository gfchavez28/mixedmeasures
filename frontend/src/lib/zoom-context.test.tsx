import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { ZoomProvider, useZoom } from './zoom-context'
import { ZOOM_STORAGE_KEY } from './zoom'

/** Reads the context out so assertions can be made on rendered text. */
function Probe() {
  const { zoom, isSupported, zoomIn, zoomOut, resetZoom } = useZoom()
  return (
    <div>
      <span data-testid="zoom">{zoom}</span>
      <span data-testid="supported">{String(isSupported)}</span>
      <button onClick={zoomIn}>in</button>
      <button onClick={zoomOut}>out</button>
      <button onClick={resetZoom}>reset</button>
    </div>
  )
}

let setZoomFactor: ReturnType<typeof vi.fn>

function mountDesktop() {
  setZoomFactor = vi.fn((f: number) => Promise.resolve(f))
  ;(window as unknown as { mmDesktop: unknown }).mmDesktop = { setZoomFactor }
}

function mountBrowser() {
  delete (window as unknown as { mmDesktop?: unknown }).mmDesktop
}

// jsdom in this config has no working `localStorage`; install a clean in-memory
// shim per test (mirrors useCollapsibleColumn.test / useBlindMode.test).
let store: Record<string, string> = {}
beforeEach(() => {
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
})

afterEach(() => {
  mountBrowser()
  vi.restoreAllMocks()
})

describe('ZoomProvider in the packaged app', () => {
  beforeEach(mountDesktop)

  it('reports support and starts at 100%', () => {
    render(<ZoomProvider><Probe /></ZoomProvider>)
    expect(screen.getByTestId('supported')).toHaveTextContent('true')
    expect(screen.getByTestId('zoom')).toHaveTextContent('1')
  })

  it('applies a stored preference on mount', async () => {
    // The whole point of persisting: Electron does NOT restore the zoom factor
    // across launches, so without this the setting would silently reset every
    // restart — for an accessibility preference, that is the same as absent.
    localStorage.setItem(ZOOM_STORAGE_KEY, '1.5')
    await act(async () => {
      render(<ZoomProvider><Probe /></ZoomProvider>)
    })
    expect(screen.getByTestId('zoom')).toHaveTextContent('1.5')
    expect(setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('does not call the bridge on mount at the default', async () => {
    // A no-op IPC on every launch is noise; the window is already at 1.0.
    await act(async () => {
      render(<ZoomProvider><Probe /></ZoomProvider>)
    })
    expect(setZoomFactor).not.toHaveBeenCalled()
  })

  it('steps up, persists, and pushes to main', async () => {
    render(<ZoomProvider><Probe /></ZoomProvider>)
    fireEvent.click(screen.getByText('in'))
    expect(screen.getByTestId('zoom')).toHaveTextContent('1.1')
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.1')
    expect(setZoomFactor).toHaveBeenCalledWith(1.1)
  })

  it('steps down and resets', async () => {
    render(<ZoomProvider><Probe /></ZoomProvider>)
    fireEvent.click(screen.getByText('out'))
    expect(screen.getByTestId('zoom')).toHaveTextContent('0.9')
    fireEvent.click(screen.getByText('reset'))
    expect(screen.getByTestId('zoom')).toHaveTextContent('1')
  })

  it('adopts main\'s answer when main clamps differently', async () => {
    // Main is the authority. If the two ever disagree, the Settings control must not
    // keep showing a value the window is not actually at.
    setZoomFactor.mockImplementation(() => Promise.resolve(2.0))
    render(<ZoomProvider><Probe /></ZoomProvider>)
    await act(async () => {
      fireEvent.click(screen.getByText('in'))
    })
    expect(screen.getByTestId('zoom')).toHaveTextContent('2')
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('2')
  })

  it('survives a rejected bridge call without breaking the app', async () => {
    setZoomFactor.mockImplementation(() => Promise.reject(new Error('ipc gone')))
    render(<ZoomProvider><Probe /></ZoomProvider>)
    await act(async () => {
      fireEvent.click(screen.getByText('in'))
    })
    expect(screen.getByTestId('zoom')).toHaveTextContent('1.1')
  })

  describe('keyboard accelerators', () => {
    const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...mods }),
        )
      })

    it('Ctrl+= zooms in, Ctrl+- zooms out, Ctrl+0 resets', async () => {
      render(<ZoomProvider><Probe /></ZoomProvider>)
      await press('=')
      expect(screen.getByTestId('zoom')).toHaveTextContent('1.1')
      await press('=')
      expect(screen.getByTestId('zoom')).toHaveTextContent('1.25')
      await press('-')
      expect(screen.getByTestId('zoom')).toHaveTextContent('1.1')
      await press('0')
      expect(screen.getByTestId('zoom')).toHaveTextContent('1')
    })

    it('ignores a bare 0 — that is a coding-workbench shortcut', async () => {
      // Verified against `useCodeChordShortcuts`, whose digit branch is guarded with
      // !ctrlKey && !metaKey && !altKey. If this handler claimed a plain 0, pressing
      // it to apply a code would resize the app instead.
      render(<ZoomProvider><Probe /></ZoomProvider>)
      await press('0', { ctrlKey: false })
      expect(screen.getByTestId('zoom')).toHaveTextContent('1')
    })

    it('unbinds the listener on unmount', async () => {
      const { unmount } = render(<ZoomProvider><Probe /></ZoomProvider>)
      unmount()
      await press('=')
      expect(setZoomFactor).not.toHaveBeenCalled()
    })
  })
})

describe('ZoomProvider in the browser', () => {
  beforeEach(mountBrowser)

  it('reports unsupported so the Settings control renders nothing', () => {
    render(<ZoomProvider><Probe /></ZoomProvider>)
    expect(screen.getByTestId('supported')).toHaveTextContent('false')
  })

  it('does not bind the keyboard handler', async () => {
    // Deliberate: the browser's own Ctrl+= already works. Binding ours would shadow
    // a working native affordance with one that cannot apply anything.
    render(<ZoomProvider><Probe /></ZoomProvider>)
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true }))
    })
    expect(screen.getByTestId('zoom')).toHaveTextContent('1')
  })
})
