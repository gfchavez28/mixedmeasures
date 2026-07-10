/**
 * VideoPane (V1 slab 4) invariants:
 *  - the <video> element is NEVER unmounted across state changes (collapse /
 *    PiP / sizes) — Chromium pauses reparented/remounted media elements, so
 *    every state is a CSS-only restyle of one mounted element;
 *  - S/M/L + collapsed persist per conversation; theater/PiP never persist;
 *  - exitOverlay() (the workbench Escape layer) leaves theater/PiP back to
 *    the previous docked size.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import VideoPane, { type VideoPaneHandle } from './VideoPane'

function renderPane(overrides: Partial<React.ComponentProps<typeof VideoPane>> = {}) {
  const handle = createRef<VideoPaneHandle>()
  const mediaRef = createRef<HTMLVideoElement | HTMLAudioElement | null>()
  const props: React.ComponentProps<typeof VideoPane> = {
    projectId: 1,
    conversationId: 7,
    mediaRef,
    segments: [],
    mediaDuration: 120,
    isVbr: false,
    isPlaying: false,
    isMediaReady: true,
    isBuffering: false,
    mediaError: null,
    currentTime: 0,
    playbackSpeed: 1,
    onTogglePlayback: vi.fn(),
    onCycleSpeed: vi.fn(),
    onTimeChange: vi.fn(),
    ...overrides,
  }
  const view = render(<VideoPane ref={handle} {...props} />)
  return { ...view, handle, mediaRef, props }
}

const getVideo = (container: HTMLElement) => container.querySelector('video')

// jsdom 29's Storage proxy has uneven function binding under this vitest
// config; install a clean in-memory shim per test (mirrors useBlindMode.test).
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

describe('VideoPane', () => {
  it('defaults to Medium with the transport strip and a mounted video element', () => {
    const { container, mediaRef } = renderPane()
    expect(getVideo(container)).toBeTruthy()
    expect(mediaRef.current).toBe(getVideo(container))
    expect(screen.getByRole('group', { name: 'Video pane size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'M', pressed: true })).toBeTruthy()
  })

  it('persists a size change per conversation', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'S' }))
    expect(localStorage.getItem('mm-video-pane-7')).toBe('s')
  })

  it('collapse keeps the video element mounted (audio-parity bar) and persists', () => {
    const { container } = renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse video pane' }))
    expect(getVideo(container)).toBeTruthy() // display:none, never unmounted
    expect(screen.getByRole('button', { name: /show video/i })).toBeTruthy()
    expect(localStorage.getItem('mm-video-pane-7')).toBe('collapsed')
  })

  it('theater does not persist; exitOverlay restores the previous docked size', () => {
    const { handle } = renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'L' }))
    fireEvent.click(screen.getByRole('button', { name: 'Theater mode' }))
    expect(localStorage.getItem('mm-video-pane-7')).toBe('l') // theater never persisted
    expect(screen.getByText(/Theater —/)).toBeTruthy()

    act(() => {
      expect(handle.current!.exitOverlay()).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'L', pressed: true })).toBeTruthy()
  })

  it('PiP shows the popped-out bar, keeps the element mounted, and returns to dock', () => {
    const { container, handle } = renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Pop out mini-player' }))
    expect(getVideo(container)).toBeTruthy()
    expect(screen.getByText(/popped out/i)).toBeTruthy()
    expect(localStorage.getItem('mm-video-pane-7')).toBeNull() // pip never persisted

    act(() => {
      expect(handle.current!.exitOverlay()).toBe(true)
    })
    expect(screen.getByRole('group', { name: 'Video pane size' })).toBeTruthy()
  })

  it('exitOverlay is a no-op (false) in docked states', () => {
    const { handle } = renderPane()
    expect(handle.current!.exitOverlay()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse video pane' }))
    expect(handle.current!.exitOverlay()).toBe(false)
  })

  it('renders the codec-error message inside the well', () => {
    renderPane({ mediaError: 'This video uploaded, but your browser can’t play this codec.' })
    expect(screen.getByText(/can’t play this codec/)).toBeTruthy()
  })
})
