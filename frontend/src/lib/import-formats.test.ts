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
import { stripComments } from './strip-comments'

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
import {
  CUE_FILE_ACCEPT,
  OBSERVATION_MEDIA_ACCEPT,
  isSupportedCueFile,
  isSupportedObservationMedia,
} from './observation-import-formats'
// The media gate keeps its OWN agreement test in media-constants.test.ts:
// MEDIA_ACCEPT mixes MIME types with dotted extensions, so the dotted-only
// helper below cannot check it (it would test predicate('fileaudio/mpeg')).
import { MEDIA_ACCEPT, isSupportedMediaFile } from './media-constants'

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

describe('observation formats (the Observations import — two gates, not one)', () => {
  it('re-exports the media gate rather than re-declaring it', () => {
    // The whole point of the module: no second copy of the media extension list
    // (that copy IS #552). Identity, not equality.
    expect(OBSERVATION_MEDIA_ACCEPT).toBe(MEDIA_ACCEPT)
    expect(isSupportedObservationMedia).toBe(isSupportedMediaFile)
  })

  it('the cue gate is NARROWER than the transcript gate', () => {
    // A .csv is a legal transcript but NOT a legal cue file: it carries no timed
    // in/out points, so there is nothing to cut clips from. Accepting one would
    // let a user pick a file that can only fail.
    expect(isSupportedTranscriptFile('interview.csv')).toBe(true)
    expect(isSupportedCueFile('interview.csv')).toBe(false)

    expect(isSupportedCueFile('chapters.vtt')).toBe(true)
    expect(isSupportedCueFile('chapters.srt')).toBe(true)
    expect(CUE_FILE_ACCEPT).not.toContain('.csv')
  })

  it('cue accept and predicate agree', () => {
    acceptAgreesWithPredicate(CUE_FILE_ACCEPT, isSupportedCueFile)
  })

  it('rejects a recording as a cue file and vice versa', () => {
    expect(isSupportedCueFile('session.mp4')).toBe(false)
    expect(isSupportedObservationMedia('chapters.vtt')).toBe(false)
  })
})

// ── The fail-closed guard ───────────────────────────────────────────────────

const PAGES_DIR = join(__dirname, '..', 'pages')
const COMPONENTS_DIR = join(__dirname, '..', 'components')

/** Extension literals that must only ever appear inside the format modules. */
const OWNED_EXTENSIONS = [
  'csv', 'xlsx', 'sav',                       // dataset-import-formats.ts
  'vtt', 'srt',                               // conversation-import-formats.ts
  'docx', 'pdf', 'txt',                       // document-import-formats.ts
  'mp3', 'm4a', 'wav', 'mp4', 'mov', 'webm',  // media-constants.ts (#571)
  'mmproject', 'mmcodebook', 'mmbackup', 'qdc',  // mm-formats.ts (#571)
]

/**
 * Every .tsx under a directory, recursively.
 *
 * #571: this scan used to read `pages/` ONLY, so every upload surface in
 * `components/` could drift freely — and one already had
 * (`CodebookToolbar.tsx` inlined `accept=".mmcodebook,.qdc"` while
 * `lib/mm-formats.ts` existed to own exactly that list; they agreed at the time,
 * which is precisely the pre-drift state #552 describes). The Observations
 * dropzone lands in `components/`, so a pages-only guard would have gone blind
 * exactly where it was being extended to help.
 */
function tsxFilesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFilesUnder(full, base)
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [full] : []
  })
}

/**
 * Strip comments before scanning. A comment EXPLAINING the old inlined check
 * (`// was .endsWith('.csv') — it silently refused VTT…`) is documentation, not
 * a re-inlined gate; without this the guard flags the very comment that records
 * the bug it prevents.
 */
const code = stripComments

describe('no page or component re-inlines an upload-format list (fail-closed)', () => {
  const files = [...tsxFilesUnder(PAGES_DIR), ...tsxFilesUnder(COMPONENTS_DIR)]
  const rel = (f: string) => f.slice(f.indexOf('/src/') + 5)

  it('scans a real, non-trivial set of pages AND components', () => {
    // Guard the guard: a broken path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(60)
    expect(files.some(f => f.includes('/pages/'))).toBe(true)
    expect(files.some(f => f.includes('/components/'))).toBe(true)
  })

  it.each(files)('%s has no literal accept="..." attribute', (file) => {
    const src = code(readFileSync(file, 'utf8'))
    // `accept="..."` (a string literal) re-inlines the list. The correct form is
    // `accept={SOME_ACCEPT}` — a reference to a format module's constant.
    const literalAccepts = src.match(/accept="[^"]*"/g) ?? []
    expect(
      literalAccepts,
      `${rel(file)} inlines an accept string. Import the constant from lib/*-import-formats.ts `
      + '(or lib/media-constants.ts / lib/mm-formats.ts) instead.',
    ).toEqual([])
  })

  it.each(files)('%s does not hand-roll an extension test', (file) => {
    const src = code(readFileSync(file, 'utf8'))
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
      `${rel(file)} hand-rolls an extension check (${offenders.join(', ')}). `
      + 'Use the format modules\' predicates (isSupportedDatasetFile / isSupportedTranscriptFile / '
      + 'isSupportedDocumentFile / isSupportedMediaFile / isSupportedCueFile).',
    ).toEqual([])
  })
})
