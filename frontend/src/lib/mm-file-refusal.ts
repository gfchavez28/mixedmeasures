/**
 * #1203 — why *Import Project* or *Import codebook* will not take a picked file,
 * or null when it will. The siblings of `backup-history.ts::backupFileRefusal`
 * (#1163), which does the same for *Restore from a file*.
 *
 * Decided at SELECTION, before anything is uploaded. Before this, both pickers
 * sent whatever was chosen: a `notes.txt` was POSTed whole and toasted "Invalid
 * project file", a 520 MB file was sent whole before the server's 413, and a
 * `.mmbackup` or a CSV handed to the codebook import answered a 500 or "Expecting
 * value: line 1 column 1 (char 0)". The server still enforces all of it.
 *
 * The order is the rule, and each step is pinned:
 *   1. **Cross-kind first** — the other Mixed Measures files are the likeliest
 *      mix-up, and each has a door of its own, so the sentence names it.
 *   2. **Then type** — a 600 MB video is the wrong KIND of file, and "too large"
 *      would send the researcher to shrink it.
 *   3. **Then size**, against the server's own limit (`> limit`, as the server
 *      refuses: a file exactly at the limit is taken).
 *
 * ⚠️ **Not `checkImportFiles`.** Its sentences are a wizard's ("was not added",
 * "This page imports …", "can only import files of 500 MB or smaller") and are
 * false on a project-list button and on the Codebook page — the reason the backup
 * picker got its own (backup-and-restore rules §6). Every UI location named below
 * is the label as it appears: the Settings page's *Backup & Data* section and its
 * *Restore from a file* button, the project list's *Projects* heading and *Import
 * Project* button, the Analysis menu's *Codebook*, the Codebook toolbar's *Import
 * codebook* button, and the in-project Export dialog's *Include recordings &
 * media* checkbox (shown only when a project HAS recordings, which is when it can
 * be large; the project list's own Export Project always includes them).
 */
import { formatBytes } from '@/lib/format'
import {
  isSupportedBackupFile, isSupportedCodebookFile, isSupportedProjectFile,
  MMCODEBOOK_FORMAT_LABEL, MMPROJECT_FORMAT_LABEL,
} from '@/lib/mm-formats'
import { fileLimitLabel, MAX_CODEBOOK_FILE_BYTES, MAX_PROJECT_FILE_BYTES } from '@/lib/upload-limits'

type PickedFile = { name: string; size: number }

/** *Import Project* on the project list. */
export function projectFileRefusal(file: PickedFile): string | null {
  if (isSupportedBackupFile(file.name)) {
    return (
      `“${file.name}” is a backup, not a project file. To bring a backup back, ` +
      'use Restore from a file in Settings › Backup & Data.'
    )
  }
  if (isSupportedCodebookFile(file.name)) {
    return (
      `“${file.name}” is a codebook, not a project. To add its codes to a project, ` +
      'open that project’s Codebook (Analysis › Codebook) and use Import codebook.'
    )
  }
  if (!isSupportedProjectFile(file.name)) {
    return (
      `“${file.name}” is not a Mixed Measures project file. Import Project takes ` +
      `${MMPROJECT_FORMAT_LABEL}, the kind Export Project saves.`
    )
  }
  if (file.size > MAX_PROJECT_FILE_BYTES) {
    return (
      `“${file.name}” is ${formatBytes(file.size)}, over the ${fileLimitLabel(MAX_PROJECT_FILE_BYTES)} ` +
      'limit for a project file. Recordings are usually what makes one this large: export it again ' +
      'from inside the project, under Export, with “Include recordings & media” turned off.'
    )
  }
  return null
}

/** *Import codebook* on the Codebook page. */
export function codebookFileRefusal(file: PickedFile): string | null {
  if (isSupportedProjectFile(file.name)) {
    return (
      `“${file.name}” is a whole project, not a codebook. To bring it in, use Import Project ` +
      'on the Projects page.'
    )
  }
  if (isSupportedBackupFile(file.name)) {
    return (
      `“${file.name}” is a backup, not a codebook. A backup is restored from ` +
      'Settings › Backup & Data.'
    )
  }
  if (!isSupportedCodebookFile(file.name)) {
    return `“${file.name}” is not a codebook file. Import codebook takes ${MMCODEBOOK_FORMAT_LABEL}.`
  }
  if (file.size > MAX_CODEBOOK_FILE_BYTES) {
    return (
      `“${file.name}” is ${formatBytes(file.size)}, over the ` +
      `${fileLimitLabel(MAX_CODEBOOK_FILE_BYTES)} limit for a codebook.`
    )
  }
  return null
}
