import { type Segment } from '@/lib/api'

export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 1.75, 2]
export const SEEK_LEAD_IN_SECONDS = 1.5

/**
 * Floor semantics: find the segment with the highest start_time that is <= the
 * given time. Used during continuous playback to determine which segment the
 * playhead is currently within.
 */
export function findPlayingSegment(segments: Segment[], time: number): Segment | null {
  let best: Segment | null = null
  for (const seg of segments) {
    const segStart = seg.start_time ?? 0
    if (segStart <= time && (best === null || segStart > (best.start_time ?? 0))) {
      best = seg
    }
  }
  return best
}

/**
 * Nearest-neighbor: find the segment whose start_time is closest to a given
 * time. Used when the user clicks or drags the scrubber to a specific position.
 * Tries exact match first, then falls back to closest distance.
 */
export function findNearestSegment(segments: Segment[], time: number): Segment | null {
  // Try exact match first
  const exact = segments.find(s => s.start_time === time)
  if (exact) return exact

  let closest: Segment | null = null
  let closestDist = Infinity
  for (const seg of segments) {
    if (seg.start_time === null || seg.start_time === undefined) continue
    const dist = Math.abs(seg.start_time - time)
    if (dist < closestDist) {
      closestDist = dist
      closest = seg
    }
  }
  return closest
}
