import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasAstral,
  codePointLength,
  utf16ToCodePoint,
  codePointToUtf16,
  sliceByCodePoints,
  charOffsetInElement,
} from './text-offsets'

/**
 * #687 — offsets were produced in UTF-16 (DOM) and consumed in code points (Python),
 * with no conversion anywhere. Measured: 6 of 11 cases corrupt, exclusively
 * astral-plane.
 *
 * The corpus mirrors `backend/tests/test_text_offsets.py::ASTRAL_CASES` deliberately,
 * so both sides of the boundary are exercised against the same data.
 */

const TARGET = 'CODE THIS PHRASE'

const CASES: [label: string, text: string, isAstral: boolean][] = [
  ['emoji U+1F600', 'Reaction 😀 then CODE THIS PHRASE and more', true],
  ['CJK Ext-B U+20000', 'Glyph 𠀀 then CODE THIS PHRASE and more', true],
  ['math alnum U+1D400', 'Sym 𝐀 then CODE THIS PHRASE and more', true],
  ['ZWJ family', 'Fam 👨‍👩‍👧‍👦 then CODE THIS PHRASE and more', true],
  ['flag (regional indicators)', 'Flag 🇺🇸 then CODE THIS PHRASE and more', true],
  ['skin-tone modifier', 'Wave 👋🏽 then CODE THIS PHRASE and more', true],
  ['combining e + U+0301', 'Café́ then CODE THIS PHRASE and more', false],
  ['Arabic (RTL)', 'مرحبا then CODE THIS PHRASE and more', false],
  ['Devanagari', 'नमस्ते then CODE THIS PHRASE and more', false],
  ['Thai', 'สวัสดี then CODE THIS PHRASE and more', false],
  ['plain ASCII', 'Hello then CODE THIS PHRASE and more', false],
]

/** Code-point index of `needle`, the basis the backend stores. */
function codePointIndexOf(text: string, needle: string): number {
  return Array.from(text.slice(0, text.indexOf(needle))).length
}

describe('hasAstral', () => {
  it.each(CASES)('%s', (_label, text, isAstral) => {
    expect(hasAstral(text)).toBe(isAstral)
  })
})

describe('utf16ToCodePoint — the producer-side conversion', () => {
  it.each(CASES)('%s: a DOM offset converts to the stored basis', (_label, text) => {
    // `indexOf` is UTF-16 — exactly what computeCharOffset accumulated pre-fix.
    const u16 = text.indexOf(TARGET)
    expect(utf16ToCodePoint(text, u16)).toBe(codePointIndexOf(text, TARGET))
  })

  it.each(CASES)('%s: the bases diverge exactly on the astral cases', (_label, text, isAstral) => {
    // Pins the SCOPE claim. BMP drift must stay 0 — that is what bounds the repair
    // migration to a small, identifiable row set.
    const drift = text.indexOf(TARGET) - codePointIndexOf(text, TARGET)
    expect(drift !== 0).toBe(isAstral)
  })
})

describe('utf16ToCodePoint — malformed mid-pair input', () => {
  it('resolves an index inside a surrogate pair to the code point AFTER it', () => {
    // Only reachable from malformed input — the DOM never hands out a mid-pair
    // index. Pinned because the docstring makes a specific claim about it, and an
    // untested claim about an edge case is how the wrong one survives.
    expect(utf16ToCodePoint('😀abc', 1)).toBe(1) // mid-pair
    expect(utf16ToCodePoint('😀abc', 2)).toBe(1) // just past the pair — same answer
    expect(sliceByCodePoints('😀abc', utf16ToCodePoint('😀abc', 1), 4)).toBe('abc')
  })
})

describe('round-trip', () => {
  it.each(CASES)('%s: utf16 → codepoint → utf16 is identity on boundaries', (_label, text) => {
    const u16 = text.indexOf(TARGET)
    expect(codePointToUtf16(text, utf16ToCodePoint(text, u16))).toBe(u16)
  })
})

describe('codePointLength', () => {
  it('counts code points, not units — this is what `text.length` should have been', () => {
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength('a😀b')).toBe(3)   // .length would say 4
    expect(codePointLength('')).toBe(0)
  })

  it.each(CASES)('%s matches Array.from', (_label, text) => {
    expect(codePointLength(text)).toBe(Array.from(text).length)
  })
})

describe('sliceByCodePoints — the consumer-side conversion', () => {
  it.each(CASES)('%s: slicing a stored range returns the selected phrase', (_label, text) => {
    const start = codePointIndexOf(text, TARGET)
    expect(sliceByCodePoints(text, start, start + TARGET.length)).toBe(TARGET)
  })

  it('clamps out-of-range ends rather than returning a short slice', () => {
    expect(sliceByCodePoints('a😀b', 0, 999)).toBe('a😀b')
  })

  it('returns empty for a reversed or zero-width range', () => {
    expect(sliceByCodePoints('a😀b', 2, 2)).toBe('')
    expect(sliceByCodePoints('a😀b', 3, 1)).toBe('')
  })

  it('never splits a surrogate pair', () => {
    // A raw .slice() with a code-point offset would cut mid-pair and yield a
    // replacement character — visible corruption in the highlight.
    const out = sliceByCodePoints('ab😀cd', 1, 3)
    expect(out).toBe('b😀')
    expect(out).not.toContain('�')
  })
})

