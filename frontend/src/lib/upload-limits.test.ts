/**
 * #1007 — the per-file import limit, refused at selection.
 *
 * The backend half of the mirror is `backend/tests/test_upload_limit_mirror.py`,
 * which reads this module's constant and compares it to `MAX_UPLOAD_SIZE`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILE_LABEL, MAX_PROJECT_FILE_BYTES,
  checkImportFiles, oversizeFilesMessage, partitionBySizeLimit,
} from './upload-limits'
import { MAX_DATASET_UPLOAD_SIZE } from './dataset-import-formats'
import { stripComments } from './strip-comments'

const file = (name: string, size: number) => ({ name, size })

describe('the limit', () => {
  it('is 50 MB, and the label is derived from it', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(MAX_IMPORT_FILE_LABEL).toBe('50 MB')
  })

  it('is the same number the dataset upload timeout is sized from', () => {
    expect(MAX_DATASET_UPLOAD_SIZE).toBe(MAX_IMPORT_FILE_BYTES)
  })
})

describe('partitionBySizeLimit', () => {
  it('keeps a file AT the limit and refuses one a byte over', () => {
    // The server refuses `len > max`, so exactly-at is accepted on both sides.
    const at = file('at.csv', MAX_IMPORT_FILE_BYTES)
    const over = file('over.csv', MAX_IMPORT_FILE_BYTES + 1)
    expect(partitionBySizeLimit([at, over])).toEqual({ accepted: [at], refused: [over] })
  })

  it('judges each file on its own — six 10 MB files are all accepted', () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`f${i}.csv`, 10 * 1024 * 1024))
    expect(partitionBySizeLimit(six).refused).toHaveLength(0)
  })
})

describe('oversizeFilesMessage', () => {
  it('names the file, its size, and the limit', () => {
    const msg = oversizeFilesMessage([file('BES.sav', 1_047_131_316)])
    expect(msg).toContain('“BES.sav” (998.6 MB) was not added')
    expect(msg).toContain('files of 50 MB or smaller')
  })

  it('says "were" for several and nothing for none', () => {
    expect(oversizeFilesMessage([file('a', 6e7), file('b', 7e7)])).toMatch(/ were not added/)
    expect(oversizeFilesMessage([])).toBe('')
  })
})

describe('checkImportFiles (#1012)', () => {
  const opts = { isSupported: (n: string) => n.endsWith('.csv'), formatLabel: 'CSV', noun: 'dataset' }

  it('names a wrong-type file and says what the page takes', () => {
    const r = checkImportFiles([file('notes.docx', 10)], opts)
    expect(r.accepted).toEqual([])
    expect(r.message).toBe('“notes.docx” is not a dataset file. This page imports CSV.')
  })

  it('keeps the good files and reports BOTH refusals in one sentence', () => {
    const good = file('a.csv', 10)
    const r = checkImportFiles(
      [good, file('b.docx', 10), file('c.csv', MAX_IMPORT_FILE_BYTES + 1), file('d.pdf', 10)], opts)
    expect(r.accepted).toEqual([good])
    expect(r.message).toMatch(/^“b\.docx”, “d\.pdf” are not dataset files\. This page imports CSV\. “c\.csv” .* was not added/)
  })

  it('judges TYPE before size — a huge wrong file is the wrong file, not a big one', () => {
    const r = checkImportFiles([file('film.mp4', MAX_IMPORT_FILE_BYTES * 20)], opts)
    expect(r.message).toMatch(/is not a dataset file/)
    expect(r.message).not.toMatch(/50 MB/)
  })

  it('says nothing when everything is accepted', () => {
    expect(checkImportFiles([file('a.csv', 10)], opts).message).toBe('')
  })

  it('takes a page-specific limit and names it (Merge: 500 MB)', () => {
    const big = file('p.mmproject', MAX_IMPORT_FILE_BYTES * 2)
    const merge = { isSupported: () => true, formatLabel: 'x', noun: 'project', maxBytes: MAX_PROJECT_FILE_BYTES }
    expect(checkImportFiles([big], merge).accepted).toEqual([big])
    const huge = file('p.mmproject', MAX_PROJECT_FILE_BYTES + 1)
    expect(checkImportFiles([huge], merge).message).toMatch(/500 MB or smaller/)
  })
})

/**
 * POPULATION: every import wizard runs the ONE file check (#1012) — which carries
 * #1007's size refusal with it — and every page meeting the 50 MB limit states it.
 * A wizard that goes back to a private check, or a new one that never had it,
 * fails here: the four behaviours #1012 found were each a wizard's own copy.
 */
describe('every import wizard', () => {
  const PAGES = [
    'DatasetImport', 'AppendImport', 'ConversationImport',
    'DocumentImport', 'ObservationImport', 'CodingImport', 'MergeProject',
  ]
  const NO_50MB_NOTE = new Set(['MergeProject'])  // a .mmproject meets 500 MB, not 50
  for (const page of PAGES) {
    const src = stripComments(readFileSync(resolve(__dirname, `../pages/${page}.tsx`), 'utf-8'))
    it(`${page} checks files through checkImportFiles`, () => {
      expect(src).toMatch(/checkImportFiles\(/)
      expect(src).not.toMatch(/partitionBySizeLimit\(/)
      if (!NO_50MB_NOTE.has(page)) expect(src).toMatch(/<UploadLimitNote\b/)
    })
  }
})
