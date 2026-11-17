/**
 * #1615 — the analysis doors read the viewer's scope from the QUERY STRING (`coder_ids: str | None`,
 * the spelling of every #1530 / #1608 door), while their callers hand it inside the request object
 * beside the body's own fields (`lib/analysis-scope.ts::coderIdsField`). This lifts it out. Left in
 * the JSON body, the route drops it without a word (`request-contract.test.ts` is the check across
 * the boundary), and a blind coder's chart reads every coder's ratings.
 *
 * Absent or empty = every coder, the convention of every `coder_ids`; `analysisScope` never
 * produces an empty list (it answers "no read" instead, D96).
 */
export function liftCoderIds<T extends { coder_ids?: number[] | null }>(
  data: T,
): [Omit<T, 'coder_ids'>, { coder_ids: string } | undefined] {
  const { coder_ids, ...body } = data
  return [body, coder_ids && coder_ids.length > 0 ? { coder_ids: coder_ids.join(',') } : undefined]
}
