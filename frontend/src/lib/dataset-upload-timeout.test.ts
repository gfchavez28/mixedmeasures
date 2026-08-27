/**
 * #796 — the dataset upload timeout, and the fail-closed guard that stops a
 * fifth upload surface shipping without one.
 *
 * The defect this pins: `datasetsApi.preview` / `.import` / `.appendPreview` /
 * `.appendImport` passed no `timeout`, so every one inherited the API client's
 * 30s default. MEASURED on the file that produced the report
 * (`GSS_with_union.xlsx`, 11,066,857 bytes, 75,700 x 41): 24.0s to convert the
 * workbook plus 9.8s to infer = **33.8s** for a preview, so the request was
 * aborted seconds short and the wizard reported a valid file as malformed.
 *
 * 🔴 **And then the first fix was itself calibrated on that preview number and
 * shipped too small (#796b).** The IMPORT request runs the same conversion and
 * then WRITES 3.1M rows — **374.8s** before the write path was batched, **100.4s**
 * after. The developer's import timed out against a budget sized for a preview.
 * The lesson is in the tests below: **the budget is pinned to the slowest
 * request, and each phase's hint to its own measurement.**
 *
 * ⚠️ The timing assertions below are about the FORMULA, never about how fast
 * this machine is. A test that measured real parse time would be a flake.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  datasetUploadTimeoutMs,
  estimatedProcessingSeconds,
  describeDatasetUploadError,
  MAX_DATASET_UPLOAD_SIZE,
  SLOW_UPLOAD_THRESHOLD_BYTES,
} from './dataset-import-formats'
import { ApiError } from './api/client'

/** The exact file from the #796 report. */
const GSS_BYTES = 11_066_857
/**
 * Its measured server-side cost per request, in ms.
 *
 * 🔴 The budget must clear the IMPORT number, not the preview one. Calibrating
 * on preview is exactly what shipped too small the first time (#796b): preview
 * READS the cells, import also WRITES 3.1M rows.
 */
const GSS_PREVIEW_MS = 33_800
const GSS_IMPORT_MS = 100_400

describe('datasetUploadTimeoutMs (#796)', () => {
  it('clears the measured IMPORT cost with real margin, not just the preview', () => {
    // The regression this pins: the first version cleared GSS_PREVIEW_MS and
    // failed on GSS_IMPORT_MS, which is the request the researcher actually
    // waited on. A warm local measurement is the FLOOR of what a slower machine
    // will do, so "just clears it" is not good enough.
    const budget = datasetUploadTimeoutMs(GSS_BYTES)
    expect(budget).toBeGreaterThan(GSS_PREVIEW_MS)
    expect(budget).toBeGreaterThan(GSS_IMPORT_MS * 3)
  })

  it('floors at two minutes so a small stalled upload still fails', () => {
    // The counter-risk to raising a timeout: a flat generous value makes a
    // stalled 5KB CSV hang the wizard. Small files get the floor, not the cap.
    expect(datasetUploadTimeoutMs(0)).toBe(120_000)
    expect(datasetUploadTimeoutMs(5_000)).toBe(120_000)
    expect(datasetUploadTimeoutMs(1_000_000)).toBe(120_000)
  })

  it('caps at the estimate for a maximum-size upload, never below it', () => {
    // #544's lesson, one layer up: a FIXED cap that sits under what an in-limit
    // file legitimately needs aborts it when it is nearly done. The cap must be
    // derived from the same formula, so an at-cap file always fits exactly.
    const atCap = datasetUploadTimeoutMs(MAX_DATASET_UPLOAD_SIZE)
    const overCap = datasetUploadTimeoutMs(MAX_DATASET_UPLOAD_SIZE * 10)
    expect(overCap).toBe(atCap)
    expect(atCap).toBeGreaterThan(datasetUploadTimeoutMs(GSS_BYTES))
  })

  it('increases monotonically with size', () => {
    const sizes = [0, 1e5, 1e6, 5e6, GSS_BYTES, 3e7, MAX_DATASET_UPLOAD_SIZE]
    const budgets = sizes.map(datasetUploadTimeoutMs)
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1])
    }
  })

  it('mirrors the backend cap', () => {
    // Backend `routers/helpers.py::MAX_UPLOAD_SIZE`. Drift here silently gives an
    // at-cap file a budget computed for the wrong ceiling.
    expect(MAX_DATASET_UPLOAD_SIZE).toBe(50 * 1024 * 1024)
  })
})

