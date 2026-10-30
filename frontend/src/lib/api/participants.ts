import api from './client'

// Participant types
export interface LinkedConversationRef {
  id: number
  name: string
}

export interface LinkedSpeakerInfo {
  speaker_id: number
  speaker_name: string
  is_facilitator: boolean
  conversations: LinkedConversationRef[]
  color_index: number
  color: string | null
}

export interface DatasetRowInfo {
  id: number
  dataset_name: string
  dataset_id: number
  row_identifier: string | null
  submitted_at: string | null
  /**
   * #1157 — the server's sentence refusing a change to this link, or null when it is
   * the researcher's to change. Set for a row of the table the tool keeps in step
   * with the participants, where an unlink only made the next refresh delete the row
   * and everything typed into it. REQUIRED, so a surface that offers *Unlink* has to
   * decide what to do with it (#1123's rule for a field that decides a sentence).
   */
  link_refusal: string | null
}

export interface LinkedDocumentInfo {
  id: number
  name: string
  source_format: string
}

export interface Participant {
  id: number
  project_id: number
  identifier: string
  display_name: string | null
  role: string | null
  demographics: string | null
  role_auto_filled_from: string | null
  created_at: string
  updated_at: string
  linked_speakers: LinkedSpeakerInfo[]
  dataset_rows: DatasetRowInfo[]
  /** Row 46 — documents this participant is the SUBJECT of. Unbounded, unlike
   *  `dataset_rows` (one row per participant per dataset): several workplans
   *  about one person is the motivating case. */
  linked_documents: LinkedDocumentInfo[]
}

export interface LinkedDemographicValue {
  column_id: number
  column_text: string
  demographic_subtype: string | null
  value: string | null
  dataset_name: string
  dataset_id: number
  /** #353: column type drives type-aware rendering in the participant detail
   * panel (numerics right-aligned, multi-select as chips, ordinals as labels).
   * Null on legacy responses; frontend falls back to plain-string render. */
  column_type: string | null
}

export interface ParticipantDetail extends Participant {
  linked_demographics: LinkedDemographicValue[]
}

/** #1053 — which value a search matched, when the record's label does not show it. */
export interface LinkableRowMatch {
  column_id: number
  column_label: string
  excerpt: string
}

/** One record in the participant panel's record picker (#418, #1053). */
export interface LinkableRow {
  row_id: number
  row_identifier: string | null
  linked_participant_id: number | null
  linked_participant_name: string | null
  /** #418: up to 3 identifying values for the row label, missing values skipped. */
  display_values: string[]
  matched: LinkableRowMatch | null
}

/**
 * #1053 — ONE page of the records a search matched, best first. `total` counts
 * every match, never the page. `link_refusal` is set for a table the tool keeps
 * (#1157); that page carries no rows.
 */
export interface LinkableRowsPage {
  rows: LinkableRow[]
  total: number
  limit: number
  offset: number
  link_refusal: string | null
}

/** `POST /participants`'s body (`schemas/participant.py::ParticipantCreate`). */
export interface ParticipantCreate {
  identifier: string
  display_name?: string
  role?: string
  demographics?: string
  /** #1190 (D12) — the researcher was told the identifier is a withdrawn person's and
   *  chose to create it anyway. Sent only after that confirmation. */
  confirm_withdrawn?: boolean
}

// API functions - Participants
export const participantsApi = {
  list: (projectId: number) =>
    api.get<{ participants: Participant[]; total: number }>(`/projects/${projectId}/participants`).then(res => res.data),
  get: (projectId: number, participantId: number) =>
    api.get<Participant>(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  getDetail: (projectId: number, participantId: number) =>
    api.get<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  /**
   * #1190 (D12) — an identifier that belongs to someone who WITHDREW from this project is
   * refused with a 409 whose `detail` is `{ error: 'withdrawn_identifier', message }`;
   * `confirm_withdrawn: true` creates it anyway. Callers go through
   * `lib/withdrawn-identifier.ts::createConfirmingWithdrawn`, which asks first.
   */
  create: (projectId: number, data: ParticipantCreate) =>
    api.post<Participant>(`/projects/${projectId}/participants`, data).then(res => res.data),
  /** #1190 (D12) — a rename to a withdrawn person's ID is refused like a create (the same
   *  409 body); `confirm_withdrawn: true` renames anyway, after the same ask. */
  update: (projectId: number, participantId: number, data: { identifier?: string; display_name?: string; role?: string; demographics?: string; confirm_withdrawn?: boolean }) =>
    api.patch<Participant>(`/projects/${projectId}/participants/${participantId}`, data).then(res => res.data),
  delete: (projectId: number, participantId: number) =>
    api.delete(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  /** #702(2): what would have to be removed to honour this person's withdrawal.
   *  Read-only — it changes nothing, and it is what makes the orphaning default
   *  actionable rather than merely documented. */
  withdrawalReport: (projectId: number, participantId: number) =>
    api.get<WithdrawalReport>(
      `/projects/${projectId}/participants/${participantId}/withdrawal-report`
    ).then(res => res.data),
  /** #702(3) — honour a withdrawal: remove the person, keep everyone else's data.
   *  Takes a full backup first and returns its filename.
   *
   *  ⚠️ NO timeout (#1025), for the restore's reason (#1024): giving up does not
   *  stop the server. The backup includes video, and a withdrawal measured 38.7 s
   *  over HTTP (~60 s in a browser) on a 546 MB database, so the client's 30 s
   *  default expired mid-withdrawal — and the page then said "Could not
   *  remove this participant. Nothing was changed." about a person the server went
   *  on to remove. The backend is on loopback: if it dies, the request fails at
   *  once, not never. */
  withdraw: (projectId: number, participantId: number) =>
    api.post<WithdrawalOutcome>(
      `/projects/${projectId}/participants/${participantId}/withdraw`,
      undefined,
      { timeout: 0 },
    ).then(res => res.data),

  linkDatasetRow: (projectId: number, participantId: number, datasetId: number, rowId: number) =>
    api.post<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}/link-dataset-row`,
      { dataset_id: datasetId, row_id: rowId }).then(res => res.data),
  unlinkDatasetRow: (projectId: number, participantId: number, rowId: number) =>
    api.post<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}/unlink-dataset-row`,
      { row_id: rowId }).then(res => res.data),
}


