/**
 * #1043 — the schedule sentences. The section hardcoded "4-hourly … keeping the 5
 * most recent"; `MM_AUTO_BACKUP_INTERVAL_HOURS=0` now turns automatic backups off,
 * so a fixed sentence would promise a snapshot that never comes.
 */
import { describe, expect, it } from 'vitest'
import {
  BACKUP_TYPE_LABELS,
  backupContentsSentence,
  backupFileRefusal,
  backupFreshness,
  nextBackupPhrase,
  partwayFailureSentence,
  scheduleSentences,
  sourceCountsPhrase,
} from './backup-history'
import { MAX_BACKUP_UPLOAD_BYTES } from './api/backup'

/**
 * #1199 — a null `last_backup_at` no longer means "none": since the server stopped
 * believing an mtime more than an hour past its clock, it is also "every backup is
 * dated ahead". The COUNT decides "No backups yet".
 */
describe('backupFreshness', () => {
  it('a time is the answer whatever the count', () => {
    expect(backupFreshness({ last_backup_at: '2026-10-14T12:00:00+00:00', backup_count: 4 })).toBe('dated')
  })
  it('no time and no backups: none', () => {
    expect(backupFreshness({ last_backup_at: null, backup_count: 0 })).toBe('none')
  })
  it('no time but backups exist: they are all dated ahead of the clock', () => {
    expect(backupFreshness({ last_backup_at: null, backup_count: 1 })).toBe('ahead')
  })
})

describe('scheduleSentences', () => {
  it('states the interval and the count the server reports', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 6, auto_backup_max_count: 3 })
    expect(s.off).toBe(false)
    expect(s.intro).toContain('taken at most every 6 hours while Mixed Measures is open')
    expect(s.detail).toContain('if the last automatic one is more than 6 hours old, and every 6 hours while it stays open')
    expect(s.detail).toContain('keeping the 3 most recent,')
  })

  it('reads one hour as "every hour" and "more than an hour old"', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 1, auto_backup_max_count: 5 })
    expect(s.intro).toContain('taken at most every hour while')
    expect(s.detail).toContain('more than an hour old, and every hour while it stays open')
    expect(`${s.intro} ${s.detail}`).not.toMatch(/1 hours|every 1 /)
  })

  it('says a short session still gets one (#1186) — never a fixed "N-hourly" cadence', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 4, auto_backup_max_count: 5 })
    expect(s.detail).toContain('a few minutes after it opens')
    expect(`${s.intro} ${s.detail}`).not.toMatch(/hourly/)
  })

  it('says OFF for 0, and promises no snapshot', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 0, auto_backup_max_count: 5 })
    expect(s.off).toBe(true)
    expect(s.intro).toContain('turned off')
    expect(`${s.intro} ${s.detail}`).not.toMatch(/hourly|every \d|most recent/)
  })

  it('states no number when the status has not answered — never the default as fact', () => {
    for (const s of [scheduleSentences(undefined), scheduleSentences({ auto_backup_interval_hours: null, auto_backup_max_count: null })]) {
      expect(s.off).toBe(false)
      expect(`${s.intro} ${s.detail} ${s.backupNow}`).not.toMatch(/\d/)
    }
  })
})

describe('scheduleSentences — what Backup now does (#1164 b, true since #1186)', () => {
  it('says it takes a slot in the rotation and moves the next automatic backup', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 4, auto_backup_max_count: 5 })
    expect(s.backupNow).toBe(
      'Use Backup now before a big change to take one straight away. It is kept with the ' +
      'automatic backups, so once there are 5 it replaces the oldest. The next automatic ' +
      'backup then comes 4 hours after it.',
    )
  })

  it('reads one hour as "an hour"', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 1, auto_backup_max_count: 2 })
    expect(s.backupNow).toContain('once there are 2 it replaces the oldest. The next automatic backup then comes an hour after it.')
  })

  it('promises no next automatic backup when they are off — but still says the rotation', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 0, auto_backup_max_count: 5 })
    expect(s.backupNow).toBe('A backup taken with Backup now is listed as “Automatic”, and once there are 5 it replaces the oldest.')
    expect(s.backupNow).not.toMatch(/next automatic/)
  })

  it('states no number before the status answers', () => {
    const s = scheduleSentences(undefined)
    expect(s.backupNow).toContain('once that set is full it replaces the oldest.')
    expect(s.backupNow).not.toMatch(/next automatic/)
  })
})

describe('BACKUP_TYPE_LABELS (#1164 a)', () => {
  it('does not call every on-quit backup the LAST one', () => {
    expect(BACKUP_TYPE_LABELS.shutdown.description).toBe('taken when Mixed Measures closed')
  })
})

