import api from './client'

/**
 * An Observation — a recording coded on its OWN timeline, with no transcript.
 *
 * Naming law: "recording" is the media FILE (a Conversation can attach one; an
 * Observation is built on one). "Observation" is the source type. The UI word for
 * one of its units is "clip"; the model calls it a Segment, which is why the
 * counts below are named for the spine.
 */
export interface Observation {
  id: number
  project_id: number
  name: string
  description: string | null
  created_at: string
  updated_at: string
  /**
   * D18 — unit provenance, and the whole reliability posture turns on it.
   * null = OPEN (each coder marks their own clips => unitizing alpha, no
   * consensus). A timestamp = FROZEN (the team agreed the clips => ordinary
   * kappa + consensus + reconciliation, through the engines that already ship).
   */
  segmentation_frozen_at: string | null
  segment_count: number
  coded_segment_count: number
  code_count: number
  /**
   * Timeline coverage (6a): seconds covered by >=1 non-universal code, with
   * OVERLAP UNIONED, over the D34 denominator. ALL-CODER scope — lists and
   * Overview show every coder's coverage while the blind workbench gauge shows
   * only what is visible to you (#517), so the row labels its scope.
   * `coverage_extent_seconds` is null ONLY when there is nothing to measure
   * against (no readable duration AND no clips) — distinguishing "0% covered"
   * from "no denominator", which would otherwise render NaN%.
   */
  covered_seconds: number
  coverage_extent_seconds: number | null
  media_filename: string | null
  media_format: string | null
  media_type: 'audio' | 'video' | null
  media_duration_seconds: number | null
  media_offset_seconds: number
  media_is_vbr: boolean | null
  has_media: boolean
  media_size_bytes: number | null
  media_version: string | null
}

/**
 * One clip — a time-range Segment on the observation's timeline (slab 3a wire).
 *
 * `applied_code_details` is the modern chip-chokepoint shape (one entry per
 * (code, coder) application — the `lib/coding-progress.ts` chokepoints consume it);
 * `applied_codes` stays a bare `number[]` for optimistic patching (the #441
 * rule). `text` is the label (`''` = unlabelled). `start_time === end_time` is
 * a legal POINT EVENT.
 */
export interface ObservationSegment {
  id: number
  sequence_order: number
  start_time: number
  end_time: number
  text: string
  applied_codes: number[]
  applied_code_details: {
    code_id: number
    user_id: number | null
    attribution: string | null
    is_universal: boolean
  }[]
  attached_notes: { id: number; sequence_number: number }[]
  created_at: string
}

/** How a recording's timeline is first cut into clips. */
export type SegmentationMode = 'none' | 'fixed_interval' | 'cue_list'

export interface ClipPreview {
  sequence_order: number
  start_time: number
  end_time: number
  label: string
}

export interface ClipPreviewResponse {
  /** The TRUE count. `segments` is only a head — a 2,000-clip list is not worth sending. */
  total_segments: number
  segments: ClipPreview[]
  warnings: string[]
}

export interface ClipCutResponse {
  observation: Observation
  created: number
  warnings: string[]
}

export interface SegmentationRequest {
  mode: SegmentationMode
  intervalSeconds?: number | null
  cueFile?: File | null
}

function segmentationForm(req: SegmentationRequest) {
  const form = new FormData()
  form.append('mode', req.mode)
  if (req.intervalSeconds != null) form.append('interval_seconds', String(req.intervalSeconds))
  if (req.cueFile) form.append('cue_file', req.cueFile)
  return form
}

