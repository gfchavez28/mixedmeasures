/**
 * #971 — how a backup is described to the researcher.
 *
 * A `.mmbackup` is a snapshot of the whole install: the database, the documents
 * and the recordings. Five of them sit in a list that differ only by when they
 * were taken and why, and restoring one replaces everything — so these are the
 * words that list, its delete confirmation and its accessible names share, and
 * they live beside `lib/safety-copies.ts`, which does the same job for the other
 * list on that screen.
 */
import type { BackupInfo, BackupStatus, ProjectBackupSummary } from '@/lib/api'
import { MAX_BACKUP_UPLOAD_BYTES } from '@/lib/api/backup'
import { formatBytes, plural } from '@/lib/format'
import { isSupportedBackupFile, isSupportedProjectFile, MMBACKUP_FORMAT_LABEL } from '@/lib/mm-formats'
import { fileLimitLabel } from '@/lib/upload-limits'

/**
 * #1043 — the automatic schedule in the words the Backup & Data section uses.
 *
 * The section said "a separate 4-hourly safety snapshot … every 4 hours, keeping the
 * 5 most recent" whatever `MM_AUTO_BACKUP_INTERVAL_HOURS` / `…_MAX_COUNT` held — and
 * `0` hours now turns automatic backups OFF, where those sentences would promise a
 * snapshot that never comes. The server states the install's values; until it
 * answers (or from a server that predates the fields) the sentences carry NO number
 * rather than the default stated as this install's fact (#961's rule).
 *
 * `backupNow` (#1164 b) is what *Backup now* does to that schedule. It was a fixed
 * sentence in the page ("for an extra fresh snapshot"), and since #1186 it has a
 * consequence worth saying: it writes an AUTOMATIC backup, so it takes a slot in
 * the rotation and moves the next one an interval past it.
 */
export function scheduleSentences(
  status: Pick<BackupStatus, 'auto_backup_interval_hours' | 'auto_backup_max_count'> | undefined,
): { off: boolean; intro: string; detail: string; backupNow: string } {
  const hours = status?.auto_backup_interval_hours ?? null
  const keep = status?.auto_backup_max_count ?? null
  const oldest = keep === null
    ? 'once that set is full it replaces the oldest'
    : `once there are ${keep} it replaces the oldest`
  if (hours === 0) {
    return {
      off: true,
      intro:
        'Your edits save to disk instantly. Automatic backups are turned off on this ' +
        'installation, so a backup is taken when you ask for one.',
      detail:
        'Backups are a separate safety net from saving. Automatic snapshots are turned off ' +
        'on this installation, so take one with Backup now, or download one, before a big change.',
      // No schedule to move — but the rotation still applies, and is the surprise.
      backupNow: `A backup taken with Backup now is listed as “Automatic”, and ${oldest}.`,
    }
  }
  // #1186: the schedule is DUE, not periodic — a snapshot a few minutes after the app
  // opens when the last automatic one is an interval old, then every interval while it
  // stays open. "A separate 4-hourly snapshot" read as a promise the app kept for a
  // session of any length, and the loop took none for a session shorter than that.
  const every = hours === 1 ? 'every hour' : `every ${hours} hours`
  const old = hours === 1 ? 'more than an hour old' : `more than ${hours} hours old`
  const keeping = keep === null ? 'keeping the most recent ones' : `keeping the ${keep} most recent`
  return {
    off: false,
    intro:
      hours === null
        ? 'Your edits save to disk instantly; backups are a separate safety snapshot.'
        : `Your edits save to disk instantly; backups are a separate safety snapshot, taken at most ${every} while Mixed Measures is open.`,
    detail:
      'Every edit is saved to disk the moment you make it — your work isn’t waiting in ' +
      'memory anywhere. Backups are a separate safety net: Mixed Measures takes a snapshot of ' +
      'the database, documents, and audio ' +
      (hours === null
        ? 'on a schedule'
        : `a few minutes after it opens if the last automatic one is ${old}, and ${every} while it stays open`) +
      `, ${keeping}, so you can recover from disk corruption or accidental deletion.`,
    backupNow:
      'Use Backup now before a big change to take one straight away. It is kept with the ' +
      `automatic backups, so ${oldest}.` +
      (hours === null
        ? ''
        : ` The next automatic backup then comes ${hours === 1 ? 'an hour' : `${hours} hours`} after it.`),
  }
}

