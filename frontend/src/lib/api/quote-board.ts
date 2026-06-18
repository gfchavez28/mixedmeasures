import api from './client'

// Quote Board types
export interface QuoteBoardConfig {
  custom_orders: Record<string, number[]>
}

// API functions - Quote Board Config
export const quoteBoardApi = {
  getConfig: (pid: number) =>
    api.get<QuoteBoardConfig>(`/projects/${pid}/quote-board/config`).then(r => r.data),
  updateConfig: (pid: number, data: Partial<QuoteBoardConfig>) =>
    api.patch<QuoteBoardConfig>(`/projects/${pid}/quote-board/config`, data).then(r => r.data),
}