describe('estimatedProcessingSeconds — the hint, not the budget', () => {
  it('is an estimate of real time, so it is well UNDER the timeout budget', () => {
    // These two numbers exist for different jobs and must not be conflated: the
    // hint tells the researcher what to expect on a normal machine, the budget
    // is the pessimistic bound before we give up.
    for (const phase of ['preview', 'import'] as const) {
      const hintMs = estimatedProcessingSeconds(GSS_BYTES, phase) * 1000
      expect(hintMs).toBeLessThan(datasetUploadTimeoutMs(GSS_BYTES))
    }
  })

  it('matches each phase\'s OWN measurement — import is ~3x preview', () => {
    // The defect this pins: the import button quoted the preview estimate, so a
    // 100s wait was advertised as ~34s and read as a hang long before it was one.
    const preview = estimatedProcessingSeconds(GSS_BYTES, 'preview')
    const importEst = estimatedProcessingSeconds(GSS_BYTES, 'import')
    expect(preview).toBeGreaterThan(GSS_PREVIEW_MS / 1000 * 0.6)
    expect(preview).toBeLessThan(GSS_PREVIEW_MS / 1000 * 1.6)
    expect(importEst).toBeGreaterThan(GSS_IMPORT_MS / 1000 * 0.6)
    expect(importEst).toBeLessThan(GSS_IMPORT_MS / 1000 * 1.6)
    expect(importEst).toBeGreaterThan(preview * 2)
  })

  it('defaults to the preview phase (the cheaper, safer quote)', () => {
    expect(estimatedProcessingSeconds(GSS_BYTES)).toBe(
      estimatedProcessingSeconds(GSS_BYTES, 'preview'),
    )
  })

  it('the slow-file threshold actually catches the reported file', () => {
    // A threshold that did not fire on the file from the report would be a hint
    // nobody ever sees.
    expect(GSS_BYTES).toBeGreaterThan(SLOW_UPLOAD_THRESHOLD_BYTES)
  })
})

describe('describeDatasetUploadError (#797)', () => {
  it('names a timeout as a timeout, and does NOT blame the file', () => {
    const err = new DOMException('signal timed out', 'TimeoutError')
    const msg = describeDatasetUploadError(err)
    expect(msg).toMatch(/timed out/i)
    // The exact defect being fixed: the old copy said "Please check your CSV
    // files" for a failure that had nothing to do with the file.
    expect(msg).not.toMatch(/check your/i)
    expect(msg).toMatch(/nothing is wrong with the file/i)
  })

  it('does not tell the user to retry a timeout', () => {
    // The budget is derived from the file's size, so a retry gets the identical
    // budget and the identical result. "Try again" would be a loop that cannot
    // terminate — a true-sounding sentence that wastes the researcher's time.
    const msg = describeDatasetUploadError(new DOMException('x', 'TimeoutError'))
    expect(msg).not.toMatch(/try again/i)
  })

  it('does not offer advice that cannot apply to a single file', () => {
    // Reported verbatim: the developer hit this with ONE file selected and was
    // told "Importing fewer files at once may help". Advice the situation makes
    // impossible is worse than no advice.
    const msg = describeDatasetUploadError(new DOMException('x', 'TimeoutError'))
    expect(msg).not.toMatch(/fewer files/i)
  })

  it('prefers the backend detail when there is one', () => {
    const err = new ApiError(400, { detail: 'Unknown sheet "Sheet9".' }, {})
    expect(describeDatasetUploadError(err)).toBe('Unknown sheet "Sheet9".')
  })

  it('does not surface the client placeholder as if it were a reason', () => {
    // ApiError.message falls back to "Request failed with status N" when the
    // response carried no detail; echoing that at the user is noise.
    const err = new ApiError(400, {}, {})
    expect(describeDatasetUploadError(err)).not.toMatch(/request failed with status/i)
    expect(describeDatasetUploadError(err)).toMatch(/CSV, Excel|SPSS/)
  })

  it('names the cap on a 413', () => {
    expect(describeDatasetUploadError(new ApiError(413, {}, {}))).toMatch(/50 MB/)
  })

  it('never claims the file is at fault for a network drop', () => {
    const msg = describeDatasetUploadError(new TypeError('Failed to fetch'))
    expect(msg).toMatch(/interrupted|connection/i)
    expect(msg).not.toMatch(/check your CSV/i)
  })
})

// ── The fail-closed guard ───────────────────────────────────────────────────

describe('every dataset upload call carries a timeout (fail-closed)', () => {
  const SRC = join(__dirname, 'api', 'datasets.ts')
  const src = readFileSync(SRC, 'utf8')

  /**
   * A multipart call is an upload. Find each one by its own `FormData()` block
   * and require a `timeout:` before the block ends.
   *
   * Written as a POPULATION assertion, not a list of the four calls I happen to
   * know about — the internal design notes's rule, learned from #771/#785 shipping partially
   * four times because the guard enumerated known controls instead of the set.
   */
  const blocks = src
    .split(/const formData = new FormData\(\)/)
    .slice(1)
    .map(chunk => chunk.slice(0, chunk.indexOf('.then(res => res.data)')))

  it('finds a real, non-trivial set of upload calls', () => {
    // Guard the guard: a changed idiom here would make every assertion vacuous.
    expect(blocks.length).toBeGreaterThanOrEqual(4)
  })

  it('passes a size-derived timeout on every one of them', () => {
    const missing = blocks.filter(b => !b.includes('timeout:'))
    expect(missing).toEqual([])
  })

  it('derives each timeout from the file rather than hard-coding a constant', () => {
    // A literal `timeout: 300_000` would pass the check above while
    // reintroducing exactly the flat-value problem the helper exists to avoid.
    for (const b of blocks) {
      expect(b).toMatch(/timeout:\s*datasetUploadTimeoutMs\(/)
    }
  })
})