/**
 * #1186 — when the next automatic backup is due, as a phrase: `at 4:30 PM` today,
 * `on Oct 16 at 4:30 PM` any other day (with the year when it is not this one).
 *
 * Settings and TopRail printed a TIME with no date, so a projection from days ago —
 * or one past midnight, or a long interval's — read as a plausible time today. One
 * builder for both, so they cannot disagree about which day it is. `now` is injected
 * for tests; "today" is the viewer's calendar day, like the time itself.
 */
export function nextBackupPhrase(iso: string, now: Date = new Date()): string | null {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return null
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(when)
  const sameYear = when.getFullYear() === now.getFullYear()
  if (sameYear && when.getMonth() === now.getMonth() && when.getDate() === now.getDate()) {
    return `at ${time}`
  }
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(when)
  return `on ${date} at ${time}`
}

/**
 * #1199 — what the freshness line may say about the newest backup.
 *
 * - `dated`: the server believes a backup's time (`last_backup_at`).
 * - `none`: there are no backups — "No backups yet".
 * - `ahead`: there ARE backups, and every one is dated more than an hour later than
 *   this computer's clock, so the server reports no time (a clock set back, or a
 *   folder from a machine whose clock ran ahead). It used to report the future
 *   time, which `formatRelativeTime` printed as "just now" with no stale warning.
 *
 * 🔴 **"No backups yet" keys on `backup_count === 0`, never on `last_backup_at`
 * being null** — since #1199 a null time is ALSO the `ahead` case, where the
 * sentence would be false about backups the researcher can see listed below it.
 * Settings and TopRail's badge both branch through this, so they cannot disagree.
 */
export type BackupFreshness = 'dated' | 'none' | 'ahead'

export function backupFreshness(
  status: Pick<BackupStatus, 'last_backup_at' | 'backup_count'>,
): BackupFreshness {
  if (status.last_backup_at) return 'dated'
  return status.backup_count === 0 ? 'none' : 'ahead'
}

/**
 * #1199 — Settings' sentence for the `ahead` case. Plain about the cause it can
 * see (the dates are later than this computer's clock) and hedged about the one it
 * cannot (whether the clock was set back), and it ends on what to do, as the
 * no-backups sentence does. `next` is `nextBackupPhrase`'s, null when automatic
 * backups are off.
 */
export function backupsAheadSentence(count: number, next: string | null): string {
  const which = count === 1
    ? 'Your only backup is dated later than this computer’s clock, so Mixed Measures cannot tell how recent it is'
    : `All ${count.toLocaleString()} of your backups are dated later than this computer’s clock, so Mixed Measures cannot tell how recent they are`
  const then = next
    ? `The next automatic backup is due ${next}, or use Backup now to take one straight away.`
    : 'Use Backup now to take one straight away.'
  return `${which} — the clock may have been set back. ${then}`
}

type SourceCounts = Pick<
  ProjectBackupSummary, 'conversation_count' | 'dataset_count' | 'document_count' | 'observation_count'
>

const SOURCE_KINDS = [
  ['conversation_count', 'conversation', 'conversations'],
  ['dataset_count', 'dataset', 'datasets'],
  ['document_count', 'document', 'documents'],
  ['observation_count', 'observation', 'observations'],
] as const

/**
 * #1164 (c) — what a project in a backup holds, in words: `2 conversations, 1 dataset,
 * 1,204 documents`. It was `(3 conv, 1 ds, 15 doc, 2 obs)`, abbreviations nobody
 * reads aloud, with no thousands separator (`countLabel` has none either). A kind with
 * none is left out; a project with none of any says so rather than going blank.
 */
