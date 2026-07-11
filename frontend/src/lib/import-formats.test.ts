/**
 * #552 — the client-side upload-format gates are single-sourced.
 *
 * Three modules, one rule: the `accept` attribute and the predicate that filters
 * dropped files MUST come from the same place, or they drift. They already had:
 * the Conversations list page filtered dropped files to `.csv` while the wizard
 * accepted `.csv|.vtt|.srt`, so a Zoom `.vtt` dropped on the list silently
 * vanished — the tool refusing a format it shipped support for (#524).
 *
 * The last test is the one that matters most: a fail-closed SOURCE SCAN that
 * fails if any page re-inlines an extension list. Per-module unit tests only
 * prove the module is right; the scan proves nobody bypassed it, which is the
 * actual failure mode (#540 swept the dataset gates by hand and missed the
 * conversation sibling entirely).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  DATASET_ACCEPT,
  isSupportedDatasetFile,
} from './dataset-import-formats'
import {
  TRANSCRIPT_ACCEPT,
  TRANSCRIPT_FORMAT_LABEL,
  isSupportedTranscriptFile,
} from './conversation-import-formats'
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_FORMAT_LABEL,
  isSupportedDocumentFile,
} from './document-import-formats'

/** `accept=".a,.b"` and the predicate must agree — that pairing IS the module. */
function acceptAgreesWithPredicate(accept: string, predicate: (f: string) => boolean) {
  for (const ext of accept.split(',')) {
    expect(predicate(`file${ext}`), `${ext} is in accept but the predicate rejects it`).toBe(true)
    expect(predicate(`FILE${ext.toUpperCase()}`), `${ext} must match case-insensitively`).toBe(true)
  }
}

describe('transcript formats (#524 / #552)', () => {
  it('accepts CSV and the VTT/SRT subtitle exports', () => {
    expect(isSupportedTranscriptFile('interview.csv')).toBe(true)
    expect(isSupportedTranscriptFile('zoom-meeting.vtt')).toBe(true)
    expect(isSupportedTranscriptFile('teams.srt')).toBe(true)
    expect(isSupportedTranscriptFile('ZOOM-MEETING.VTT')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isSupportedTranscriptFile('notes.docx')).toBe(false)
    expect(isSupportedTranscriptFile('data.xlsx')).toBe(false)
    expect(isSupportedTranscriptFile('recording.mp4')).toBe(false)
    // an extension must be at the END — "report.csv.bak" is not a CSV
    expect(isSupportedTranscriptFile('report.csv.bak')).toBe(false)
  })

  it('accept attribute and predicate agree', () => {
    expect(TRANSCRIPT_ACCEPT).toBe('.csv,.vtt,.srt')
    acceptAgreesWithPredicate(TRANSCRIPT_ACCEPT, isSupportedTranscriptFile)
  })

  it('the human label names every accepted format', () => {
    expect(TRANSCRIPT_FORMAT_LABEL).toMatch(/CSV/i)
    expect(TRANSCRIPT_FORMAT_LABEL).toMatch(/VTT/i)
    expect(TRANSCRIPT_FORMAT_LABEL).toMatch(/SRT/i)
  })
})

describe('document formats', () => {
  it('accepts docx/pdf/txt only', () => {
    expect(isSupportedDocumentFile('report.docx')).toBe(true)
    expect(isSupportedDocumentFile('paper.PDF')).toBe(true)
    expect(isSupportedDocumentFile('notes.txt')).toBe(true)
    expect(isSupportedDocumentFile('sheet.csv')).toBe(false)
    expect(isSupportedDocumentFile('legacy.doc')).toBe(false)
  })

  it('accept attribute and predicate agree', () => {
    expect(DOCUMENT_ACCEPT).toBe('.docx,.pdf,.txt')
    acceptAgreesWithPredicate(DOCUMENT_ACCEPT, isSupportedDocumentFile)
  })

  it('the human label names every accepted format', () => {
    for (const t of [/docx/i, /pdf/i, /txt/i]) expect(DOCUMENT_FORMAT_LABEL).toMatch(t)
  })
})

describe('dataset formats (the module the others mirror)', () => {
  it('accept attribute and predicate agree', () => {
    acceptAgreesWithPredicate(DATASET_ACCEPT, isSupportedDatasetFile)
  })
})

describe('the three format families stay disjoint', () => {
  it('no extension is claimed by two importers', () => {
    // A file that two importers both claim would make the routing ambiguous
    // (which wizard should a dropped file open?). CSV is dataset-vs-transcript
    // by DESTINATION, not extension — they are deliberately the one overlap.
    const doc = DOCUMENT_ACCEPT.split(',')
    const transcript = TRANSCRIPT_ACCEPT.split(',')
    expect(doc.filter(e => transcript.includes(e))).toEqual([])
  })
})

// ── The fail-closed guard ───────────────────────────────────────────────────

const PAGES_DIR = join(__dirname, '..', 'pages')

/** Extension literals that must only ever appear inside the format modules. */
const OWNED_EXTENSIONS = [
  'csv', 'xlsx', 'sav',     // dataset-import-formats.ts
  'vtt', 'srt',             // conversation-import-formats.ts
  'docx', 'pdf', 'txt',     // document-import-formats.ts
]

/**
 * Strip comments before scanning. A comment EXPLAINING the old inlined check
 * (`// was .endsWith('.csv') — it silently refused VTT…`) is documentation, not
 * a re-inlined gate; without this the guard flags the very comment that records
 * the bug it prevents.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (incl. JSX {/* … */})
    .replace(/^\s*\/\/.*$/gm, '')       // whole-line // comments
    .replace(/([^:])\/\/.*$/gm, '$1')   // trailing // comments (spare `https://`)
}

describe('no page re-inlines an upload-format list (fail-closed)', () => {
  const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.tsx'))

  it('scans a real, non-trivial set of pages', () => {
    // Guard the guard: a broken path would make every assertion below vacuous.
    expect(pageFiles.length).toBeGreaterThan(15)
  })

  it.each(pageFiles)('%s has no literal accept="..." attribute', (file) => {
    const src = code(readFileSync(join(PAGES_DIR, file), 'utf8'))
    // `accept="..."` (a string literal) re-inlines the list. The correct form is
    // `accept={SOME_ACCEPT}` — a reference to a format module's constant.
    const literalAccepts = src.match(/accept="[^"]*"/g) ?? []
    expect(
      literalAccepts,
      `${file} inlines an accept string. Import the constant from lib/*-import-formats.ts instead.`,
    ).toEqual([])
  })

  it.each(pageFiles)('%s does not hand-roll an extension test', (file) => {
    const src = code(readFileSync(join(PAGES_DIR, file), 'utf8'))
    const offenders: string[] = []
    for (const ext of OWNED_EXTENSIONS) {
      // `.endsWith('.csv')` / `/\.(csv|vtt)$/` — the two shapes that drifted.
      if (new RegExp(`endsWith\\(['"\`]\\.${ext}['"\`]\\)`).test(src)) {
        offenders.push(`endsWith('.${ext}')`)
      }
      if (new RegExp(`\\\\\\.\\(?[a-z|]*\\b${ext}\\b[a-z|]*\\)?\\$`).test(src)) {
        offenders.push(`regex on .${ext}`)
      }
    }
    expect(
      offenders,
      `${file} hand-rolls an extension check (${offenders.join(', ')}). `
      + 'Use isSupportedDatasetFile / isSupportedTranscriptFile / isSupportedDocumentFile.',
    ).toEqual([])
  })
})
