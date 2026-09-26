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
import type { BackupInfo } from '@/lib/api'

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
  auto: { label: 'Automatic', description: 'taken on the 4-hourly schedule' },
  shutdown: { label: 'On quit', description: 'taken when Mixed Measures last closed' },
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
 * is replaced by tomorrow's 4-hourly snapshot. "You still have four others" is
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
  return `the ${describeBackup(backup).label.toLowerCase()} backup from ${takenAt}`
}
