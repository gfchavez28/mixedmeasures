import api from './client'

// ── Types ─────────────────────────────────────────────────────────────────

export interface CanvasListItem {
  id: number
  name: string
  display_order: number
  theme_count: number
  is_archived: boolean
  updated_at: string
}

export interface CanvasThemeRelationship {
  id: number
  source_theme_id: number
  target_theme_id: number
  relationship_type: string
  label: string | null
  weight: number
  is_bidirectional: boolean
  line_style: string | null
  line_color: string | null
}

export interface CanvasTheme {
  id: number
  name: string
  section_type: 'theme' | 'prose'
  description: string | null
  color: string | null
  doc_order: number
  viz_x: number | null
  viz_y: number | null
  parent_theme_id: number | null
  content: Record<string, unknown> | null
  searchable_text: string | null
  referenced_source_ids: Array<{ type: string; id: number }> | null
  relationships_out: CanvasThemeRelationship[]
  relationships_in: CanvasThemeRelationship[]
}

export interface PendingItem {
  id: number
  canvas_id: number
  item_type: string
  source_id: number
  created_at: string
}

export interface CanvasDetail {
  id: number
  name: string
  display_order: number
  introduction: Record<string, unknown> | null
  created_at: string
  updated_at: string
  themes: CanvasTheme[]
  pending_items: PendingItem[]
}

// ── Request types ─────────────────────────────────────────────────────────

export interface ThemeCreateRequest {
  name: string
  section_type?: 'theme' | 'prose'
  description?: string | null
  color?: string | null
  viz_x?: number | null
  viz_y?: number | null
  after_theme_id?: number | null
  parent_theme_id?: number | null
}

export interface ThemeUpdateRequest {
  name?: string
  section_type?: 'theme' | 'prose'
  description?: string | null
  color?: string | null
  viz_x?: number | null
  viz_y?: number | null
  content?: Record<string, unknown> | null
  parent_theme_id?: number | null
}

// ── API ───────────────────────────────────────────────────────────────────

export interface CanvasSnapshot {
  id: number
  name: string
  theme_count: number
  created_at: string
}

export interface SnapshotTheme {
  id: number
  name: string
  section_type: 'theme' | 'prose'
  description: string | null
  color: string | null
  doc_order: number
  viz_x: number | null
  viz_y: number | null
  content: string | null
  searchable_text: string | null
  referenced_source_ids: string | null
  parent_theme_id: number | null
}

export interface SnapshotRelationship {
  source_theme_id: number
  target_theme_id: number
  relationship_type: string
  label: string | null
  weight: number
  is_bidirectional: boolean
  line_style: string | null
  line_color: string | null
}

export interface SnapshotDetail extends CanvasSnapshot {
  snapshot_data: {
    format_version: number
    themes: SnapshotTheme[]
    relationships: SnapshotRelationship[]
    pending_items: { item_type: string; source_id: number }[]
  }
}

const base = (projectId: number) => `/projects/${projectId}/canvases`

