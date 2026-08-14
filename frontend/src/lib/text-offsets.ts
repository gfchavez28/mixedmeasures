/**
 * The ONE place the browser's UTF-16 view of a string is reconciled with the
 * code-point basis everything else uses (#687).
 *
 * ## The defect
 *
 * Offsets were PRODUCED in the browser by walking text nodes and accumulating
 * `Text.length`, then adding a DOM `Range` offset — both **UTF-16 code units** per
 * the DOM spec. They were CONSUMED in Python by slicing `str`, which indexes **code
 * points**. There was no conversion anywhere in either tree.
 *
 * Measured: 6 of 11 cases corrupt, and the defect is **exclusively astral-plane** —
 * combining sequences, precomposed forms, Arabic, Devanagari and Thai are all clean,
 * because BMP characters occupy exactly one unit in both bases. That is what makes
 * the fast path below sound and the repair migration bounded.
 *
 * ```
 * emoji U+1F600      'CODE THIS PHRASE' -> 'ODE THIS PHRASE '   drift +1
 * ZWJ family         'CODE THIS PHRASE' -> ' THIS PHRASE and'   drift +4
 * combining é, RTL, Devanagari, Thai, ASCII                     drift  0
 * ```
 *
 * ## Which basis is correct is not a judgement call
 *
 * REFI-QDA specifies text selections in Unicode **code points**, first codepoint
 * numbered zero. The backend's basis was already right; the browser was wrong. So
 * this converts at the producer and the app speaks code points from there inward.
 *
 * ## The rule this module exists to enforce
 *
 * **Inside `computeCharOffset` (and only there) offsets are UTF-16. Everywhere else
 * in the frontend they are code points.** That means every site that slices segment
 * text with a stored offset must go through `sliceByCodePoints` — a raw
 * `text.slice(start, end)` on a stored offset is a bug. There were SEVEN such sites
 * when this landed, including the live drag preview, and they were previously all
 * *consistently* wrong together, which is exactly why nothing looked broken on
 * screen while every export drifted.
 *
 * ## Performance
 *
 * Conversion is O(n) in the string, so every entry point short-circuits on
 * `hasAstral`. Segment text without a surrogate pair — which is nearly all of it —
 * costs one regex test and no walk.
 */

/**
 * Does this string contain any astral-plane character?
 *
 * Tests for a HIGH surrogate specifically: a well-formed string only contains one
 * as the first unit of a surrogate pair, which is precisely the case where the two
 * bases diverge. (A lone/unpaired surrogate is malformed input; treating it as
 * astral is the safe direction — it makes us walk rather than assume.)
 */
export function hasAstral(text: string): boolean {
  return /[\uD800-\uDBFF]/.test(text)
}

/** Length in code points — what `text.length` should have been as an end offset. */
export function codePointLength(text: string): number {
  if (!hasAstral(text)) return text.length
  let n = 0
  for (let i = 0; i < text.length; ) {
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    n++
  }
  return n
}

/**
 * UTF-16 code-unit index → code-point index. The producer-side conversion.
 *
 * An index landing INSIDE a surrogate pair — only reachable from malformed input;
 * the DOM never hands one out — resolves to the code point AFTER the pair rather
 * than throwing. The loop consumes whole code points, so it steps past the pair and
 * stops: the mid-pair index and the index just after it give the same answer. A
 * selection boundary is not worth an exception, and rounding outward keeps the
 * result a valid boundary instead of one that could split the pair on the way back.
 */
export function utf16ToCodePoint(text: string, utf16Index: number): number {
  if (utf16Index <= 0) return 0
  if (!hasAstral(text)) return Math.min(utf16Index, text.length)
  let cp = 0
  let i = 0
  while (i < utf16Index && i < text.length) {
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    cp++
  }
  return cp
}

/**
 * Code-point index → UTF-16 code-unit index. The consumer-side conversion, used to
 * turn a stored offset back into something `String.prototype.slice` understands.
 */
export function codePointToUtf16(text: string, cpIndex: number): number {
  if (cpIndex <= 0) return 0
  if (!hasAstral(text)) return Math.min(cpIndex, text.length)
  let cp = 0
  let i = 0
  while (cp < cpIndex && i < text.length) {
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    cp++
  }
  return i
}

/**
 * Slice `text` by CODE-POINT offsets — the only correct way to render a stored
 * excerpt range in the browser.
 *
 * `end` is clamped to the string, matching the defensive `Math.min(end,
 * text.length)` the display sites already carried. `start >= end` yields `''`
 * rather than a reversed slice.
 */
export function sliceByCodePoints(text: string, start: number, end: number): string {
  if (!hasAstral(text)) {
    return text.slice(Math.max(0, start), Math.min(end, text.length))
  }
  const s = codePointToUtf16(text, Math.max(0, start))
  const e = codePointToUtf16(text, end)
  return s >= e ? '' : text.slice(s, e)
}

/**
 * Character offset of a DOM position within `textEl`, **in code points**.
 *
 * This is THE producer — the one function in the frontend that reads the DOM's
 * UTF-16 view and hands back the basis everything else uses.
 *
 * It lives here, rather than as a closure inside `useTextSplitSelection`, so it can
 * be tested. Inside the hook it was only reachable through a mouse event routed via
 * `caretPositionFromPoint`, which jsdom does not implement — so the conversion could
 * be reverted and the entire suite stayed green. Given the defect was *silent*
 * (display and storage were wrong together, so nothing looked broken), an
 * untestable producer was the worst possible place to leave it.
 *
 * `node`/`offset` are a DOM position as `caretPositionFromPoint` / `Range` report
 * it: `offset` counts UTF-16 code units when `node` is character data.
 */
export function charOffsetInElement(textEl: HTMLElement, node: Node, offset: number): number {
  const full = textEl.textContent ?? ''

  // ── everything in this block is UTF-16 code units ──
  let utf16: number
  if (node === textEl) {
    utf16 = offset === 0 ? 0 : full.length
  } else {
    const walker = textEl.ownerDocument.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
    let charCount = 0
    let found = false
    let textNode: Node | null
    while ((textNode = walker.nextNode())) {
      if (textNode === node) {
        utf16 = charCount + offset
        found = true
        break
      }
      charCount += (textNode as Text).length
    }
    if (!found) {
      // The position is outside this element: before it (offset 0) or after it.
      const cmp = node.compareDocumentPosition(textEl)
      utf16 = cmp & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : full.length
    }
  }

  return utf16ToCodePoint(full, utf16!)
}
