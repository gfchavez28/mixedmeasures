import api from './client'
import type { BulkCodeResponse } from '../bulk-code-result'

// API functions - Coding
export const codingApi = {
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
    api.post(
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
