import api from './client'
import type { BulkCodeResponse } from '../bulk-code-result'
import type { MagnitudeScale } from '../magnitude'

/**
 * One outstanding rating act on the sweep surface (#35 variant B).
 *
 * ⚠️ `scale` is REQUIRED, not nullable. An entry only reaches the queue
 * because its code declares an instrument, so a client branch for "no scale"
 * would be dead code guarding a state the server cannot emit.
 */
export interface RatingQueueEntry {
  code_id: number
  code_name: string
  code_color: string | null
  scale: MagnitudeScale
  /** Which endpoint commits it. Route through `lib/rating-commit.ts`. */
  target_kind: 'segment' | 'dataset_value'
  segment_id: number | null
  dataset_value_id: number | null
  source_type: 'conversation' | 'document' | 'observation' | 'column'
  source_id: number
  source_label: string
  text: string
  start_time: number | null
  end_time: number | null
  record_identifier: string | null
  /** Segments this ONE rating covers — >1 only for a coded segment group. */
  n_targets: number
}

/** One code's outstanding rating count, NAMED by the server. */
export interface RatingQueueCodeCount {
  code_id: number
  code_name: string
  outstanding: number
}

export interface RatingQueueResponse {
  entries: RatingQueueEntry[]
  total: number
  truncated: boolean
  /**
   * Per-code coverage, most-outstanding first.
   *
   * ⚠️ **Each row carries its own NAME — do not look one up in `entries`.**
   * These counts span the whole queue while `entries` is a single batch, so a
   * code with nothing in the current window has no entry to be named from, and
   * a client deriving names that way shows a bare id exactly when the queue is
   * long enough for the filter to be worth having.
   */
  per_code: RatingQueueCodeCount[]
}

/**
 * What a single apply answers. ⚠️ `replaced_code_ids` (#1028) is the codes the
 * server REMOVED because the applied code is a value of a code set and this
 * coder held another value of it here — across the whole segment group. An
 * undo re-applies exactly these (`lib/apply-undo.ts`).
 */
export interface CodeApplyResult {
  segment_id: number | null
  code_id: number
  applied: boolean
  magnitude: number | null
  replaced_code_ids?: number[]
  /**
   * #1070 — the same report PER SEGMENT. A single apply fans out to a segment
   * group whose siblings can lose different values; the merged list above cannot
   * say which, and an undo that put the union back everywhere gave a sibling a
   * value it never had.
   */
  replaced_by_target?: { segment_id: number; replaced_code_ids: number[] }[]
}

// API functions - Coding
export const codingApi = {
  /**
   * #35 variant B — this coder's applications that declare a scale and carry
   * no rating.
   *
   * ⚠️ **There is no offset, deliberately.** Entries LEAVE the queue as they
   * are rated, so paging into it by index skips work. Refetch to advance;
   * `total` is what a progress indicator reads.
   */
  getRatingQueue: (projectId: number, params?: { codeId?: number; limit?: number }) =>
    api.get<RatingQueueResponse>(`/projects/${projectId}/rating-queue`, {
      params: { code_id: params?.codeId, limit: params?.limit },
    }).then(res => res.data),
  /**
   * Apply a code; optionally with a rating (#35).
   *
   * ⚠️ `magnitude` is sent ONLY when the caller passes it — `undefined` omits
   * the key, and the server reads presence through `model_fields_set`: absent
   * means "leave any existing rating alone", an explicit `null` means UNRATE.
   * #868 (f): undoing a REMOVAL re-applies through this argument with the
   * rating captured when the entry was built, so Ctrl+Z no longer unrates.
   */
  applyCode: (segmentId: number, codeId: number, attribution?: string, magnitude?: number | null) =>
    api.post<CodeApplyResult>(
      `/segments/${segmentId}/codes/${codeId}`,
      magnitude === undefined ? { attribution } : { attribution, magnitude },
    ).then(res => res.data),
  /**
   * #35 — set or clear THIS coder's rating on an already-applied code.
   *
   * ⚠️ `null` is an explicit UNRATE and must be sent as `null`, never omitted:
   * the server distinguishes "field absent" (leave alone) from "field null"
   * (clear), so dropping the key turns an Esc-skip into a no-op.
   *
   * ⚠️ Deliberately NOT folded into `applyCode`. That endpoint returns early when
   * the application already exists, so it cannot edit one — and editing a rating
   * afterwards is the only way to correct a mis-keyed value.
   */
  setMagnitude: (segmentId: number, codeId: number, magnitude: number | null) =>
    api.patch(`/segments/${segmentId}/codes/${codeId}/magnitude`, { magnitude }).then(res => res.data),
  removeCode: (segmentId: number, codeId: number) =>
    api.delete(`/segments/${segmentId}/codes/${codeId}`).then(res => res.data),
  // #678: typed, because a partial failure arrives as a 200 body — not a throw.
  // Callers MUST route the result through lib/bulk-code-result.ts rather than
  // discarding it; the response was untyped and dropped at all ten call sites,
  // which is how a batch that applied nothing still rendered as coded.
  bulkCode: (segmentIds: number[], codeId: number, action: 'apply' | 'remove', attribution?: string): Promise<BulkCodeResponse> =>
    api.post<BulkCodeResponse>('/segments/bulk-code', { segment_ids: segmentIds, code_id: codeId, action, attribution }).then(res => res.data),
  // getProgress / getNextUncoded were removed here in Track J · J1 item 3c — all
  // three workbenches compute coverage + jump-to-uncoded client-side (coder-aware,
  // through the blind lens) from the in-memory segment list, which is strictly more
  // correct than the server could be. Backend status since Observations slab 6a:
  // `next-uncoded` is DELETED (#568 — it disagreed with invariant J-A and had no
  // callers), `coding-progress` REMAINS (also caller-less, but J-A-correct; both
  // facts are pinned in test_coding_counts.py so neither drifts unnoticed).
}
