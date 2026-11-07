import api from './client'
import { downloadBlob, extractFilename, EXPORT_TIMEOUT_MS } from './download'
import type { MagnitudeScale } from '../magnitude'
import type { MachineProvenance } from '@/lib/machine-coder'

// ── Types ──────────────────────────────────────────────────────────────

export interface ProjectSummary {
  conversation_count: number
  dataset_count: number
  document_count: number
  code_count: number
  category_count: number
  memo_count: number
  participant_count: number
  excerpt_count: number
  /**
   * Observations (#639). Always present on the wire — the backend schema
   * declares it with a default, so a pre-observations (v1/v2) archive reads 0
   * rather than dropping the key. Required here for that reason; if it ever
   * reads `undefined`, the backend schema lost its declaration and is silently
   * filtering the field again.
   */
  observation_count: number
  /**
   * Canvases (2026-09-04). Written by every exporter since the canvas shipped
   * and DROPPED at the wire until the test-time `extra='forbid'` detector
   * (#855) found the schema never declared them. Defaulted server-side like
   * `observation_count`, so a pre-canvas archive reads 0.
   */
  canvas_count: number
  canvas_theme_count: number
}

export interface ProjectExportManifest {
  format_version: number
  format_type: string
  app_version: string
  created_at: string
  project_name: string
  project_summary: ProjectSummary
  /** Track J · J3-1: stable identity; null on files exported before J3-1. */
  project_uuid: string | null
}

/** Track J · J3-1: a local project that shares the incoming file's project_uuid. */
export interface ExistingProjectInfo {
  id: number
  name: string
}

/** Track J · J3-2: a local roster coder an incoming coder could map onto. */
export interface MergeCoderMatch {
  id: number
  username: string
  archived: boolean
  local_app_count: number
  /**
   * #1352 — `identity`: the SAME coder (their `users.uuid` — they came from this
   * install, or an earlier merge added them), pre-selected. `name`: a coder who only
   * shares the name, which the confirm step never answers on the researcher's behalf
   * (#1193's rule). REQUIRED, so a fixture must say which.
   */
  basis: 'identity' | 'name'
}

/**
 * #1034 — a local coder an incoming coder MAY be mapped onto: the same kind and,
 * for a machine, the same configuration. The server decides it with the predicate
 * the import enforces, so the confirm screen cannot offer what the merge refuses.
 */
export interface MergeCoderOption {
  id: number
  username: string
  archived: boolean
}

/** #1034 — why a same-name local coder is NOT proposed, and the name used instead. */
export interface MergeCoderNameInUse {
  username: string
  coder_type: string
  /** `kind` (a person vs a machine) · `configuration` (another run of the model). */
  reason: 'kind' | 'configuration'
  new_username: string
}

/** Track J · J3-2: one coder in an incoming merge file + its local match candidate. */
export interface MergeCoderPreview {
  original_id: number
  username: string
  coder_type: string
  archived: boolean
  file_app_count: number
  local_match: MergeCoderMatch | null
  /** #1034 — REQUIRED: a fixture that omits them does not compile. */
  name_in_use: MergeCoderNameInUse | null
  match_options: MergeCoderOption[]
  /** The file machine's configuration — the thing that makes it THIS coder. */
  machine_provenance: MachineProvenance | null
  /** #1246 — the name *Add as new coder* writes unless renamed (a taken name is numbered). */
  create_username: string
}

/** Track J · J3-2b: a local code a divergent file code could collapse onto / link with.
 * `similarity` is NAME character similarity (0–1), NOT coding overlap; `confident` = ≥0.70. */
export interface MergeCodeCandidate {
  code_id: number
  name: string
  description: string | null
  usage: number
  similarity: number
  confident: boolean
  /** #869: the local code's declared rating scale, null when it has none. */
  magnitude_scale: MagnitudeScale | null
}

/** Track J · J3-2b: a code in the file that isn't in your codebook (divergent), with
 * file-side usage + ranked local candidates so the UI can reconcile it. */
export interface MergeCodePreview {
  uuid: string
  name: string
  description: string | null
  color: string | null
  category_name: string | null
  file_app_count: number
  candidates: MergeCodeCandidate[]
  /** #869: the FILE code's declared rating scale, null when it has none. */
  magnitude_scale: MagnitudeScale | null
}

