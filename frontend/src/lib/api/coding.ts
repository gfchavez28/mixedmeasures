import api from './client'

// API functions - Coding
export const codingApi = {
  applyCode: (segmentId: number, codeId: number, attribution?: string) =>
    api.post(`/segments/${segmentId}/codes/${codeId}`, { attribution }).then(res => res.data),
  removeCode: (segmentId: number, codeId: number) =>
    api.delete(`/segments/${segmentId}/codes/${codeId}`).then(res => res.data),
  bulkCode: (segmentIds: number[], codeId: number, action: 'apply' | 'remove', attribution?: string) =>
    api.post('/segments/bulk-code', { segment_ids: segmentIds, code_id: codeId, action, attribution }).then(res => res.data),
  getProgress: (conversationId: number) =>
    api.get(`/conversations/${conversationId}/coding-progress`).then(res => res.data),
  getNextUncoded: (conversationId: number, currentSegmentId?: number) =>
    api.get(`/conversations/${conversationId}/next-uncoded`, {
      params: { current_segment_id: currentSegmentId || 0 },
    }).then(res => res.data),
}
