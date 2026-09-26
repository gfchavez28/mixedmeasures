/**
 * A long single-request wait, shown honestly (#796b; shared since #1015).
 *
 * The server reports no progress, so the fill is paced by an ESTIMATE and never
 * reaches full, and the words say ELAPSED (a fact) beside the estimate (labelled
 * as one). Used with `hooks/useElapsedSeconds`.
 */

/** Elapsed past `estimate × this` reads as "longer than usual". */
export const OVER_ESTIMATE_FACTOR = 1.15

const PROGRESS_CEILING = 0.92

/** The fill fraction: approaches but never reaches full while work is running. */
export function fillFraction(elapsedSeconds: number, estimateSeconds: number): number {
  if (estimateSeconds <= 0) return 0
  // Asymptotic rather than linear: passing the estimate slows the fill instead
  // of pinning it, so a longer-than-expected run still visibly moves.
  const ratio = elapsedSeconds / estimateSeconds
  return PROGRESS_CEILING * (1 - Math.exp(-1.6 * ratio))
}

export function isOverEstimate(elapsedSeconds: number, estimateSeconds: number): boolean {
  return elapsedSeconds > estimateSeconds * OVER_ESTIMATE_FACTOR
}

/**
 * The line beside the fill. Says ELAPSED and the estimate, and admits when the
 * estimate has been passed rather than going quiet — silence at 92% full is
 * exactly the state that reads as a hang.
 */
export function elapsedNote(elapsed: number, estimate: number, over: boolean): string {
  const s = Math.round(elapsed)
  if (over) return `${s}s elapsed — longer than the usual ~${estimate}s for this size. Still working.`
  return `${s}s elapsed — usually about ${estimate}s for a file this size.`
}

/**
 * The line beside a wait that has NO estimate — elapsed time and nothing else.
 *
 * For a wait no one has measured on real data (a restore, #1024): an uncalibrated
 * "usually about N s" is a claim about a corpus that was never looked at, which
 * is the mistake the merge's first estimate made. With no estimate there is no
 * fill either — a bar paced by a guess is the same claim drawn instead of written.
 */
export function elapsedOnlyNote(elapsed: number): string {
  return `${Math.round(elapsed)}s elapsed.`
}

/**
 * The periodic spoken line (every 30 s), or null between announcements. A live
 * region that fired every tick would make a page unusable with a screen reader;
 * the fill is the continuous signal for sighted users and this is the periodic
 * one for everyone else.
 */
export const ANNOUNCE_EVERY_SECONDS = 30

export function stillWorkingMessage(elapsed: number, over: boolean): string {
  return `Still working — ${Math.round(elapsed)} seconds elapsed${
    over ? '. This is taking longer than usual for this file.' : '.'
  }`
}
