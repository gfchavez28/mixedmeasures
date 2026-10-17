/**
 * #1203 — *Import Project* and *Import codebook* refuse a wrong file at selection,
 * in their own words: cross-kind first, then type, then size (`mm-file-refusal.ts`).
 * Each ordering and boundary below is pinned by a case that fails if it moves.
 */
import { describe, expect, it } from 'vitest'
import { codebookFileRefusal, projectFileRefusal } from './mm-file-refusal'
import { isSupportedCodebookFile, MMCODEBOOK_ACCEPT } from './mm-formats'
import { MAX_CODEBOOK_FILE_BYTES, MAX_PROJECT_FILE_BYTES } from './upload-limits'

const MiB = 1024 * 1024
const file = (name: string, size = 10) => ({ name, size })

describe('projectFileRefusal — Import Project', () => {
  it('takes a project file, in any case (kills a dropped toLowerCase)', () => {
    expect(projectFileRefusal(file('Northgate.mmproject'))).toBeNull()
    expect(projectFileRefusal(file('COPY.MMPROJECT'))).toBeNull()
  })

  it('names a BACKUP as one and points at Restore from a file', () => {
    expect(projectFileRefusal(file('auto_20261014_121245.mmbackup'))).toBe(
      '“auto_20261014_121245.mmbackup” is a backup, not a project file. To bring a backup back, '
      + 'use Restore from a file in Settings › Backup & Data.',
    )
  })

  it('names a CODEBOOK as one, either kind, and points at the Codebook page', () => {
    const sentence = '“codes.mmcodebook” is a codebook, not a project. To add its codes to a project, '
      + 'open that project’s Codebook (Analysis › Codebook) and use Import codebook.'
    expect(projectFileRefusal(file('codes.mmcodebook'))).toBe(sentence)
    expect(projectFileRefusal(file('Taguette.QDC'))).toMatch(/^“Taguette\.QDC” is a codebook, not a project\./)
  })

  it('names any other file as not a project file, and says what Import Project takes', () => {
    expect(projectFileRefusal(file('notes.txt'))).toBe(
      '“notes.txt” is not a Mixed Measures project file. Import Project takes a Mixed Measures '
      + 'project file (.mmproject), the kind Export Project saves.',
    )
    // The server reads the zip either way, but the picker decides by name — as Merge does.
    expect(projectFileRefusal(file('x.mmproject.zip'))).toMatch(/is not a Mixed Measures project file/)
  })

  it('judges TYPE before size — a 600 MB video is the wrong file, not a big one', () => {
    const r = projectFileRefusal(file('interview.mp4', 600 * MiB))
    expect(r).toMatch(/is not a Mixed Measures project file/)
    expect(r).not.toMatch(/500 MB/)
  })

  it('judges CROSS-KIND before size — a 600 MB backup is a backup', () => {
    expect(projectFileRefusal(file('big.mmbackup', 600 * MiB))).toMatch(/is a backup, not a project file/)
  })

  it('takes a file exactly AT the 500 MB limit and refuses one a byte over (the server’s `>`)', () => {
    expect(projectFileRefusal(file('at.mmproject', MAX_PROJECT_FILE_BYTES))).toBeNull()
    expect(projectFileRefusal(file('over.mmproject', MAX_PROJECT_FILE_BYTES + 1))).toBe(
      '“over.mmproject” is 500.0 MB, over the 500 MB limit for a project file. Recordings are usually '
      + 'what makes one this large: export it again from inside the project, under Export, with '
      + '“Include recordings & media” turned off.',
    )
  })
})

describe('codebookFileRefusal — Import codebook', () => {
  it('takes both codebook kinds, in any case', () => {
    for (const name of ['codes.mmcodebook', 'x.QDC', 'Codes.MmCodebook', 'refi.qdc']) {
      expect(codebookFileRefusal(file(name)), name).toBeNull()
    }
  })

  it('names a whole PROJECT as one and points at Import Project', () => {
    expect(codebookFileRefusal(file('Northgate.mmproject'))).toBe(
      '“Northgate.mmproject” is a whole project, not a codebook. To bring it in, use Import Project '
      + 'on the Projects page.',
    )
  })

  it('names a BACKUP as one and points at Settings', () => {
    expect(codebookFileRefusal(file('auto_x.MMBACKUP'))).toBe(
      '“auto_x.MMBACKUP” is a backup, not a codebook. A backup is restored from Settings › Backup & Data.',
    )
  })

  it('names any other file — a CSV, which answered "Expecting value" — and says the two kinds', () => {
    expect(codebookFileRefusal(file('survey.csv'))).toBe(
      '“survey.csv” is not a codebook file. Import codebook takes a Mixed Measures codebook '
      + '(.mmcodebook) or a REFI-QDA codebook (.qdc).',
    )
  })

  it('judges type before size', () => {
    const r = codebookFileRefusal(file('film.mp4', 20 * MiB))
    expect(r).toMatch(/is not a codebook file/)
    expect(r).not.toMatch(/10 MB/)
  })

  it('takes a codebook exactly AT 10 MB and refuses one a byte over, spelling the limit "10 MB"', () => {
    expect(codebookFileRefusal(file('at.qdc', MAX_CODEBOOK_FILE_BYTES))).toBeNull()
    expect(codebookFileRefusal(file('over.qdc', MAX_CODEBOOK_FILE_BYTES + 1))).toBe(
      '“over.qdc” is 10.0 MB, over the 10 MB limit for a codebook.',
    )
  })
})

describe('the codebook gate', () => {
  it('is 10 MiB, the server’s cap', () => {
    expect(MAX_CODEBOOK_FILE_BYTES).toBe(10 * MiB)
  })

  it('accept attribute and predicate agree (as every format family must, #552)', () => {
    for (const ext of MMCODEBOOK_ACCEPT.split(',')) {
      expect(isSupportedCodebookFile(`file${ext}`), ext).toBe(true)
      expect(isSupportedCodebookFile(`FILE${ext.toUpperCase()}`), ext).toBe(true)
    }
    expect(isSupportedCodebookFile('codes.qdc.bak')).toBe(false)
  })
})