export const observationsApi = {
  list: (projectId: number) =>
    api.get<Observation[]>(`/projects/${projectId}/observations`).then(res => res.data),

  get: (projectId: number, observationId: number) =>
    api.get<Observation>(`/projects/${projectId}/observations/${observationId}`)
      .then(res => res.data),

  create: (projectId: number, data: { name: string; description?: string }) =>
    api.post<Observation>(`/projects/${projectId}/observations`, data).then(res => res.data),

  update: (
    projectId: number,
    observationId: number,
    data: { name?: string; description?: string },
  ) =>
    api.patch<Observation>(`/projects/${projectId}/observations/${observationId}`, data)
      .then(res => res.data),

  remove: (projectId: number, observationId: number) =>
    api.delete(`/projects/${projectId}/observations/${observationId}`).then(res => res.data),

  /**
   * What cutting WOULD produce. Deliberately takes no media: the recording is
   * uploaded once, and both this and `cutSegmentation` read the length the server
   * already persisted — which is what makes the count shown here the count that
   * actually lands.
   */
  previewSegmentation: (projectId: number, observationId: number, req: SegmentationRequest) =>
    api.post<ClipPreviewResponse>(
      `/projects/${projectId}/observations/${observationId}/segmentation/preview`,
      segmentationForm(req),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data),

  cutSegmentation: (projectId: number, observationId: number, req: SegmentationRequest) =>
    api.post<ClipCutResponse>(
      `/projects/${projectId}/observations/${observationId}/segmentation/cut`,
      segmentationForm(req),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data),

  freezeSegmentation: (projectId: number, observationId: number) =>
    api.post<Observation>(
      `/projects/${projectId}/observations/${observationId}/segmentation/freeze`, {},
    ).then(res => res.data),

  unfreezeSegmentation: (projectId: number, observationId: number) =>
    api.post<Observation>(
      `/projects/${projectId}/observations/${observationId}/segmentation/unfreeze`, {},
    ).then(res => res.data),

  // ── Clips (slab 3) ──────────────────────────────────────────────────────
  //
  // Clip-SET mutations 409 when the segmentation is FROZEN (D22); label edits
  // stay legal. The undo inverses: unsplit takes BOTH half ids (the split
  // response returns them — capture in the undo closure), unmerge takes the
  // merged clip's id.

  listSegments: (projectId: number, observationId: number) =>
    api.get<ObservationSegment[]>(
      `/projects/${projectId}/observations/${observationId}/segments`,
    ).then(res => res.data),

  createClip: (
    projectId: number, observationId: number,
    data: { start_time: number; end_time: number; text?: string },
  ) =>
    api.post<ObservationSegment>(
      `/projects/${projectId}/observations/${observationId}/segments`, data,
    ).then(res => res.data),

  updateClip: (
    projectId: number, observationId: number, segmentId: number,
    data: { start_time?: number; end_time?: number; text?: string },
  ) =>
    api.patch<ObservationSegment>(
      `/projects/${projectId}/observations/${observationId}/segments/${segmentId}`, data,
    ).then(res => res.data),

  deleteClip: (projectId: number, observationId: number, segmentId: number) =>
    api.delete(
      `/projects/${projectId}/observations/${observationId}/segments/${segmentId}`,
    ).then(res => res.data),

  splitClip: (projectId: number, observationId: number, segmentId: number, time: number) =>
    api.post<ObservationSegment[]>(
      `/projects/${projectId}/observations/${observationId}/segments/${segmentId}/split`,
      { time },
    ).then(res => res.data),

  mergeClips: (projectId: number, observationId: number, segmentIds: number[]) =>
    api.post<ObservationSegment>(
      `/projects/${projectId}/observations/${observationId}/segments/merge`,
      { segment_ids: segmentIds },
    ).then(res => res.data),

  unmergeClip: (projectId: number, observationId: number, segmentId: number) =>
    api.post<ObservationSegment[]>(
      `/projects/${projectId}/observations/${observationId}/segments/${segmentId}/unmerge`,
      {},
    ).then(res => res.data),

  unsplitClip: (projectId: number, observationId: number, segmentIds: number[]) =>
    api.post<ObservationSegment>(
      `/projects/${projectId}/observations/${observationId}/segments/unsplit`,
      { segment_ids: segmentIds },
    ).then(res => res.data),

  /**
   * Re-use a conversation's recording here, with no second upload (D17).
   *
   * It copies the FILE, never the coding — which is why the affordance says
   * "also code this as an Observation" and never "convert": nothing moves.
   */
  reuseConversationRecording: (
    projectId: number,
    observationId: number,
    conversationId: number,
  ) =>
    api.post<Observation>(
      `/projects/${projectId}/observations/${observationId}/media/from-conversation/${conversationId}`,
      {},
    ).then(res => res.data),
}