describe('nextBackupPhrase (#1186)', () => {
  // Local wall-clock instants: "today" is the viewer's calendar day.
  const now = new Date(2026, 9, 14, 10, 0, 0)
  const time = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)

  it('is a bare time when it is today', () => {
    const at = new Date(2026, 9, 14, 23, 59)
    expect(nextBackupPhrase(at.toISOString(), now)).toBe(`at ${time(at)}`)
  })

  it('carries the DATE when it is another day — tomorrow, or a projection days old', () => {
    for (const at of [new Date(2026, 9, 15, 0, 1), new Date(2026, 9, 11, 14, 30)]) {
      const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
      expect(nextBackupPhrase(at.toISOString(), now)).toBe(`on ${date} at ${time(at)}`)
    }
  })

  it('carries the YEAR only when it is not this one', () => {
    const at = new Date(2027, 0, 2, 9, 0)
    const phrase = nextBackupPhrase(at.toISOString(), now)
    expect(phrase).toContain('2027')
    expect(nextBackupPhrase(new Date(2026, 11, 2, 9, 0).toISOString(), now)).not.toContain('2026')
    // Same month and day, another year, is not "today".
    expect(nextBackupPhrase(new Date(2027, 9, 14, 11, 0).toISOString(), now)).toMatch(/^on /)
  })

  it('is null for a stamp it cannot read, never "Invalid Date"', () => {
    expect(nextBackupPhrase('not a date', now)).toBeNull()
  })
})

describe('sourceCountsPhrase / backupContentsSentence (#1160, #1164 c)', () => {
  const p = (c: number, ds: number, doc: number, obs: number, name = 'P') => ({
    name, conversation_count: c, dataset_count: ds, document_count: doc, observation_count: obs,
  })

  it('full words, plurals, thousands separators; a kind with none is left out', () => {
    expect(sourceCountsPhrase(p(2, 1, 1204, 0))).toBe(
      `2 conversations, 1 dataset, ${(1204).toLocaleString()} documents`,
    )
    expect(sourceCountsPhrase(p(1, 0, 0, 1))).toBe('1 conversation, 1 observation')
  })

  it('says a project holds nothing, rather than going blank', () => {
    expect(sourceCountsPhrase(p(0, 0, 0, 0))).toBe('no conversations, datasets, documents or observations')
  })

  it('sums the projects into one sentence', () => {
    expect(backupContentsSentence([p(2, 1, 4, 0), p(0, 0, 10, 1)])).toBe(
      'This backup holds 2 projects: 2 conversations, 1 dataset, 14 documents, 1 observation.',
    )
    expect(backupContentsSentence([p(0, 0, 0, 0)])).toBe(
      'This backup holds 1 project: no conversations, datasets, documents or observations.',
    )
  })

  it('claims nothing for an empty list (#961: it may be an older backup’s failure)', () => {
    expect(backupContentsSentence([])).toBeNull()
  })
})

describe('partwayFailureSentence (#1140)', () => {
  it('names the way back as Backup history shows it, never by filename', () => {
    expect(partwayFailureSentence('14 Oct 2026, 08:12:45')).toBe(
      'Restore failed partway. Your data as it was before the restore was saved first, as the ' +
      '“Before a restore” backup from 14 Oct 2026, 08:12:45 in Backup history — restore that ' +
      'backup to return to the prior state.',
    )
  })
})

describe('backupFileRefusal (#1163)', () => {
  const f = (name: string, size = 1024) => ({ name, size })

  it('takes a backup, whatever the case of its extension', () => {
    expect(backupFileRefusal(f('auto_20261014.mmbackup'))).toBeNull()
    expect(backupFileRefusal(f('COPY.MMBACKUP'))).toBeNull()
  })

  it('names a project file as one, and says where it goes', () => {
    expect(backupFileRefusal(f('Northgate.mmproject'))).toBe(
      '“Northgate.mmproject” is a project file, not a backup. To bring it in, use Import Project on the Projects page.',
    )
    expect(backupFileRefusal(f('NORTHGATE.MMPROJECT'))).toMatch(/is a project file/)
  })

  it('names any other file, and says what it takes', () => {
    expect(backupFileRefusal(f('interview.mp4'))).toBe(
      '“interview.mp4” is not a backup file. Restore from a file takes a Mixed Measures backup ' +
      '(.mmbackup), the kind Download Backup saves.',
    )
  })

  it('judges TYPE before size — a 600 MB video is the wrong file, not a big one', () => {
    const msg = backupFileRefusal(f('interview.mp4', 600 * 1024 * 1024))
    expect(msg).toMatch(/is not a backup file/)
    expect(msg).not.toMatch(/limit/)
  })

  it('refuses an oversize backup with the limit as the server spells it (#1164 g)', () => {
    const msg = backupFileRefusal(f('big.mmbackup', MAX_BACKUP_UPLOAD_BYTES + 1))
    expect(msg).toMatch(/^“big\.mmbackup” is 500\.0 MB, over the 500 MB limit for a backup from another computer\./)
    expect(backupFileRefusal(f('at.mmbackup', MAX_BACKUP_UPLOAD_BYTES))).toBeNull()
  })
})