export interface ImportValidationResult {
  manifest: ProjectExportManifest
  warnings: string[]
  /** Track J · J3-1: set when a local copy already exists → offer overwrite vs new vs merge. */
  existing_project: ExistingProjectInfo | null
  /** Track J · J3-2: the file's coders + local match candidates (set only when a merge is possible). */
  merge_coders: MergeCoderPreview[] | null
  /** Track J · J3-2b: divergent codes (uuid not local) + ranked reconcile candidates.
   * `[]` when the codebook is shared-frozen; null when no merge is possible. */
  merge_codes_preview: MergeCodePreview[] | null
  /**
   * #1321: set only when NO local project shares the file's identity — the file's
   * coders and the local coder each would land on if this file is imported keeping its
   * identity (a coding copy names coders silently, by `coder_match_refusal`). Optional
   * so a response from a server that predates it reads as "nothing known".
   */
  file_coders?: MergeCoderPreview[] | null
  /**
   * #1190 (D15) — what a merge would ADD that this project does not hold, set only when a
   * merge is possible. Optional so a server that predates it reads as "nothing known"
   * (the Review step then says nothing, rather than "nothing is added").
   */
  merge_additions?: MergeAdditions | null
}

/**
 * #1190 (D15) — what the file holds that the target does not, by identity.
 *
 * A file-only item is either the colleague's new work or something deleted here since
 * the copy was made, and nothing records a plain delete until 1.5.9, so the preview
 * cannot tell which: it NAMES sources, participants and datasets (each list capped —
 * the `*_count` beside it is the total) and COUNTS the rest, for the researcher to
 * recognise. 🔴 A withdrawn person is never named FROM THE FILE — `withdrawn_participants`
 * and `withdrawn_items` are counts of what the merge will LEAVE OUT. `withdrawn_here`
 * (#1470) is the merge's REFUSAL predicted: people this project still holds whom the copy
 * says withdrew, by this project's own ID; non-empty, the merge will be refused.
 */
export interface MergeAdditions {
  sources: { kind: 'conversation' | 'document' | 'observation'; name: string }[]
  source_count: number
  /** Participant identifiers, as this project shows them. */
  participants: string[]
  participant_count: number
  /** Datasets this project does not have, each with the records it brings. */
  datasets: { name: string; records: number }[]
  dataset_count: number
  /** Records added to datasets this project ALREADY has, per dataset — NOT capped (one
   *  entry per dataset), so the entries sum to `record_count`. */
  records: { dataset: string; count: number }[]
  record_count: number
  quotes: number
  notes: number
  memos: number
  withdrawn_participants: number
  withdrawn_items: number
  withdrawn_here: MergeWithdrawnHereItem[]
}

/**
 * Track J · J3-1/J3-2 import mode. `new` RE-MINTS the identity (an independent project
 * that can never merge with the original); `copy_for_coding` KEEPS it (#1321 — the only
 * way a colleague's copy can come back); `overwrite`/`merge` act on the local copy.
 */
export type ProjectImportMode = 'new' | 'overwrite' | 'merge' | 'copy_for_coding'

/** Track J · J3-2: one coder-mapping decision (keyed by the file coder's original_id). */
export type CoderMappingDecision =
  | { action: 'match'; target_user_id: number; unarchive?: boolean }
  | { action: 'create'; new_username?: string }

export type CoderMapping = Record<string, CoderMappingDecision>

/** Track J · J3-2b: how a divergent code reconciles (keyed by the file code's uuid).
 * `collapse` = re-point its codings onto a local code (no new code); `link` = keep it +
 * group it with a local code (one effective code for stats); `new` = add it standalone. */
export type CodeMappingDecision =
  | { action: 'collapse'; target_code_id: number }
  | { action: 'link'; target_code_id: number; combined_label?: string }
  | { action: 'new' }

export type CodeMapping = Record<string, CodeMappingDecision>

/** Track J · J3-2: what a merge did (returned on import_mode='merge'). */
export interface MergeReport {
  sources_matched: number
  applications_added: number
  duplicates_skipped: number
  coders_created: number
  coders_matched: number
  /** Track J · J3-2b: divergent-code reconciliation outcomes. */
  codes_collapsed: number
  codes_linked: number
  codes_created: number
  /**
   * #35 — matched applications whose copy carried a DIFFERENT rating. The
   * target's rating was kept and the difference flagged for reconciliation.
   * Optional: a report from a server that predates the field simply omits it.
   */
  magnitude_conflicts?: number
  /** #869 (c): NEW applications whose incoming rating fell outside the target
   * code's scale — imported unrated, the number kept as the row's merge conflict. */
  ratings_out_of_range?: number
  /**
   * #1190 — people in the file who withdrew from this project, NOT brought back. A
   * count, never a name. Optional for the `magnitude_conflicts` reason.
   */
  withdrawn_participants_skipped?: number
  /** #1190 — what the file held of theirs (records, speakers, quotes, notes), not brought back. */
  withdrawn_items_skipped?: number
  /**
   * #1190 (D13) — records this project does not have whose participant is now linked to
   * ANOTHER record of the same dataset (one record per participant per dataset), so each
   * was added back WITHOUT a participant link — and the report says so.
   */
  records_reinserted_unlinked?: number
}

