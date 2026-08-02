import api from './client'

// API functions - Coding
export const codingApi = {
  applyCode: (segmentId: number, codeId: number, attribution?: string) =>
    api.post(`/segments/${segmentId}/codes/${codeId}`, { attribution }).then(res => res.data),
  removeCode: (segmentId: number, codeId: number) =>
    api.delete(`/segments/${segmentId}/codes/${codeId}`).then(res => res.data),
  bulkCode: (segmentIds: number[], codeId: number, action: 'apply' | 'remove', attribution?: string) =>
    api.post('/segments/bulk-code', { segment_ids: segmentIds, code_id: codeId, action, attribution }).then(res => res.data),
  // getProgress / getNextUncoded were removed here in Track J · J1 item 3c — all
  // three workbenches compute coverage + jump-to-uncoded client-side (coder-aware,
  // through the blind lens) from the in-memory segment list, which is strictly more
  // correct than the server could be. Backend status since Observations slab 6a:
  // `next-uncoded` is DELETED (#568 — it disagreed with invariant J-A and had no
  // callers), `coding-progress` REMAINS (also caller-less, but J-A-correct; both
  // facts are pinned in test_coding_counts.py so neither drifts unnoticed).
}
