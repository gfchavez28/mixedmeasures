/**
 * #1043 — the schedule sentences. The section hardcoded "4-hourly … keeping the 5
 * most recent"; `MM_AUTO_BACKUP_INTERVAL_HOURS=0` now turns automatic backups off,
 * so a fixed sentence would promise a snapshot that never comes.
 */
import { describe, expect, it } from 'vitest'
import { scheduleSentences } from './backup-history'

describe('scheduleSentences', () => {
  it('states the interval and the count the server reports', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 6, auto_backup_max_count: 3 })
    expect(s.off).toBe(false)
    expect(s.intro).toContain('a separate 6-hourly safety snapshot')
    expect(s.detail).toContain('every 6 hours, keeping the 3 most recent')
  })

  it('reads one hour as "hourly" and "every hour"', () => {
    const s = scheduleSentences({ auto_backup_interval_hours: 1, auto_backup_max_count: 5 })
    expect(s.intro).toContain('a separate hourly safety snapshot')
    expect(s.detail).toContain('every hour, keeping the 5 most recent')
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
      expect(`${s.intro} ${s.detail}`).not.toMatch(/\d/)
    }
  })
})