/** Track J · J3-2c: structured 409 body when a merge is refused for divergence. */
export interface MergeDivergenceDetail {
  error: 'merge_divergence'
  /**
   * `segmentation_freeze` (#572) is a DIFFERENT refusal from `segmentation`: the
   * clip sets were never compared, because the two sides disagree about whether
   * the segmentation is settled at all. It needs its own copy — "re-segment to
   * match" is the wrong instruction in both of its directions.
   */
  kind: MergeDivergenceKind
  diverged_sources?: {
    name: string
    file_segments?: number
    local_segments?: number
    /** `segmentation_freeze` only: which side had frozen its segmentation. */
    frozen_side?: 'local' | 'file'
    /** `segment_text` (#694) only: how many of the source's segments were edited. */
    changed_segments?: number
    /** `segment_text` only. */
    total_segments?: number
  }[]
  diverged_codes?: string[]
  /**
   * `withdrawal` (#1470) only: people THIS project still holds whom the copy records as
   * withdrawn, named by this project's own ID (never the file's words).
   */
  withdrawn_here?: MergeWithdrawnHereItem[]
}

/** #1470 (D70/D71) — someone this project holds that the merging copy says withdrew. */
export interface MergeWithdrawnHereItem {
  participant_id: number
  identifier: string
}

/**
 * Every refusal the merge gate can raise. Kept as its own exported union because
 * `MergeProject`'s renderer builds an object keyed by it with `satisfies
 * Record<MergeDivergenceKind, …>` — so adding a kind here is a COMPILE ERROR until
 * the screen that explains it exists.
 *
 * ⚠️ Before #694 the renderer was a ternary chain whose final `else` was the codebook
 * branch, and this union was not exhaustively consumed. A new backend kind therefore
 * rendered "codebooks differ" over an empty list: a confident, wrong diagnosis with a
 * remedy that could not work. Do not reintroduce a fall-through default here.
 */
export type MergeDivergenceKind =
  | 'segmentation'
  | 'segmentation_freeze'
  | 'codebook'
  | 'segment_text'
  /** #1470 — the copy withdrew someone this project still holds; withdraw them here first. */
  | 'withdrawal'

export interface ProjectImportResult {
  project_id: number
  project_name: string
  /** Track J · J3-2: populated only for import_mode='merge'. */
  merge_report: MergeReport | null
  /**
   * The recovery snapshot taken before an IN-PLACE import (merge / overwrite), by
   * name. `null` for a plain import or a duplicate, which overwrite nothing and so
   * take no snapshot — do NOT render a recovery line when it is null, or a
   * researcher goes looking for a file that protects them from nothing.
   *
   * The file lives in the app's backup folder. It is NOT a row of the Settings
   * backup history, which lists only restorable `.mmbackup` archives: this is a
   * `.mmproject`, so it comes back through Import, not Restore. Since #919 it is
   * listed separately in Settings › Backup & Data, with a Download — the folder
   * itself is not somewhere a researcher can reach.
   */
  safety_backup_filename: string | null
  /**
   * #958 §6 — how many of the imported project's saved results were declared out of
   * date. An `.mmproject` no longer carries per-record scores, which are DERIVED: the
   * archive holds everything needed to rebuild them, and carrying them let a number
   * computed by some other build arrive reading as this build's current answer.
   *
   * `0` on a merge (which imports no metrics) and on a project that saved none — so
   * gate any message on `> 0`, never on the field's presence.
   */
  metrics_marked_stale: number
  /**
   * #1039 (a) — how many saved statistical tests the import marked out of date: every one
   * it brought in that the file said was current, because a test's result is a number the
   * copy that saved it computed. `0` on a merge and when none were saved — gate on `> 0`.
   */
  tests_marked_stale: number
}

export interface CodebookImportResult {
  categories_created: number
  categories_skipped: number
  codes_created: number
  codes_skipped: number
  codes_uncategorized: number
  /** #869 (d): codes created WITH their declared rating scale. */
  scales_imported: number
  /** #1222: code sets the import created (row 48) — returned since then, declared now. */
  code_sets_created: number
}

// ── API ────────────────────────────────────────────────────────────────

/** Export-dialog include-media default (slab 5 / Q3 decision): media travels
 * by default up to this total; above it the toggle defaults OFF (the archive
 * would balloon) and the user opts in explicitly. */
export const EXPORT_MEDIA_DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024 // 1 GB

export function defaultIncludeMedia(mediaBytes: number | undefined): boolean {
  if (mediaBytes === undefined) return true // storage unknown → historical behavior
  return mediaBytes <= EXPORT_MEDIA_DEFAULT_LIMIT_BYTES
}

