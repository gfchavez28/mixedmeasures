import api from './client'

// Material collection types
export interface MaterialCollectionResponse {
  id: number
  project_id: number
  name: string
  display_order: number
  created_at: string
  material_count: number
}

export interface MaterialCollectionListResponse {
  collections: MaterialCollectionResponse[]
}

export interface MaterialMissingRef {
  type: 'column' | 'domain'
  id: number
}

export interface MaterialResponse {
  id: number
  collection_id: number
  material_type: string
  config: Record<string, unknown>
  auto_name: string
  custom_name: string | null
  display_order: number
  source_tab: string
  created_at: string
  /** #296: stale-on-load referential integrity. True when the material's
   * config references columns or domains that have since been deleted.
   * Frontend canvas embed shows a clear "Sources missing" warning when set. */
  has_missing_refs: boolean
  missing_refs: MaterialMissingRef[]
}

export interface MaterialCollectionDetailResponse {
  id: number
  project_id: number
  name: string
  display_order: number
  created_at: string
  materials: MaterialResponse[]
}

// API functions - Materials
export const materialsApi = {
  list: (projectId: number) =>
    api.get<MaterialCollectionListResponse>(`/projects/${projectId}/material-collections`).then(res => res.data),
  get: (projectId: number, collectionId: number) =>
    api.get<MaterialCollectionDetailResponse>(`/projects/${projectId}/material-collections/${collectionId}`).then(res => res.data),
  // Create a material collection. `name` defaults to "Materials" on the backend
  // (MaterialCollectionCreate), matching the default collection auto-created on
  // project create/import — used to lazy-create it for collection-less projects (#469b).
  createCollection: (projectId: number, data?: { name?: string }) =>
    api.post<MaterialCollectionResponse>(`/projects/${projectId}/material-collections`, data ?? {}).then(res => res.data),
  createMaterial: (projectId: number, collectionId: number, data: {
    material_type: string
    config: Record<string, unknown>
    auto_name: string
    custom_name?: string | null
    source_tab?: string
  }) =>
    api.post<MaterialResponse>(`/projects/${projectId}/material-collections/${collectionId}/materials`, data).then(res => res.data),
  updateMaterial: (projectId: number, collectionId: number, materialId: number, data: { custom_name?: string | null }) =>
    api.patch<MaterialResponse>(`/projects/${projectId}/material-collections/${collectionId}/materials/${materialId}`, data).then(res => res.data),
  deleteMaterial: (projectId: number, collectionId: number, materialId: number) =>
    api.delete(`/projects/${projectId}/material-collections/${collectionId}/materials/${materialId}`).then(res => res.data),
  listAllMaterials: (projectId: number) =>
    api.get<MaterialResponse[]>(`/projects/${projectId}/material-collections/all-materials`).then(res => res.data),
  reorder: (projectId: number, collectionId: number, materialIds: number[]) =>
    api.post<{ status: string }>(
      `/projects/${projectId}/material-collections/${collectionId}/materials/reorder`,
      { material_ids: materialIds },
    ).then(res => res.data),
}