export const canvasApi = {
  // Canvas CRUD
  list: (projectId: number, includeArchived = false) =>
    api.get<CanvasListItem[]>(base(projectId), {
      params: { include_archived: includeArchived },
    }).then(r => r.data),

  get: (projectId: number, canvasId: number) =>
    api.get<CanvasDetail>(`${base(projectId)}/${canvasId}`).then(r => r.data),

  create: (projectId: number, name?: string) =>
    api.post<CanvasDetail>(base(projectId), { name: name ?? 'Untitled canvas' }).then(r => r.data),

  update: (projectId: number, canvasId: number, data: { name?: string; display_order?: number; introduction?: Record<string, unknown> | null; is_archived?: boolean }) =>
    api.patch<CanvasDetail>(`${base(projectId)}/${canvasId}`, data).then(r => r.data),

  delete: (projectId: number, canvasId: number, permanent = false) =>
    api.delete(`${base(projectId)}/${canvasId}`, { params: { permanent } }).then(r => r.data),

  duplicate: (projectId: number, canvasId: number) =>
    api.post<CanvasDetail>(`${base(projectId)}/${canvasId}/duplicate`).then(r => r.data),

  // Theme CRUD
  createTheme: (projectId: number, canvasId: number, data: ThemeCreateRequest) =>
    api.post<CanvasTheme>(`${base(projectId)}/${canvasId}/themes`, data).then(r => r.data),

  updateTheme: (projectId: number, canvasId: number, themeId: number, data: ThemeUpdateRequest) =>
    api.patch<CanvasTheme>(`${base(projectId)}/${canvasId}/themes/${themeId}`, data).then(r => r.data),

  deleteTheme: (projectId: number, canvasId: number, themeId: number) =>
    api.delete(`${base(projectId)}/${canvasId}/themes/${themeId}`).then(r => r.data),

  reorderThemes: (projectId: number, canvasId: number, themeIds: number[]) =>
    api.patch(`${base(projectId)}/${canvasId}/themes/reorder`, { theme_ids: themeIds }).then(r => r.data),

  // Theme relationships
  createRelationship: (projectId: number, canvasId: number, data: { source_theme_id: number; target_theme_id: number; relationship_type: string; label?: string; weight?: number; is_bidirectional?: boolean; line_style?: string | null; line_color?: string | null }) =>
    api.post<CanvasThemeRelationship>(`${base(projectId)}/${canvasId}/theme-relationships`, data).then(r => r.data),

  updateRelationship: (projectId: number, canvasId: number, relId: number, data: { relationship_type?: string; label?: string; weight?: number; is_bidirectional?: boolean; line_style?: string | null; line_color?: string | null }) =>
    api.patch<CanvasThemeRelationship>(`${base(projectId)}/${canvasId}/theme-relationships/${relId}`, data).then(r => r.data),

  deleteRelationship: (projectId: number, canvasId: number, relId: number) =>
    api.delete(`${base(projectId)}/${canvasId}/theme-relationships/${relId}`).then(r => r.data),

  // Pending items
  listPendingItems: (projectId: number, canvasId: number) =>
    api.get<PendingItem[]>(`${base(projectId)}/${canvasId}/pending-items`).then(r => r.data),

  addPendingItem: (projectId: number, canvasId: number, data: { item_type: string; source_id: number }) =>
    api.post<PendingItem>(`${base(projectId)}/${canvasId}/pending-items`, data).then(r => r.data),

  removePendingItem: (projectId: number, canvasId: number, itemId: number) =>
    api.delete(`${base(projectId)}/${canvasId}/pending-items/${itemId}`).then(r => r.data),

  // Theme content refresh
  refreshThemeContent: (projectId: number, canvasId: number, themeId: number) =>
    api.post<{ refreshed: boolean }>(`${base(projectId)}/${canvasId}/themes/${themeId}/refresh-content`).then(r => r.data),

  // Snapshots
  listSnapshots: (projectId: number, canvasId: number) =>
    api.get<CanvasSnapshot[]>(`${base(projectId)}/${canvasId}/snapshots`).then(r => r.data),

  createSnapshot: (projectId: number, canvasId: number, name: string) =>
    api.post<CanvasSnapshot>(`${base(projectId)}/${canvasId}/snapshots`, { name }).then(r => r.data),

  restoreSnapshot: (projectId: number, canvasId: number, snapshotId: number) =>
    api.post<CanvasDetail>(`${base(projectId)}/${canvasId}/snapshots/${snapshotId}/restore`).then(r => r.data),

  getSnapshot: (projectId: number, canvasId: number, snapshotId: number) =>
    api.get<SnapshotDetail>(`${base(projectId)}/${canvasId}/snapshots/${snapshotId}`).then(r => r.data),

  deleteSnapshot: (projectId: number, canvasId: number, snapshotId: number) =>
    api.delete(`${base(projectId)}/${canvasId}/snapshots/${snapshotId}`).then(r => r.data),

  // Export. Optionally POSTs rasterized chart images (materialId → PNG data URL)
  // so charts embed as images; the backend falls back to data tables otherwise.
  exportDocx: async (projectId: number, canvasId: number, chartPngs?: Map<number, string>, filename = 'canvas') => {
    const chart_images: Record<string, string> = {}
    if (chartPngs) {
      for (const [mid, dataUrl] of chartPngs) {
        const comma = dataUrl.indexOf(',')
        chart_images[String(mid)] = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
      }
    }
    const { data } = await api.post<Blob>(
      `${base(projectId)}/${canvasId}/export-docx`,
      { chart_images },
      { responseType: 'blob' },
    )
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80)}.docx`
    a.click()
    URL.revokeObjectURL(url)
  },

  // Canvas images. Through the shared client — NOT raw fetch — so the X-CSRF-Token
  // header attaches (a raw fetch here 403'd every image upload; an internal audit).
  uploadImage: async (projectId: number, file: File): Promise<{ image_id: string }> => {
    const form = new FormData()
    form.append('file', file)
    const res = await api.post<{ image_id: string }>(`/projects/${projectId}/canvas-images`, form)
    return res.data
  },
}
