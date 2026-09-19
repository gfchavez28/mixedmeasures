/**
 * #919 — how a safety copy is described to the researcher.
 *
 * A safety copy is a full `.mmproject` of a project, written before a merge or an
 * overwrite changes it in place. Nothing deletes one automatically, so the Settings
 * list is where a researcher decides; these are the words that list, its delete
 * confirmation and its accessible names share, so they cannot describe one copy two
 * ways.
 */
import type { SafetyCopyAct, SafetyCopyInfo } from '@/lib/api'

/** ONE key: the Settings list reads it, and every import that writes a copy
 * (the merge stepper, the overwrite import) invalidates it. */
export const SAFETY_COPIES_QUERY_KEY = ['backup-safety-copies'] as const

/** A fourth act is a compile error until it has words. The vocabulary is the
 * import dialog's ("Merge", "Overwrite my copy"). */
export const SAFETY_COPY_ACT_LABEL = {
  merge: 'Before a merge',
  overwrite: 'Before an overwrite',
  merge_or_overwrite: 'Before a merge or overwrite',
} as const satisfies Record<SafetyCopyAct, string>

/** What the copy is OF. A copy whose manifest cannot be read has no project name,
 * so it is identified by its file — never by an empty string. */
export function safetyCopyTitle(copy: Pick<SafetyCopyInfo, 'project_name' | 'filename'>): string {
  return copy.project_name ?? copy.filename
}

/**
 * When the copy was taken, in the viewer's locale and time zone — TO THE SECOND.
 *
 * 🔴 Seconds are what make a row, and its Delete button's name, unique. At minute
 * precision two copies of one project taken back to back (a merge, then another)
 * read identically on screen AND to a screen reader: the a11y-name-sweep's sixth
 * run measured 159 names shared by 2–5 Delete buttons in a real folder of 1,954,
 * and every one became distinct with seconds. ⚠️ Not handled: two copies of one
 * project in the SAME second (kept apart on disk by a `-2` tail) still read alike.
 */
export function formatTakenAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

export function totalSafetyCopyBytes(copies: readonly Pick<SafetyCopyInfo, 'size_bytes'>[]): number {
  return copies.reduce((sum, c) => sum + c.size_bytes, 0)
}

/**
 * The sentences a delete confirmation must say about THIS copy, beyond "it is
 * permanent". Each is conditional on a fact the server reported, and the order is
 * the order of severity.
 */
export function safetyCopyDeleteWarnings(
  copy: Pick<SafetyCopyInfo, 'project_name' | 'project_in_app' | 'readable'>,
): string[] {
  const warnings: string[] = []
  if (copy.project_in_app === false) {
    // A manifest can carry an identity and no name, so never interpolate a null.
    const subject = copy.project_name ? `“${copy.project_name}”` : 'This project'
    warnings.push(
      `${subject} is no longer in Mixed Measures, so this file may be the only copy of it anywhere.`,
    )
  }
  if (!copy.readable) {
    warnings.push('This file could not be read, so it may be damaged and unusable as a copy.')
  }
  return warnings
}
