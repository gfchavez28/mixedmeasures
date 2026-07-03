import api from './client'

// API functions - Coding
export const codingApi = {
  applyCode: (segmentId: number, codeId: number, attribution?: string) =>
    api.post(`/segments/${segmentId}/codes/${codeId}`, { attribution }).then(res => res.data),
  removeCode: (segmentId: number, codeId: number) =>
    api.delete(`/segments/${segmentId}/codes/${codeId}`).then(res => res.data),
  bulkCode: (segmentIds: number[], codeId: number, action: 'apply' | 'remove', attribution?: string) =>
    api.post('/segments/bulk-code', { segment_ids: segmentIds, code_id: codeId, action, attribution }).then(res => res.data),
  // getProgress / getNextUncoded were removed in Track J · J1 item 3c — the
  // conversation workbench now computes coverage + jump-to-uncoded client-side
  // (coder-aware) from the in-memory segment list. The backend endpoints remain.
}
