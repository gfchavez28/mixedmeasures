import api from './client'

// Statistical Test types
export interface StatisticalTestResponse {
  id: number
  project_id: number
  test_type: string
  config: Record<string, unknown>
  target_type: string
  target_id: number
  target_label: string | null
  result_data: Record<string, unknown> | null
  valid_n: number | null
  stale: boolean
  computed_at: string | null
  origin: string
  origin_context: string | null
  created_at: string
  updated_at: string
}

export interface StatisticalTestListResponse {
  tests: StatisticalTestResponse[]
  total: number
}

export interface ComputeAllTestsResponse {
  computed: number
  errors: Array<{ test_id: number; test_type: string; error: string }>
}

// API functions - Statistical Tests
export const statisticalTestsApi = {
  list: (projectId: number) =>
    api.get<StatisticalTestListResponse>(`/projects/${projectId}/statistical-tests/`).then(res => res.data),
  create: (projectId: number, data: {
    test_type: string
    target_type: string
    target_id: number
    config?: Record<string, unknown>
  }) =>
    api.post<StatisticalTestResponse>(`/projects/${projectId}/statistical-tests/`, data).then(res => res.data),
  delete: (projectId: number, testId: number) =>
    api.delete(`/projects/${projectId}/statistical-tests/${testId}`).then(res => res.data),
  compute: (projectId: number, testId: number) =>
    api.post<StatisticalTestResponse>(`/projects/${projectId}/statistical-tests/${testId}/compute`).then(res => res.data),
  computeAll: (projectId: number, staleOnly = false) =>
    api.post<ComputeAllTestsResponse>(`/projects/${projectId}/statistical-tests/compute-all`, { stale_only: staleOnly }).then(res => res.data),
}
