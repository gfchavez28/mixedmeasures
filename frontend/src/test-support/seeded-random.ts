/**
 * A seeded generator for property tests (#1324).
 *
 * No property-testing library is a dev dependency (no `fast-check` in
 * `package.json`), and adding one for a handful of properties is a supply-chain
 * cost this project weighs per package (the internal design notes).
 * So: a fixed-seed PRNG and the generators the properties need. Deterministic — a
 * failure names its seed and reproduces exactly — and with no shrinking, so each
 * property states its population floor instead.
 *
 * mulberry32: a 32-bit state, period 2^32, good enough to spread quote sets; not
 * cryptographic and not meant to be.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An integer in [lo, hi] inclusive. */
export function randInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1))
}

export interface GeneratedQuote {
  id: number
  start_offset: number
  end_offset: number
}

/**
 * A set of char-range quotes over a text of `length` code points, as the server can
 * hold them: distinct (start, end) pairs (`ix_excerpt_segment_range` is unique per
 * segment), `0 <= start < end <= length` (`ck_excerpt_offsets_valid_range`).
 *
 * Biased toward the shapes #1324 is about: about a third of the quotes are built
 * INSIDE an earlier one (nesting) and a third straddle an earlier one's edge
 * (crossing overlap); the rest are free.
 */
export function randomQuoteSet(rnd: () => number, length: number, maxQuotes = 6): GeneratedQuote[] {
  const out: GeneratedQuote[] = []
  const seen = new Set<string>()
  if (length < 1) return out
  const n = randInt(rnd, 1, maxQuotes)
  for (let attempt = 0; out.length < n && attempt < n * 10; attempt++) {
    let s: number
    let e: number
    const base = out.length ? out[randInt(rnd, 0, out.length - 1)] : null
    const shape = rnd()
    if (base && shape < 0.34 && base.end_offset - base.start_offset >= 1) {
      s = randInt(rnd, base.start_offset, base.end_offset - 1)
      e = randInt(rnd, s + 1, base.end_offset)
    } else if (base && shape < 0.67) {
      s = randInt(rnd, base.start_offset, base.end_offset - 1)
      e = randInt(rnd, Math.min(base.end_offset + 1, length), length)
      if (e <= s) e = Math.min(length, s + 1)
    } else {
      s = randInt(rnd, 0, length - 1)
      e = randInt(rnd, s + 1, length)
    }
    const key = `${s}:${e}`
    if (s >= e || seen.has(key)) continue
    seen.add(key)
    out.push({ id: 100 + out.length, start_offset: s, end_offset: e })
  }
  return out
}
