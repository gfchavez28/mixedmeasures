import api from './client'
import { mediaUploadTimeoutMs } from '../media-constants'

export interface MediaUploadResponse {
  media_filename: string
  media_format: string
  media_type: string
  media_duration_seconds: number | null
  media_offset_seconds: number
  media_is_vbr: boolean | null
}

/**
 * WHICH source owns a recording. Mirrors the backend's `owner_kind` — media.py
 * shares one hardened implementation across both mounts rather than forking it,
 * and this is that seam's client half.
 *
 * It is an explicit argument, not an inferred one, on purpose: conversation ids
 * and observation ids are both bare `number`s drawn from independent sequences,
 * so a mis-wired call would otherwise hit a VALID but WRONG source. (This is the
 * same collision the on-disk layout prefixes `obs-` to prevent.) Naming the kind
 * at every call site makes that class of mistake a type error.
 */
export type MediaOwnerKind = 'conversation' | 'observation'

const OWNER_PATH: Record<MediaOwnerKind, string> = {
  conversation: 'conversations',
  observation: 'observations',
}

function mediaBase(projectId: number, kind: MediaOwnerKind, ownerId: number) {
  return `/projects/${projectId}/${OWNER_PATH[kind]}/${ownerId}/media`
}

export const mediaApi = {
  /**
   * Attach a recording.
   *
   * `durationSeconds` is the browser's own measurement (from the media element's
   * `loadedmetadata`). The server prefers its own probe and only falls back to
   * this — but for WebM it has no reader at all, so without the hint an
   * observation built on a .webm would have a NULL-length timeline: no ruler and
   * no interval cutting. Pass it whenever you have it.
   */
  upload: (
    projectId: number,
    kind: MediaOwnerKind,
    ownerId: number,
    file: File,
    durationSeconds?: number | null,
  ) => {
    const formData = new FormData()
    formData.append('file', file)
    if (durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds > 0) {
      formData.append('duration_seconds', String(durationSeconds))
    }
    return api.post<MediaUploadResponse>(
      mediaBase(projectId, kind, ownerId),
      formData,
      // Size-scaled timeout — the client's default 30s abort would kill any
      // multi-GB upload, while a flat disable would let a stalled connection
      // hang forever. Gives a large file hours, a small stalled one ~2min.
      // The backend streams to a bounded-memory temp file and caps size.
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: mediaUploadTimeoutMs(file.size) }
    ).then(res => res.data)
  },

  /**
   * Stream URL for the mounted media element. `version` is the owner's
   * media_version cache token (#549): including it means a replaced recording
   * gets a DIFFERENT URL, so the element reloads (src change triggers the
   * media load algorithm) and the browser cache can never serve stale bytes —
   * even for a same-name re-export. Pass owner.media_version.
   */
  getStreamUrl: (
    projectId: number,
    kind: MediaOwnerKind,
    ownerId: number,
    version?: string | null,
  ) =>
    `/api${mediaBase(projectId, kind, ownerId)}/stream` +
    (version ? `?v=${encodeURIComponent(version)}` : ''),

  remove: (projectId: number, kind: MediaOwnerKind, ownerId: number) =>
    api.delete(mediaBase(projectId, kind, ownerId)).then(res => res.data),

  /**
   * Conversation-only: the offset aligns a TRANSCRIPT to its recording. An
   * observation's recording IS its timeline, so there is no offset to set and no
   * endpoint to call — the signature stays narrow rather than accepting a kind it
   * would have to reject.
   */
  updateOffset: (projectId: number, conversationId: number, offsetSeconds: number) =>
    api.patch(
      `/projects/${projectId}/conversations/${conversationId}/media/offset`,
      { offset_seconds: offsetSeconds }
    ).then(res => res.data),
}
