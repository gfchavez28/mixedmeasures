import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import { ChevronDown, Loader2, Maximize2, Pause, PictureInPicture2, Play, Undo2, Video, Volume2, VolumeX } from 'lucide-react'
import { type Segment, mediaApi } from '@/lib/api'
import { SELECTED_SEGMENT } from '@/lib/selection'
import { cn } from '@/lib/utils'
import TimelineScrubber from '@/components/TimelineScrubber'

/**
 * Video pane for the conversation workbench (V1 slab 4 — Layout A per the
 * 2026-07-05 mockup): docks at the top of the LEFT/transcript column,
 * height-capped, code panel untouched in every state.
 *
 * Load-bearing DOM invariant: the <video> element is NEVER unmounted or
 * reparented across state changes — Chromium pauses a media element moved
 * between DOM parents. Collapse hides the well with display:none (audio
 * keeps playing — the "audio parity" listening mode); PiP restyles the SAME
 * well to position:fixed. All state changes are CSS-only.
 *
 * Persistence (mockup note 5): S/M/L + collapsed persist per conversation;
 * theater and PiP are temporary and never persist — Esc (via the workbench
 * keyboard layer's onEscapeOverlay) or the return controls restore the
 * previous docked size.
 */

export type VideoPaneMode = 'collapsed' | 's' | 'm' | 'l' | 'theater' | 'pip'
type DockedSize = 's' | 'm' | 'l'

const WELL_HEIGHTS: Record<DockedSize, number> = { s: 282, m: 342, l: 412 }
const PERSISTABLE = new Set<VideoPaneMode>(['s', 'm', 'l', 'collapsed'])

function storageKey(conversationId: number) {
  return `mm-video-pane-${conversationId}`
}

function readPersistedMode(conversationId: number): VideoPaneMode {
  try {
    const v = localStorage.getItem(storageKey(conversationId))
    if (v && PERSISTABLE.has(v as VideoPaneMode)) return v as VideoPaneMode
  } catch {
    // private mode — default below
  }
  return 'm'
}

export interface VideoPaneHandle {
  /** Exit theater/PiP back to the previous docked size. True if an overlay was exited. */
  exitOverlay: () => boolean
}

interface VideoPaneProps {
  projectId: number
  conversationId: number
  /** Media element ref shared with usePlayback (the pane's <video> assigns into it). */
  mediaRef: RefObject<HTMLVideoElement | HTMLAudioElement | null>
  /** All segments (unfiltered) — drives the scrubber's segment tick marks. */
  segments: Segment[]
  mediaDuration: number | null
  isVbr: boolean
  isPlaying: boolean
  isMediaReady: boolean
  isBuffering: boolean
  mediaError: string | null
  /** Transcript-domain playhead time for the scrubber/readout. */
  currentTime: number | null
  playbackSpeed: number
  onTogglePlayback: () => void
  onCycleSpeed: () => void
  /** Scrubber seek (transcript-domain) — same contract as the toolbar scrubber. */
  onTimeChange: (time: number) => void
  onPositionChange?: (position: number) => void
}

