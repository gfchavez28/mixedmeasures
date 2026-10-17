/**
 * #1163 — Restore from a file decides a backup by its name before uploading it,
 * case-insensitively like `isSupportedProjectFile` (the server and Chromium's
 * `accept` both ignore case, so `COPY.MMBACKUP` previews fine).
 */
import { describe, expect, it } from 'vitest'
import { isSupportedBackupFile, isSupportedProjectFile } from './mm-formats'

describe('isSupportedBackupFile', () => {
  it('takes .mmbackup in any case', () => {
    for (const name of ['auto_20261014_121245.mmbackup', 'COPY.MMBACKUP', 'x.MmBackup']) {
      expect(isSupportedBackupFile(name)).toBe(true)
    }
  })

  it('refuses everything else — including a project file and a name merely CONTAINING the word', () => {
    for (const name of ['Northgate.mmproject', 'interview.mp4', 'mmbackup', 'a.mmbackup.zip', 'notes.txt']) {
      expect(isSupportedBackupFile(name)).toBe(false)
    }
  })

  it('and the two MM formats do not overlap', () => {
    expect(isSupportedProjectFile('a.mmbackup')).toBe(false)
    expect(isSupportedBackupFile('a.mmproject')).toBe(false)
  })
})