export const projectPortabilityApi = {
  /** Export a project as .mmproject (triggers browser download).
   * includeMedia=false produces a media-less archive — transcripts/coding/
   * documents travel, recordings are re-attachable after import (slab 5). */
  exportProject: async (projectId: number, includeMedia: boolean = true) => {
    const res = await api.get(`/projects/${projectId}/export-project`, {
      params: { include_media: includeMedia },
      responseType: 'blob',
      // #847: was a hand-rolled 300_000 (5 min). The project has ONE decided export
      // budget and it is APPLIED here, not re-derived — see download.ts. A whole-project
      // export is exactly the class EXPORT_TIMEOUT_MS was measured for.
      timeout: EXPORT_TIMEOUT_MS,
    })
    const filename = extractFilename(res.headers, `project_export.mmproject`)
    downloadBlob(res.data as Blob, filename)
  },

  /** Duplicate a project server-side (export → re-import as a new copy). #464 */
  duplicateProject: async (projectId: number): Promise<ProjectImportResult> => {
    const res = await api.post<ProjectImportResult>(`/projects/${projectId}/duplicate`, undefined, {
      // Duplicate is export + re-import server-side, so it is bounded by BOTH halves —
      // strictly the most expensive operation here, and it inherited the same 5 minutes.
      timeout: EXPORT_TIMEOUT_MS,
    })
    return res.data
  },

  /** Validate an .mmproject file before import. */
  validateImport: async (file: File): Promise<ImportValidationResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await api.post<ImportValidationResult>('/projects/validate-import', fd, {
      timeout: 120_000,
    })
    return res.data
  },

  /**
   * Import an .mmproject file.
   * Track J · J3-1: `mode: 'overwrite'` + `targetProjectId` replaces an existing local
   * copy in place (preserving its stable identity); the default `'new'` creates a fresh
   * project. Track J · J3-2: `mode: 'merge'` + `targetProjectId` merges a colleague's
   * codings into the matching project, with an optional `coderMapping` (the D8 confirm
   * decisions). A divergent merge rejects with a 409 whose body is `MergeDivergenceDetail`.
   */
  importProject: async (
    file: File,
    opts?: {
      mode?: ProjectImportMode
      targetProjectId?: number
      coderMapping?: CoderMapping
      codeMapping?: CodeMapping
    },
  ): Promise<ProjectImportResult> => {
    const mode = opts?.mode ?? 'new'
    const fd = new FormData()
    fd.append('file', file)
    fd.append('import_mode', mode)
    if ((mode === 'overwrite' || mode === 'merge') && opts?.targetProjectId != null) {
      fd.append('target_project_id', String(opts.targetProjectId))
    }
    // #1321 D2 — a coding copy carries one too: the file person the researcher chose as
    // themselves, matched onto the active coder (the service honours a mapping in every
    // mode). Overwrite and new import send none — their dialog asks nothing (D6).
    if ((mode === 'merge' || mode === 'copy_for_coding') && opts?.coderMapping) {
      fd.append('coder_mapping', JSON.stringify(opts.coderMapping))
    }
    if (mode === 'merge' && opts?.codeMapping) {
      fd.append('code_mapping', JSON.stringify(opts.codeMapping))
    }
    const res = await api.post<ProjectImportResult>('/projects/import-project', fd, {
      // #847: the 5-minute budget was the OTHER half of the old export bound — a project
      // large enough to export took ~26 minutes to read back, so the client gave up while
      // the server carried on and the project appeared anyway. Measured after the batching
      // fix: the full 75,699 x 41 GSS corpus (3,633,552 values) imports in 149 s.
      // The same flat budget as an export, and for the same reason stated in download.ts —
      // the cost is a property of the whole project and the client knows none of it before
      // asking.
      timeout: EXPORT_TIMEOUT_MS,
    })
    return res.data
  },

  /** Export a project's codebook (triggers browser download). */
  exportCodebook: async (projectId: number, format: 'native' | 'qdc' = 'native') => {
    const res = await api.get(`/projects/${projectId}/export-codebook`, {
      params: { format },
      responseType: 'blob',
      timeout: 60_000,
    })
    const ext = format === 'qdc' ? 'qdc' : 'mmcodebook'
    const filename = extractFilename(res.headers, `codebook.${ext}`)
    downloadBlob(res.data as Blob, filename)
  },

  /** Import a codebook file (.mmcodebook or .qdc) into a project. */
  importCodebook: async (projectId: number, file: File): Promise<CodebookImportResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await api.post<CodebookImportResult>(
      `/projects/${projectId}/import-codebook`, fd, {
      timeout: 120_000,
    })
    return res.data
  },
}
