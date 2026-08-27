/**
 * Where a dumbbell's inline value labels go, and whether they fit (#787).
 *
 * 🔴 **The defect this replaces was a PROXY standing in for a measurement.**
 * #428(c) suppressed the inline labels when a row was `isJittered && dots > 5`.
 * Both halves are the wrong variable:
 *
 *  - `isJittered` is computed from DOT geometry — dots offset vertically only when
 *    they come within `DOT_RADIUS * 2` (12px) of each other. A value LABEL is
 *    ~26px wide. So between 12px and ~26px of separation the dots are perfectly
 *    fine and the labels overlap, and the suppression never even runs because it
 *    sits behind `isJittered`.
 *  - `dots > 5` counts groups. The reported repro is **four** — an ordinary
 *    Pre_Score by Gender comparison — so the count never reached the threshold.
 *
 * MEASURED on that repro before the fix: labels at x = 294 / 313 / 326, all on one
 * line, rendering as `65.5665.7.4` — three numbers fused into one unreadable run.
 * Neither proxy fires; the chart simply shows glyph soup.
 *
 * ⚠️ **The remedy is unchanged from #428(c) and deliberately so**: when the labels
 * cannot all be read, drop the row's inline labels entirely. The dots, the
 * connecting line and the tooltips still carry every value, and the comparison
 * table is the precise read. What changes is the QUESTION — from "are there many
 * dots?" to "do these labels actually overlap?".
 *
 * ⚠️ **Placement lives here too, not just the collision test.** The renderer reads
 * the same placements it is judged on, so the two cannot disagree about where a
 * label sits — the #790 lesson, where a display flag and the state it described
 * drifted apart because they were computed in different places.
 */

/** A placed label, in SVG user units. */
export interface DotLabelPlacement {
  x: number
  y: number
  anchor: 'middle' | 'start'
  /** The box the glyphs occupy, for the overlap test. */
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Average glyph width as a fraction of font size, for the digit-and-dot strings
 * these labels always are (`"66.5"`, `"84.0%"`).
 *
 * ⚠️ CALIBRATED against the real render, not guessed: at `dataLabelFontSize`,
 * four-character labels measured 23–28px via `getBoundingClientRect`, and
 * `4 * size * 0.6` lands at 26.4 — inside that band. It is an ESTIMATE and it only
 * has to be good enough to decide overlap, which `LABEL_GAP` absorbs. Measuring
 * exactly would need `getComputedTextLength` on a mounted node, i.e. a second
 * render pass, to gain a couple of pixels on a threshold question.
 */
const CHAR_WIDTH_RATIO = 0.6

/** Breathing room required BETWEEN two labels before they count as readable. */
const LABEL_GAP = 3

export function estimateLabelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_RATIO
}

/**
 * Place every dot's value label for one row, mirroring the jitter spread: the
 * topmost dot labels above, the bottommost below, and anything in between to the
 * right of its own dot.
 */
export function placeDotLabels(params: {
  /** Formatted label text per dot, in dot order. */
  texts: string[]
  /** Each dot's x centre, in dot order. */
  pixelXs: number[]
  /** Vertical jitter per dot; all zeros when the row did not jitter. */
  jitterOffsets: number[]
  /** The row's baseline y. */
  baseY: number
  dotRadius: number
  fontSize: number
}): DotLabelPlacement[] {
  const { texts, pixelXs, jitterOffsets, baseY, dotRadius, fontSize } = params
  const isJittered = jitterOffsets.some(o => o !== 0)
  const multiDot = texts.length > 1
  const minOffset = Math.min(...jitterOffsets)
  const maxOffset = Math.max(...jitterOffsets)

  return texts.map((text, i) => {
    const cx = pixelXs[i]
    const dy = baseY + jitterOffsets[i]
    let x = cx
    let y = dy - dotRadius - 6
    let anchor: 'middle' | 'start' = 'middle'

    if (isJittered && multiDot) {
      if (jitterOffsets[i] === minOffset) {
        y = dy - dotRadius - 6
      } else if (jitterOffsets[i] === maxOffset) {
        y = dy + dotRadius + fontSize
      } else {
        x = cx + dotRadius + 4
        y = dy + fontSize / 3
        anchor = 'start'
      }
    }

    const width = estimateLabelWidth(text, fontSize)
    const left = anchor === 'start' ? x : x - width / 2
    return {
      x, y, anchor,
      left,
      right: left + width,
      // `y` is the text baseline; the glyphs sit above it.
      top: y - fontSize,
      bottom: y,
    }
  })
}

/**
 * Which of these labels can be shown?
 *
 * A label is hidden when it would overlap ANY other in the row; everything with
 * room to itself keeps its number.
 *
 * ⚠️ **Per-LABEL, not per-row — and that came from looking at the rendered chart.**
 * #428(c)'s remedy was to drop the whole row's labels, which was proportionate to a
 * detector that could only answer "is this row crowded?". Now that the test is
 * pairwise, the row remedy over-applies: in the measured repro three labels are
 * fused at x = 294/313/326 while a fourth sits alone at 564, **238px from its
 * nearest neighbour**, and suppressing that one buys nothing. It is also the most
 * informative label on the chart — the separated group IS the finding a group
 * comparison exists to show.
 *
 * ⚠️ Overlap is tested in BOTH axes, which is what lets one rule cover the jittered
 * and un-jittered cases at once. Jittered labels are spread onto different lines on
 * purpose, so two that share an x-range but sit on separate rows read perfectly
 * well; an x-only test would hide them, which is the opposite defect and just as
 * invisible — the chart would quietly be missing numbers nobody asked it to drop.
 */
export function visibleLabels(placements: DotLabelPlacement[], gap: number = LABEL_GAP): boolean[] {
  const visible = placements.map(() => true)
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]
      const b = placements[j]
      const overlapsX = a.left < b.right + gap && b.left < a.right + gap
      const overlapsY = a.top < b.bottom && b.top < a.bottom
      if (overlapsX && overlapsY) {
        visible[i] = false
        visible[j] = false
      }
    }
  }
  return visible
}