export function sourceCountsPhrase(counts: SourceCounts): string {
  const parts = SOURCE_KINDS
    .filter(([key]) => counts[key] > 0)
    .map(([key, one, many]) => `${counts[key].toLocaleString()} ${plural(counts[key], one, many)}`)
  return parts.length > 0 ? parts.join(', ') : 'no conversations, datasets, documents or observations'
}

/**
 * #1160 — the preview's one-line answer to "what is in this backup", summed from the
 * projects its own database listed. Null when the list is empty: an empty list is
 * either "unavailable" (said separately) or an older backup that cannot tell its own
 * failure from an install with no projects, so it claims nothing (#1039 k, #961).
 */
export function backupContentsSentence(summaries: readonly ProjectBackupSummary[]): string | null {
  if (summaries.length === 0) return null
  const total = (key: keyof SourceCounts) => summaries.reduce((n, p) => n + p[key], 0)
  const totals: SourceCounts = {
    conversation_count: total('conversation_count'),
    dataset_count: total('dataset_count'),
    document_count: total('document_count'),
    observation_count: total('observation_count'),
  }
  const n = summaries.length
  return `This backup holds ${n.toLocaleString()} ${plural(n, 'project', 'projects')}: ${sourceCountsPhrase(totals)}.`
}

/**
 * #1140 — a restore that failed AFTER the swap, naming the way back as Backup history
 * shows it. The server's own sentence says "the latest “Before a restore” backup":
 * its time rides a header instead of the sentence, because the filename it used to
 * print is stamped in UTC and disagreed with every row by the zone offset.
 * `takenAt` is `formatTakenAt`'s, as in the restored view's "as the … backup from".
 */
export function partwayFailureSentence(takenAt: string): string {
  return (
    'Restore failed partway. Your data as it was before the restore was saved first, as the ' +
    `${backupTitle({ backup_type: 'pre_restore' }, takenAt)} in Backup history — restore that ` +
    'backup to return to the prior state.'
  )
}

/**
 * #1163 — why Restore from a file will not take this file, or null when it will.
 * Decided at selection, BEFORE anything is uploaded, and TYPE before size: a 600 MB
 * video is the wrong kind of file, and "too large" would send the researcher to
 * shrink it. Not `checkImportFiles`, whose sentences are wrong here ("This page
 * imports …"; "can only import files of 500 MB", false of the in-folder door, which
 * has no limit). A project file gets its own sentence — Export Project and Download
 * Backup are the likeliest mix-up, and the server's answer was "missing database.db".
 */
export function backupFileRefusal(file: { name: string; size: number }): string | null {
  if (isSupportedProjectFile(file.name)) {
    return `“${file.name}” is a project file, not a backup. To bring it in, use Import Project on the Projects page.`
  }
  if (!isSupportedBackupFile(file.name)) {
    return (
      `“${file.name}” is not a backup file. Restore from a file takes ${MMBACKUP_FORMAT_LABEL}, ` +
      'the kind Download Backup saves.'
    )
  }
  // 🔴 Refused here, before the upload starts (#971): the server's cap was met while
  // STREAMING, after the whole transfer. The server still enforces it.
  if (file.size > MAX_BACKUP_UPLOAD_BYTES) {
    return (
      `“${file.name}” is ${formatBytes(file.size)}, over the ${fileLimitLabel(MAX_BACKUP_UPLOAD_BYTES)} ` +
      'limit for a backup from another computer. A backup this copy of Mixed Measures made is ' +
      'under Backup history below, and restoring one of those has no size limit.'
    )
  }
  return null
}

/**
 * What each kind of backup IS, in words a researcher can choose between.
 *
 * 🔴 **These labels became load-bearing when the rows gained a Restore button.**
 * Until then a wrong one was cosmetic. Two could never match: the server derived
 * the type with `split("_", 1)[0]`, so `pre_restore` and `pre_withdrawal` both
 * arrived as `"pre"` — and the map's old `pre_migration` key describes a raw
 * `.db` copy that is not in this list at all. The server half is fixed; this is
 * the reader's.
 *
 * ⚠️ The description carries as much as the name. "Automatic" and "On quit" are
 * both automatic; which to roll back to depends on knowing that one spans the
 * working day and the other is where you left off.
 */
