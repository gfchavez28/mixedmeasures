import api from './client'
import type { MachineProvenance } from '@/lib/machine-coder'

/**
 * Bulk import of code applications (queue row 49).
 *
 * TWO calls over ONE planner: `preview` shows what the file resolves to, `run`
 * applies it with the researcher's coder mapping. **The file is sent twice, and
 * that is deliberate** — the merge flow does the same (`validate-import` then
 * `import-project`), because holding a staged upload server-side between two
 * requests is state nothing else in this app keeps.
 */

/** Which id space `unit_id` names. DECLARED, never guessed. */
export type CodingImportTarget = 'segments' | 'text_column'

export interface CodingImportProblem {
  /** The spreadsheet line, header counted — the number the researcher will look at. */
  line: number
  /**
   * A grouping key (`lib/coding-import-report.ts::CODING_IMPORT_REASONS` names
   * the ones this build knows); the sentence is `detail`. Typed `string` on the
   * wire because a newer server may send one this build has no words for.
   */
  reason: string
  detail: string
}

export interface CodingImportCoderCandidate {
  name: string
  row_count: number
  /** Of those, how many would be written — `0` means every row was refused. */
  rows_to_apply: number
  local_user_id: number | null
  local_coder_type: string | null
  local_archived: boolean
  local_application_count: number
  local_machine_provenance: MachineProvenance | null
}

export interface CodingImportPreview {
  target_kind: CodingImportTarget
  column_id: number | null
  rows_read: number
  will_apply: number
  /**
   * 🔴 Each HALF of the file's addressing, counted on its own (#1004) — distinct
   * ids in the file and how many name a unit here; distinct code names and how
   * many name a code. Three units of five hundred is a file addressed with the
   * wrong key, and a wrong key no longer reads as "0 codes" too.
   */
  units_in_file: number
  units_matched: number
  codes_in_file: number
  codes_matched: number
  /** Passages coded because they are GROUPED with one the file names (#1031 a). */
  grouped_passages: number
  coders: CodingImportCoderCandidate[]
  problems: CodingImportProblem[]
  reason_counts: Record<string, number>
}

export interface CodingImportDecision {
  action: 'match' | 'create' | 'skip'
  target_user_id?: number | null
  /** `match` onto an ARCHIVED coder: bring them back (#1031 c). */
  unarchive?: boolean
  new_username?: string | null
  coder_type?: 'human' | 'ai'
  machine_provenance?: MachineProvenance | null
}

export interface CodingImportResult {
  rows_read: number
  applied: number
  already_present: number
  selections: number
  replaced: number
  ratings_set: number
  coders_matched: number
  coders_created: number
  coders_unarchived: number
  skipped: number
  /**
   * 🔴 The explicit failed set (#678). A partial failure is this body, never a
   * throw, and the list is never derived from what succeeded.
   */
  problems: CodingImportProblem[]
  /** `{reason: count}` over `problems` — the same summary the preview carries. */
  reason_counts: Record<string, number>
}

interface Scope {
  targetKind: CodingImportTarget
  columnId?: number | null
  /**
   * Which column's VALUES `unit_id` names, when it is not the record identifier.
   * `row_identifier` is always machine-generated (`R0001`), so this is what lets
   * a file keyed on the researcher's own `post_id` address anything at all.
   */
  matchColumnId?: number | null
}

function form(file: File, scope: Scope): FormData {
  const body = new FormData()
  body.append('file', file)
  body.append('target_kind', scope.targetKind)
  if (scope.columnId != null) body.append('column_id', String(scope.columnId))
  if (scope.matchColumnId != null) {
    body.append('match_column_id', String(scope.matchColumnId))
  }
  return body
}

export const codingImportApi = {
  preview: (projectId: number, file: File, scope: Scope) =>
    api.post<CodingImportPreview>(
      `/projects/${projectId}/code-applications/import/preview`, form(file, scope),
    ).then(res => res.data),

  /**
   * ⚠️ **The SAME scope must be sent to both calls.** The preview's numbers are
   * about the units that scope resolves; importing under a different one would
   * apply the researcher's decisions to other units entirely — the shape
   * `source_column_indices` carries on the dataset path (#973 (c)).
   */
  run: (
    projectId: number,
    file: File,
    scope: Scope,
    decisions: Record<string, CodingImportDecision>,
  ) => {
    const body = form(file, scope)
    body.append('coder_mapping', JSON.stringify(decisions))
    return api.post<CodingImportResult>(
      `/projects/${projectId}/code-applications/import`, body,
    ).then(res => res.data)
  },
}
