/**
 * TimelineScrubber — #563: the timeline spans the TRANSCRIPT, but the recording
 * is an independent length.
 *
 * The scrubber only ever EXTENDED its range to cover a longer recording; it had
 * nothing to say when the recording was SHORTER than the transcript. So a 47-min
 * transcript carrying a 1:53 clip (a partial capture, a trimmed file, or simply
 * the wrong recording attached — the slot accepts any file for any transcript)
 * offered 45 minutes of track with nothing behind it. Scrubbing there parked the
 * player on the final frame and the next Play silently restarted at 0:00.
 *
 * The seek itself is fixed in `usePlayback` (clampMediaSeek). This is the other
 * half: SAY where the recording ends, so the dead stretch is explained rather
 * than mysterious — and so a user who attached the wrong file can see it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

import TimelineScrubber from './TimelineScrubber'
import type { Segment } from '@/lib/api'

const seg = (id: number, start: number, end: number) =>
  ({ id, start_time: start, end_time: end }) as unknown as Segment

/** A transcript running to 47:30 (2850s). */
const LONG_TRANSCRIPT = [seg(1, 0, 8), seg(2, 8.5, 17), seg(3, 2790, 2850)]

function renderScrubber(props: Partial<React.ComponentProps<typeof TimelineScrubber>> = {}) {
  return render(
    <TooltipProvider>
      <TimelineScrubber
        segments={LONG_TRANSCRIPT}
        currentTime={0}
        onTimeChange={() => {}}
        {...props}
      />
    </TooltipProvider>,
  )
}

describe('TimelineScrubber — recording coverage (#563)', () => {
  it('names where the recording ends when it stops before the transcript does', () => {
    renderScrubber({ mediaDuration: 113.2 }) // 1:53 of a 47:30 transcript
    expect(screen.getByText('47:30')).toBeInTheDocument()
    expect(screen.getByText(/rec\. 01:53/)).toBeInTheDocument()
  })

  it('says NOTHING when the recording covers the whole transcript (the normal case)', () => {
    renderScrubber({ mediaDuration: 2900 })
    expect(screen.queryByText(/rec\./)).not.toBeInTheDocument()
  })

  it('says nothing when there is no recording at all (transcript-only playback)', () => {
    renderScrubber({ mediaDuration: null })
    expect(screen.queryByText(/rec\./)).not.toBeInTheDocument()
  })

  it('an equal-length recording is not flagged (no off-by-one nag)', () => {
    renderScrubber({ mediaDuration: 2850 })
    expect(screen.queryByText(/rec\./)).not.toBeInTheDocument()
  })

  it('the slider still spans the full TRANSCRIPT — the untaped part stays readable/codable', () => {
    renderScrubber({ mediaDuration: 113.2 })
    // Clamping the RANGE to the recording would strand 45 minutes of transcript.
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', '2850')
  })
})


// ── #563b: a drag must land WHERE IT WAS DROPPED ───────────────────────────
//
// The release used to snap to the nearest segment's start_time. Turns are long:
// with segments starting at 0, 8.2 and 133s, dragging to 1:02 slammed the
// playhead back to 0:08 (nearer 8.2 than 133) — and on a 1:53 recording that
// left exactly TWO reachable positions in the entire video. The keyboard path
// never snapped, so drag and arrow-keys disagreed about the same position.
describe('TimelineScrubber — a drag seeks to the dropped position (#563b)', () => {
  /** Drag the track to `fraction` across and release. */
  function dragTo(track: HTMLElement, fraction: number) {
    // jsdom gives every element a 0×0 rect; stub the one the component measures.
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 1000, top: 0, height: 16, right: 1000, bottom: 16, x: 0, y: 0,
      toJSON: () => {},
    } as DOMRect)
    fireEvent.mouseDown(track, { clientX: fraction * 1000 })
    fireEvent.mouseMove(window, { clientX: fraction * 1000 })
    fireEvent.mouseUp(window, { clientX: fraction * 1000 })
  }

  it('seeks to the dropped time, NOT the nearest segment start', () => {
    const onTimeChange = vi.fn()
    const { container } = renderScrubber({ onTimeChange, mediaDuration: 113.2 })
    const track = container.querySelector('[role=slider]') as HTMLElement

    dragTo(track, 62 / 2850) // the user's gesture: ~1:02 into a 47:30 transcript

    expect(onTimeChange).toHaveBeenCalledTimes(1)
    const t = onTimeChange.mock.calls[0][0]
    expect(t).toBeCloseTo(62, 0)
    // The old behavior: snapped to segment 2's start (8.215s).
    expect(t).not.toBeCloseTo(8.215, 1)
  })

  it('a drag still works when NO segment carries a timestamp (media-only scrubbing)', () => {
    // The old release only fired if it found a segment start to snap to, so a
    // recording attached to an un-timestamped transcript had a dead scrubber.
    const onTimeChange = vi.fn()
    const untimed = [{ id: 1 }, { id: 2 }] as unknown as Segment[]
    const { container } = renderScrubber({
      onTimeChange,
      segments: untimed,
      mediaDuration: 100,
    })
    const track = container.querySelector('[role=slider]') as HTMLElement

    dragTo(track, 0.5)

    expect(onTimeChange).toHaveBeenCalledTimes(1)
    expect(onTimeChange.mock.calls[0][0]).toBeCloseTo(50, 0)
  })

  it('drag and keyboard agree on the same position (they used to disagree)', () => {
    const onTimeChange = vi.fn()
    const { container } = renderScrubber({ onTimeChange, currentTime: 0, mediaDuration: 113.2 })
    const track = container.querySelector('[role=slider]') as HTMLElement

    fireEvent.keyDown(track, { key: 'ArrowRight', shiftKey: true }) // +30s, never snapped
    const viaKeyboard = onTimeChange.mock.calls[0][0]

    onTimeChange.mockClear()
    dragTo(track, 30 / 2850) // the same 30s, by drag
    const viaDrag = onTimeChange.mock.calls[0][0]

    expect(viaDrag).toBeCloseTo(viaKeyboard, 0)
  })
})


// ── #564: the playhead past the end of the recording ───────────────────────
describe('TimelineScrubber — "transcript only" past the recording (#564)', () => {
  it('says so in the ticker when the playhead is past the recording', () => {
    renderScrubber({ mediaDuration: 113.2, currentTime: 1547 })
    expect(screen.getByText(/transcript only/i)).toBeInTheDocument()
  })

  it('says nothing when the playhead is inside the recording', () => {
    renderScrubber({ mediaDuration: 113.2, currentTime: 62 })
    expect(screen.queryByText(/transcript only/i)).not.toBeInTheDocument()
  })

  it('the state reaches a screen reader, not just the colour', () => {
    // The amber thumb and the hatch are invisible to AT — aria-valuetext is the
    // only carrier. Colour must never be the sole signal.
    renderScrubber({ mediaDuration: 113.2, currentTime: 1547 })
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('transcript only') as unknown as string,
    )
  })

  it('honours the sync offset when deciding where the recording ends', () => {
    // 113.2s recording at +20s offset reaches only timeline 93.2s, so 100s is
    // past it even though it is well under the raw duration.
    renderScrubber({ mediaDuration: 113.2, mediaOffset: 20, currentTime: 100 })
    expect(screen.getByText(/transcript only/i)).toBeInTheDocument()
  })

  it('no recording ⇒ nothing is "beyond" it (transcript-only conversation)', () => {
    renderScrubber({ mediaDuration: null, currentTime: 2000 })
    expect(screen.queryByText(/transcript only/i)).not.toBeInTheDocument()
  })
})