describe('fail-closed: no site may slice segment text with a raw stored offset', () => {
  /**
   * There were FIFTEEN such sites when this landed — the stored-excerpt highlight,
   * two context-menu quote lists, the live drag preview in BOTH workbenches, two
   * copy-to-clipboard handlers, and the Quote Board card. They were all
   * *consistently* wrong together, which is exactly why nothing looked broken on
   * screen while every Python-side export drifted.
   *
   * A scan, not per-component tests: the defect is a repeated reflex across files,
   * which is the shape a per-variant test cannot see.
   */
  const SRC = join(__dirname, '..')
  const OFFENDING = /\.slice\([^)]*((start|end)_offset|textSelection\.(start|end))/

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
    }
    return out
  }

  /**
   * The scanned population, proven non-trivial before use (#730).
   *
   * The scan below asserts an EMPTY offender list, which a walk that found
   * nothing satisfies just as well. `readdirSync` throws on a missing path, so
   * the risk is not a blind walk but a VALID-but-narrower one — moving this
   * file changes what `join(__dirname, '..')` resolves to. The floor detects
   * that; it is NOT a growth pin (394 `.ts`/`.tsx` files today).
   */
  function scannedFiles(): string[] {
    const files = walk(SRC)
    expect(
      files.length,
      `the scan walked ${files.length} files under ${SRC} — far fewer than expected, `
        + 'so it is reading the wrong subtree and the assertion would pass '
        + 'vacuously. Fix the root; do NOT lower this floor.',
    ).toBeGreaterThan(250)
    return files
  }

  it('scans the whole frontend tree', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (OFFENDING.test(line)) offenders.push(`${file.replace(SRC + '/', '')}:${i + 1}`)
      })
    }
    expect(
      offenders,
      'Stored excerpt offsets are CODE POINTS (#687). A raw String.slice() indexes ' +
        'UTF-16, so on text containing an emoji or CJK-Extension-B character it ' +
        'returns the wrong substring — and splits surrogate pairs. Use ' +
        'sliceByCodePoints from lib/text-offsets.',
    ).toEqual([])
  })

  it('the scan can actually fail', () => {
    // A scan that cannot fail is not a guard.
    expect(OFFENDING.test('const t = segment.text.slice(e.start_offset, e.end_offset)')).toBe(true)
    expect(OFFENDING.test('{segment.text.slice(textSelection.start, textSelection.end)}')).toBe(true)
    expect(OFFENDING.test('sliceByCodePoints(segment.text, e.start_offset, e.end_offset)')).toBe(false)
  })
})

describe('charOffsetInElement — THE producer, now reachable from a test', () => {
  /**
   * Previously a closure inside `useTextSplitSelection`, only driveable through
   * `caretPositionFromPoint` — which jsdom does not implement. So the conversion
   * could be deleted and every test stayed green, on a defect whose whole character
   * was that it looked fine on screen. Extracting it is part of the fix.
   */
  function elementWith(...chunks: string[]): { el: HTMLElement; nodes: Text[] } {
    const el = document.createElement('div')
    const nodes = chunks.map((c) => {
      const t = document.createTextNode(c)
      el.appendChild(t)
      return t
    })
    return { el, nodes }
  }

  it.each(CASES)('%s: a DOM position converts to the stored basis', (_label, text) => {
    const { el, nodes } = elementWith(text)
    // A Range offset into character data is UTF-16 — the DOM's basis.
    const u16 = text.indexOf(TARGET)
    expect(charOffsetInElement(el, nodes[0], u16)).toBe(codePointIndexOf(text, TARGET))
  })

  it('accumulates across multiple text nodes, converting only at the end', () => {
    // The walk sums `Text.length` (UTF-16) across nodes; converting per-node would
    // be wrong, because a code-point count is not additive with a unit count.
    const { el, nodes } = elementWith('Hi 😀 ', 'and ', 'CODE HERE')
    const offset = charOffsetInElement(el, nodes[2], 0)
    const full = el.textContent!
    expect(sliceByCodePoints(full, offset, offset + 'CODE HERE'.length)).toBe('CODE HERE')
  })

  it('handles a position on the element itself', () => {
    const { el } = elementWith('a😀b')
    expect(charOffsetInElement(el, el, 0)).toBe(0)
    expect(charOffsetInElement(el, el, 1)).toBe(3) // code points, not 4 units
  })

  it('resolves a node outside the element to a boundary rather than throwing', () => {
    const { el } = elementWith('a😀b')
    const outside = document.createElement('span')
    document.body.appendChild(el)
    document.body.appendChild(outside)
    const result = charOffsetInElement(el, outside, 0)
    expect([0, codePointLength('a😀b')]).toContain(result)
    document.body.innerHTML = ''
  })
})