/**
 * What a participant's data touches — #702(2).
 *
 * Counts and locations only, never the text: a report reproducing transcript
 * lines or response values would be one more copy of the data a researcher is
 * trying to remove. `speaker_names` IS included, deliberately — it is
 * identifying, and it is the field that SURVIVES the participant delete.
 */
export interface WithdrawalOutcome {
  participant_id: number
  identifier: string
  speaker_label: string | null
  segments_blanked: number
  excerpts_deleted: number
  dataset_rows_deleted: number
  responses_deleted: number
  row_scores_deleted: number
  code_applications_kept: number
  notes_for_review: number
  memos_for_review: number
  /** Row 46 — documents that said they were about this person. They are KEPT,
   *  only unlinked: "about them" and "theirs" are different claims and only a
   *  person reading the document can tell which applied. */
  documents_unlinked: number
  /** #1320 — turns their words reached by a merge or a split, blanked whole. */
  combined_turns_blanked: number
  /** #1320 — combined speakers ("Maria & Sam") renamed, or deleted when unused. */
  combined_speakers_renamed: number
  /** #1320 — canvas copies of their quotes rewritten (themes and snapshots),
   *  snapshots rewritten, and inbox items removed. */
  canvas_embeds_scrubbed: number
  canvas_snapshots_rewritten: number
  canvas_inbox_items_removed: number
  /** #1320 — stored results of the metrics the withdrawal marked out of date. */
  computed_results_deleted: number
  /** #1320 — audit entries whose details were stripped (the entries are kept). */
  audit_entries_redacted: number
  /** #1473 — notes and codings on their ANSWERS, deleted with the answers (a
   *  turn's are kept; these cannot outlive what they hang off). */
  notes_deleted: number
  code_applications_deleted: number
  backup_filename: string
}

export interface WithdrawalReport {
  participant_id: number
  identifier: string
  display_name: string | null
  role: string | null
  has_demographics: boolean
  speaker_names: string[]
  conversations: {
    conversation_id: number
    name: string
    /** Their own turns (their speaker), hidden ones included. */
    segments: number
    /** #1320 — turns their words reached by a merge or a split: a combined
     *  speaker or none, so no speaker finds them. REQUIRED (#1123's rule): a
     *  sentence that reads the report cannot forget them. Codes, quotes and notes
     *  below count both kinds of turn. */
    combined_turns: number
    code_applications: number
    excerpts: number
    notes: number
  }[]
  datasets: {
    dataset_id: number
    name: string
    rows: number
    responses: number
    code_applications: number
    excerpts: number
    notes: number
    memos: number
    row_scores: number
  }[]
  /** Row 46 — documents this person is the SUBJECT of. 🔴 #1123: the server
   *  computed these from the start and its response schema dropped them, so the
   *  page reported "nothing else is linked" about a document's subject. */
  documents: {
    document_id: number
    name: string
    segments: number
    code_applications: number
    excerpts: number
    notes: number
  }[]
  total_items: number
  /**
   * #1190 (D14) — dataset records linked to NO ONE whose ID column carries this
   * person's identifier. Counted, never named and never deleted: an unlinked record
   * with a matching ID is not proven to be theirs. REQUIRED (#1123's rule), so a
   * sentence that reads the report cannot forget it.
   */
  unlinked_records_with_identifier: number
}