const VideoPane = forwardRef<VideoPaneHandle, VideoPaneProps>(function VideoPane(
  {
    projectId,
    conversationId,
    mediaRef,
    segments,
    mediaDuration,
    isVbr,
    isPlaying,
    isMediaReady,
    isBuffering,
    mediaError,
    currentTime,
    playbackSpeed,
    onTogglePlayback,
    onCycleSpeed,
    onTimeChange,
    onPositionChange,
  },
  ref,
) {
  const [mode, setModeState] = useState<VideoPaneMode>(() => readPersistedMode(conversationId))
  const prevSizeRef = useRef<DockedSize>('m')
  const [muted, setMuted] = useState(false)
  // PiP drag offset from the anchored bottom-right position.
  const [pipOffset, setPipOffset] = useState({ x: 0, y: 0 })
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  const setMode = useCallback(
    (next: VideoPaneMode) => {
      setModeState(prev => {
        if (prev === 's' || prev === 'm' || prev === 'l') prevSizeRef.current = prev
        return next
      })
      if (PERSISTABLE.has(next)) {
        try {
          localStorage.setItem(storageKey(conversationId), next)
        } catch {
          // session-only
        }
      }
      if (next !== 'pip') setPipOffset({ x: 0, y: 0 })
    },
    [conversationId],
  )

  // NOTE: the mounting surface keys this component by conversationId, so a
  // conversation switch remounts it — the useState initializer re-reads the
  // persisted size and theater/PiP state naturally drops.

  const restorePrevSize = useCallback(() => setMode(prevSizeRef.current), [setMode])

  useImperativeHandle(
    ref,
    () => ({
      exitOverlay: () => {
        if (mode === 'theater' || mode === 'pip') {
          restorePrevSize()
          return true
        }
        return false
      },
    }),
    [mode, restorePrevSize],
  )

  // muted is React-controlled on the <video> element, so it can never desync.
  const toggleMute = useCallback(() => setMuted(m => !m), [])

  // PiP drag-to-reposition (mockup note 4): pointer-drag on the video area.
  const handlePipPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'pip') return
      if ((e.target as HTMLElement).closest('button, [role="slider"]')) return
      dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, ...pipOffset }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [mode, pipOffset],
  )
  const handlePipPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start) return
    setPipOffset({ x: start.x + (e.clientX - start.pointerX), y: start.y + (e.clientY - start.pointerY) })
  }, [])
  const handlePipPointerUp = useCallback(() => {
    dragStartRef.current = null
  }, [])

  const isCollapsed = mode === 'collapsed'
  const isPip = mode === 'pip'
  const dockedSize: DockedSize = mode === 's' || mode === 'l' ? mode : 'm'
  const wellHeight: string | number =
    mode === 'theater' ? 'min(500px, 55vh)' : isPip ? 180 : WELL_HEIGHTS[dockedSize]

  const playDisabled = !isMediaReady || !!mediaError

  const scrubber = (
    <TimelineScrubber
      segments={segments}
      currentTime={currentTime}
      onTimeChange={onTimeChange}
      onPositionChange={onPositionChange}
      mediaDuration={mediaDuration}
      isVbr={isVbr}
      className="flex-1"
    />
  )

  const playButton = (extraClass?: string) => (
    <button
      type="button"
      onClick={onTogglePlayback}
      disabled={playDisabled}
      aria-label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      title={
        mediaError ? 'Video unavailable — this codec can’t play in-browser' :
        playDisabled ? 'Loading video...' :
        isPlaying ? 'Pause (Space)' : 'Play (Space)'
      }
      className={cn(
        'w-7 h-7 rounded-md inline-flex items-center justify-center text-mm-text-secondary hover:bg-mm-surface-hover disabled:opacity-40 disabled:pointer-events-none flex-shrink-0',
        extraClass,
      )}
    >
      {isBuffering ? <Loader2 className="w-4 h-4 animate-spin" /> : isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
    </button>
  )

  return (
    <div data-video-pane className="bg-mm-surface border-b border-mm-border-medium flex-shrink-0">
      {/* The well — docked, floating (PiP), or display:none (collapsed).
        * ONE element for the life of the pane; the <video> inside never
        * unmounts, so playback survives every state change. */}
      <div
        className={cn(
          isCollapsed && 'hidden',
          !isCollapsed && !isPip && 'relative w-full flex items-center justify-center overflow-hidden bg-[hsl(var(--mm-media-well))]',
          isPip &&
            'fixed z-50 w-80 flex items-center justify-center overflow-hidden rounded-lg border border-mm-border-medium shadow-2xl bg-[hsl(var(--mm-media-well))] cursor-grab active:cursor-grabbing',
        )}
        style={{
          height: isCollapsed ? undefined : wellHeight,
          ...(isPip
            ? { right: 16, bottom: 48, transform: `translate(${pipOffset.x}px, ${pipOffset.y}px)` }
            : {}),
        }}
        onPointerDown={handlePipPointerDown}
        onPointerMove={handlePipPointerMove}
        onPointerUp={handlePipPointerUp}
      >
        {/* No <track> captions: the synced transcript IS the caption surface (transcript-first design). */}
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          src={mediaApi.getStreamUrl(projectId, conversationId)}
          preload="metadata"
          playsInline
          muted={muted}
          className="h-full max-w-full"
          onClick={onTogglePlayback}
        />

        {/* paused-state play disc */}
        {!isPlaying && !mediaError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <button
              type="button"
              onClick={onTogglePlayback}
              disabled={playDisabled}
              aria-label="Play video"
              className="pointer-events-auto rounded-full bg-mm-surface/90 text-mm-text shadow-lg flex items-center justify-center disabled:opacity-50"
              style={{ width: 52, height: 52 }}
            >
              {isMediaReady ? <Play className="w-5 h-5 ml-0.5" /> : <Loader2 className="w-5 h-5 animate-spin" />}
            </button>
          </div>
        )}

        {/* codec-failure state — mirror the toast inside the well so the
          * black box explains itself */}
        {mediaError && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <p className="text-xs text-center max-w-md" style={{ color: 'hsl(var(--mm-chrome-text-muted))' }}>{mediaError}</p>
          </div>
        )}

        {mode === 'theater' && (
          <span className="absolute top-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-mm-surface/90 text-mm-text-secondary text-[10.5px] shadow-sm">
            Theater — <span className="font-mono font-medium">Esc</span> to exit
          </span>
        )}

        {/* PiP overlay controls */}
        {isPip && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-2 pb-1.5 pt-5 bg-gradient-to-t from-black/70 to-transparent text-white">
            <button
              type="button"
              onClick={onTogglePlayback}
              disabled={playDisabled}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="w-6 h-6 rounded inline-flex items-center justify-center hover:bg-white/15 disabled:opacity-40 flex-shrink-0"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            {scrubber}
            <button
              type="button"
              onClick={restorePrevSize}
              aria-label="Return video to the dock"
              title="Return to dock (restores previous size)"
              className="w-6 h-6 rounded inline-flex items-center justify-center hover:bg-white/15 flex-shrink-0"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* transport strip (expanded states) */}
      {!isCollapsed && !isPip && (
        <div className="flex items-center gap-2 h-[38px] px-2.5">
          {playButton()}
          {scrubber}
          <button
            type="button"
            onClick={onCycleSpeed}
            title="Playback speed (0.5×–2×, pitch preserved)"
            className="h-[22px] px-1.5 rounded font-mono text-[11px] text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            {playbackSpeed}×
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
            className="w-6 h-6 rounded inline-flex items-center justify-center text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <span className="w-px h-[18px] bg-mm-border-subtle flex-shrink-0" />
          <div role="group" aria-label="Video pane size" className="flex rounded-md border border-mm-border-medium overflow-hidden flex-shrink-0">
            {(['s', 'm', 'l'] as const).map(size => (
              <button
                key={size}
                type="button"
                onClick={() => setMode(size)}
                aria-pressed={mode === size}
                title={size === 's' ? 'Small (~320px)' : size === 'm' ? 'Medium (~380px)' : 'Large (~450px)'}
                className={cn(
                  'h-[22px] px-2.5 text-[11px] border-l border-mm-border-subtle first:border-l-0',
                  mode === size ? SELECTED_SEGMENT : 'text-mm-text-muted hover:bg-mm-surface-hover',
                )}
              >
                {size.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMode('theater')}
            aria-label="Theater mode"
            title="Theater (temporary expansion — Esc exits)"
            className="w-6 h-6 rounded inline-flex items-center justify-center text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMode('pip')}
            aria-label="Pop out mini-player"
            title="Pop out floating mini-player"
            className="w-6 h-6 rounded inline-flex items-center justify-center text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMode('collapsed')}
            aria-label="Collapse video pane"
            title="Collapse to bar"
            className="w-6 h-6 rounded inline-flex items-center justify-center text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* collapsed bar — audio parity: transport stays, glass goes */}
      {isCollapsed && (
        <div className="flex items-center gap-2 h-[42px] px-3">
          <Video className="w-3.5 h-3.5 text-mm-green-text flex-shrink-0" aria-hidden="true" />
          {playButton()}
          {scrubber}
          <button
            type="button"
            onClick={onCycleSpeed}
            title="Playback speed"
            className="h-[22px] px-1.5 rounded font-mono text-[11px] text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            {playbackSpeed}×
          </button>
          <span className="w-px h-[18px] bg-mm-border-subtle flex-shrink-0" />
          <button
            type="button"
            onClick={restorePrevSize}
            className="h-[26px] px-2.5 rounded-md border border-mm-border-medium inline-flex items-center gap-1.5 text-[11.5px] text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            <Video className="w-3 h-3" aria-hidden="true" />
            Show video
          </button>
        </div>
      )}

      {/* popped-out placeholder bar (PiP active) */}
      {isPip && (
        <div className="flex items-center gap-2 h-[42px] px-3">
          <PictureInPicture2 className="w-3.5 h-3.5 text-mm-green-text flex-shrink-0" aria-hidden="true" />
          <span className="text-xs text-mm-text-muted">Video popped out — playing in the mini-player</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={restorePrevSize}
            className="h-[26px] px-2.5 rounded-md border border-mm-border-medium inline-flex items-center gap-1.5 text-[11.5px] text-mm-text-secondary hover:bg-mm-surface-hover flex-shrink-0"
          >
            <Undo2 className="w-3 h-3" aria-hidden="true" />
            Return to dock
          </button>
        </div>
      )}
    </div>
  )
})

export default VideoPane