export const BACKUP_TYPE_LABELS: Record<string, { label: string; description: string }> = {
  manual: { label: 'Downloaded', description: 'you downloaded a copy' },
  // #1043: no number — the schedule is the install's (`MM_AUTO_BACKUP_INTERVAL_HOURS`),
  // and Backup & Data states it from the server.
  // #1132: *Backup now* writes this type too (it is the rotation key, ISSUES
  // archive's "REFUTED as a naming bug"), so "on the automatic schedule" alone
  // was false of every backup taken by hand — and of all of them with the
  // schedule turned off.
  auto: { label: 'Automatic', description: 'taken on the automatic schedule or with Backup now' },
  // #1164 (a): not "LAST closed" — every on-quit row said so, and only the newest is.
  shutdown: { label: 'On quit', description: 'taken when Mixed Measures closed' },
  pre_restore: { label: 'Before a restore', description: 'your data as it was before a restore' },
  pre_withdrawal: {
    label: 'Before a withdrawal',
    description: 'your data as it was before a participant was removed',
  },
}

/**
 * A backup's words.
 *
 * ⚠️ A type the server sends that this map does not know is a FUTURE type, not a
 * broken one — "Backup" is true of it, where a raw `pre_withdrawal` on screen is
 * not a sentence. Deliberately NOT a `satisfies Record<…>` over a union: the wire
 * field is a plain string, and the failure mode worth designing for is a newer
 * server, not a typo.
 */
export function describeBackup(backup: Pick<BackupInfo, 'backup_type'>) {
  return BACKUP_TYPE_LABELS[backup.backup_type] ?? { label: 'Backup', description: 'a saved snapshot' }
}

/**
 * Is this the only backup of its kind left?
 *
 * The kinds are not interchangeable: `pre_restore` is the state before a restore
 * and `pre_withdrawal` the state before a person's data was removed, and neither
 * is replaced by tomorrow's automatic snapshot. "You still have four others" is
 * the wrong reassurance when those four are a different kind.
 *
 * ⚠️ **False when the list is not in hand.** An absent list is not evidence that
 * there is exactly one, and a warning shown on that basis is a claim made from an
 * unanswered query (#961). The direction matters: under-warning costs a sentence,
 * over-warning trains the researcher to ignore the one that is true.
 */
export function isLastOfItsKind(
  backup: Pick<BackupInfo, 'backup_type'>,
  backups: BackupInfo[] | undefined,
): boolean {
  if (!backups) return false
  return backups.filter(b => b.backup_type === backup.backup_type).length === 1
}

/** The name every control in a row carries, so two backups are never confused.
 *
 * 🔴 To the SECOND, for the reason `formatTakenAt` records: at minute precision
 * the sixth a11y-name-sweep run measured 159 Delete buttons in the sibling list
 * sharing a name with another. Here the act is a restore, which replaces
 * everything — a column of buttons all announcing "Restore" is both unusable and
 * dangerous.
 */
export function backupRowName(backup: BackupInfo, takenAt: string): string {
  return `the ${backupTitle(backup, takenAt)}`
}

/**
 * #1132 — a backup's name inside a sentence: `“Before a restore” backup from …`.
 *
 * The ONE builder for it: the row controls, the delete confirmation and the
 * restore dialog (Settings' `RestoreSource.name`) each composed their own, and
 * lower-cased or bare it read "Restore from the before a restore backup from …",
 * "the contents of Before a restore backup from …" — three of the five labels
 * are phrases, not adjectives. Quoted, it is the restored view's own wording
 * (*as the “Before a restore” backup from …*).
 */
export function backupTitle(backup: Pick<BackupInfo, 'backup_type'>, takenAt: string): string {
  return `“${describeBackup(backup).label}” backup from ${takenAt}`
}
