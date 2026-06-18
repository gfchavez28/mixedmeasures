/**
 * Coding-progress predicate — single client-side definition of "a segment is coded"
 * (invariant J-A, #398). A segment counts as coded iff it has at least one
 * NON-universal code applied; a segment whose only codes are universal markers
 * ("Unclear" / "Unsubstantive/Artifact") is NOT coded — matching the backend
 * `coded_segment_count` and every other surface.
 *
 * The document coding workbench previously counted any-code (`codes.length > 0`),
 * which disagreed with the backend (e.g. a document showing 4/14 coded in the
 * workbench but 2/14 everywhere else). Route every client-side "is this coded?"
 * derivation (gauge count, progress gradient, jump-to-uncoded) through this.
 */
export interface CodeLike {
  is_universal: boolean
}

export function isSegmentCoded(codes: readonly CodeLike[]): boolean {
  return codes.some(c => !c.is_universal)
}
