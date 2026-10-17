/**
 * #1164 (g) — a LIMIT is stated through `fileLimitLabel`, never `formatBytes`.
 *
 * `formatBytes` describes a file ("143.2 MB"); a limit is a round number the server
 * also says, and `formatBytes(MAX_BACKUP_UPLOAD_BYTES)` printed "500.0 MB" in the
 * Backup & Data note and in the size refusal while the server's 413 said "500 MB".
 * Those were the only two `formatBytes(MAX_…)` sites; this keeps them the only two
 * there ever were. #1161 made the same move for the recording limit ("4096 MB").
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { stripComments } from './strip-comments'
import { sourceFiles, srcRel } from '@/test-support/source-tree'

const LIMIT_AS_A_FILE_SIZE = /\bformatBytes\(\s*MAX_[A-Z0-9_]*/

const files = sourceFiles({
  ext: 'both',
  floor: 300,
  sentinels: ['pages/SettingsPage.tsx', 'lib/upload-limits.ts'],
})
const callers: string[] = []
const offenders: string[] = []
const statesTheBackupLimit: string[] = []
for (const abs of files) {
  const raw = readFileSync(abs, 'utf-8')
  if (!raw.includes('formatBytes(') && !raw.includes('fileLimitLabel(')) continue
  const src = stripComments(raw)
  if (src.includes('formatBytes(')) callers.push(srcRel(abs))
  if (/fileLimitLabel\(\s*MAX_BACKUP_UPLOAD_BYTES\s*\)/.test(src)) statesTheBackupLimit.push(srcRel(abs))
  for (const line of src.split('\n')) {
    if (LIMIT_AS_A_FILE_SIZE.test(line)) offenders.push(`${srcRel(abs)}: ${line.trim()}`)
  }
}

describe('every stated limit goes through fileLimitLabel (#1164 g)', () => {
  it('sees the formatBytes callers (self-check: the scan can see its population)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(10)
    expect(callers).toEqual(expect.arrayContaining(['pages/SettingsPage.tsx', 'lib/upload-limits.ts']))
    // …and the two sites #1164 (g) moved now state the backup limit the other way.
    expect(statesTheBackupLimit).toEqual(expect.arrayContaining(['lib/backup-history.ts', 'pages/SettingsPage.tsx']))
  })

  it('no source formats a MAX_ limit as a file size', () => {
    expect(offenders).toEqual([])
  })

  it('the predicate fires on the shape it looks for (falsifier)', () => {
    expect(LIMIT_AS_A_FILE_SIZE.test('up to {formatBytes(MAX_BACKUP_UPLOAD_BYTES)}.')).toBe(true)
    expect(LIMIT_AS_A_FILE_SIZE.test('`${formatBytes( MAX_MEDIA_SIZE)}`')).toBe(true)
    expect(LIMIT_AS_A_FILE_SIZE.test('up to {fileLimitLabel(MAX_BACKUP_UPLOAD_BYTES)}.')).toBe(false)
    expect(LIMIT_AS_A_FILE_SIZE.test('is ${formatBytes(file.size)}, over')).toBe(false)
  })
})
