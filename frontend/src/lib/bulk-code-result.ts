/**
 * #678 — interpreting a bulk-code response.
 *
 * The bulk endpoints report a PARTIAL failure as an ordinary `200`: segments (or
 * dataset values) the server could not act on are counted, not raised. Before
 * this module the client declared no response type at all, every call site threw
 * the response away, and the coding surfaces reported unqualified success — so a
 * batch that applied nothing still painted every row as coded, with attribution.
 *
 * Two things live here so four coding surfaces cannot answer them four ways:
 *
 *   1. WHICH ids failed — read from the server's explicit `failed_*_ids` list.
 *      Never derive this from `results[].applied`: on a segment REMOVE, `applied`
 *      is `false` for *success*, so a naive reader would treat every successful
 *      bulk-remove as a total failure. The backend comment on `BulkCodeResponse`
 *      carries the same warning.
 *
 *   2. WHAT THE USER IS TOLD. The wording is deliberate — see `describeBulkFailure`.
 */

/** The segment-parent bulk response (`POST /segments/bulk-code`). */
export interface BulkCodeResponse {
  success_count: number
  error_count: number
  /** Ids the server could not act on. Absent on a pre-#678 server → treat as none. */
  failed_segment_ids?: number[]
}

/** The text-coding bulk response (`POST /projects/{id}/text-coding/bulk-code`). */
export interface BulkTextCodeResponse {
  success_count: number
  error_count: number
  failed_dataset_value_ids?: number[]
}

export interface BulkOutcome {
  /** Ids the server did not act on, de-duplicated across every response given. */
  failedIds: number[]
  /** How many targets the server did act on, summed across responses. */
  succeeded: number
  /** True when anything at all was skipped. */
  hasFailures: boolean
}

type AnyBulkResponse = Partial<BulkCodeResponse & BulkTextCodeResponse> | null | undefined

/**
 * Fold one or more bulk responses into a single outcome.
 *
 * Accepts an array because the multi-code paths fan out into N independent
 * `Promise.all` posts (one per code) over the SAME target ids — so the same id
 * can fail in several responses and must be counted once. `succeeded` stays a
 * sum: it counts (target × code) applications, which is what actually landed.
 *
 * Tolerates a response missing the `failed_*` field (an older server, or a
 * caller passing a non-bulk result) by treating it as no failures — the caller
 * then behaves exactly as it did before #678 rather than inventing a warning.
 */
export function collectBulkOutcome(responses: AnyBulkResponse | AnyBulkResponse[]): BulkOutcome {
  const list = Array.isArray(responses) ? responses : [responses]
  const failed = new Set<number>()
  let succeeded = 0
  for (const r of list) {
    if (!r) continue
    for (const id of r.failed_segment_ids ?? []) failed.add(id)
    for (const id of r.failed_dataset_value_ids ?? []) failed.add(id)
    succeeded += r.success_count ?? 0
  }
  const failedIds = [...failed]
  return { failedIds, succeeded, hasFailures: failedIds.length > 0 }
}

/** What the skipped things are called, so the sentence reads naturally per surface. */
export type BulkTargetNoun = 'segment' | 'clip' | 'text'

const PLURAL: Record<BulkTargetNoun, string> = {
  segment: 'segments',
  clip: 'clips',
  text: 'texts',
}

/**
 * The user-facing sentence for a partial failure.
 *
 * Three deliberate choices, all of them about not making the researcher redo
 * work they already did:
 *
 *   · It leads with what DID land. The failure is usually the minority, and a
 *     bare "3 failed" invites re-running the whole batch.
 *   · It names the likely cause ("changed or removed"). The realistic trigger is
 *     another coder — or another tab — having re-segmented underneath you, which
 *     is a normal collaborative event, not a fault.
 *   · It is not phrased as an error. Nothing the coder did was wrong, and the
 *     data that landed is correct; calling it an error would train people to
 *     ignore it.
 */
export function describeBulkFailure(
  outcome: BulkOutcome,
  noun: BulkTargetNoun,
  action: 'apply' | 'remove' = 'apply',
): string {
  const n = outcome.failedIds.length
  const thing = n === 1 ? noun : PLURAL[noun]
  const verb = action === 'apply' ? 'coded' : 'updated'
  const head = `${n} ${thing} could no longer be found — ${n === 1 ? 'it may have' : 'they may have'} been changed or removed by another coder.`
  return outcome.succeeded > 0
    ? `${head} The other ${outcome.succeeded} ${outcome.succeeded === 1 ? 'was' : 'were'} ${verb}.`
    : `${head} Nothing was ${verb}.`
}
