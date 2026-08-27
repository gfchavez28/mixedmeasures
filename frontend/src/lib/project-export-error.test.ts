/**
 * #842 — a refusal the server took care to word must REACH the researcher.
 *
 * **Found by driving, 2026-08-27.** The backend gained a bounded refusal naming the
 * limit, saying backups are unaffected, and saying what to do. Driven against the
 * real GSS project it answered exactly that, HTTP 400. Then every one of the four
 * client call sites threw it away:
 *
 *     } catch { toast.error('Project export failed') }               // ExportDialog
 *     } catch { toast.error('Export failed') }                       // OverviewPage
 *     } catch { toast.error('Export failed') }                       // Dashboard menu
 *     onError: () => { toast.error('Could not duplicate project') }  // Dashboard
 *
 * A bare `catch {}` cannot even name the error it is discarding. This is #820's
 * defect one layer up — there, a SUCCESSFUL 85.6 s response was discarded behind
 * `alert("R Data Export failed.")` — and it is why the guard is a POPULATION over
 * the call sites rather than a test of the helper: the helper was never the part
 * that was missing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'
import { ApiError } from './api/client'
import { describeProjectExportError, LONG_TOAST_MS } from './project-export-error'

const SRC = join(__dirname, '..')
const FALLBACK = 'Export failed'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Files that call the two portability operations, excluding the api module itself. */
function callSites(): { file: string; src: string }[] {
  return sourceFiles(SRC)
    .filter(f => !f.endsWith(join('api', 'project-portability.ts')))
    .map(f => ({ file: f.slice(SRC.length + 1), src: stripComments(readFileSync(f, 'utf8'), f) }))
    .filter(({ src }) => /projectPortabilityApi\.(exportProject|duplicateProject)\s*\(/.test(src))
}

/**
 * The handler attached to ONE call, as the window following it.
 *
 * ⚠️ Scoped to the CALL, not the file. The first draft of this guard asked "does
 * this file contain a bare `catch {`?" and reported `exportCodebook`,
 * `validateImport` and `importProject` — none of which can hit this bound.
 * Standing condition 4: the defect lives in the handler attached to THIS call, so
 * that is the set to scan.
 */
const WINDOW = 600

function handlersFor(src: string): string[] {
  const out: string[] = []
  const re = /projectPortabilityApi\.(exportProject|duplicateProject)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(src.slice(m.index, m.index + WINDOW))
  return out
}

function handlerOffenders(src: string): string[] {
  const out: string[] = []
  for (const handler of handlersFor(src)) {
    if (/\}\s*catch\s*\{/.test(handler)) out.push('bare `catch {` discards the reason')
    else if (!handler.includes('toastProjectExportError')) {
      out.push('the failure handler does not route through toastProjectExportError')
    }
  }
  return out
}

describe('#842 — the size refusal reaches the researcher', () => {
  // ⚠️ Explicit timeout (#841): this walks and strips the whole source tree, and
  // since #838 that means a TypeScript parse per file — comfortably under 5 s
  // alone, past it under full-suite contention. Same budget and same reason as
  // `strip-comments.test.ts`. `stripComments` caches on source text and the
  // cache is per-FILE (vitest gives each test file its own process), so the
  // first scan in this file pays and the rest are nearly free.
  it('finds the real call sites (the scan is not blind)', { timeout: 60_000 }, () => {
    // POPULATION self-check (#730): `toEqual([])` below passes by finding nothing.
    const files = callSites().map(c => c.file)
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files).toContain(join('components', 'ExportDialog.tsx'))
    expect(files).toContain(join('pages', 'Dashboard.tsx'))
    const handlers = callSites().flatMap(c => handlersFor(c.src))
    expect(handlers.length).toBeGreaterThanOrEqual(4)
  })

  it('no call site swallows the server’s reason', { timeout: 60_000 }, () => {
    const offenders: string[] = []
    for (const { file, src } of callSites()) {
      for (const o of handlerOffenders(src)) offenders.push(`${file}: ${o}`)
    }
    expect(
      offenders,
      'The backend names the limit, says backups are unaffected and says what to do ' +
        '(#842). A call site that replaces that with "Export failed" leaves the ' +
        'researcher exactly where the raw OperationalError left them. Route the ' +
        'error through toastProjectExportError.',
    ).toEqual([])
  })

  it('the handler scan fires on the shape that shipped (predicate falsifier)', () => {
    // PREDICATE falsifier (#729): the real pre-fix code, verbatim.
    const bareCatch = `
      try {
        await projectPortabilityApi.exportProject(projectId, includeMedia)
        toast.success('Project exported')
      } catch {
        toast.error('Project export failed')
      }
    `
    expect(handlerOffenders(bareCatch)).toEqual(['bare `catch {` discards the reason'])

    const namedButIgnored = `
      mutationFn: (id: number) => projectPortabilityApi.duplicateProject(id),
      onError: () => { toast.error('Could not duplicate project') },
    `
    expect(handlerOffenders(namedButIgnored)).toHaveLength(1)

    const good = `
      try {
        await projectPortabilityApi.exportProject(projectId)
      } catch (err) {
        toastProjectExportError(err, 'Export failed')
      }
    `
    expect(handlerOffenders(good)).toEqual([])
  })

  it('carries the server’s reason as a DESCRIPTION, with time to read it', () => {
    // ⚠️ The refusal is ~380 chars — four times the longest plain toast in this app.
    // Title = what failed (the client knows which operation it invoked); description
    // = the server's reason verbatim (it is the authority on why).
    const detail = 'This project holds 3,633,552 dataset values, over the 500,000 limit…'
    const failure = describeProjectExportError(new ApiError(400, { detail }, {}), FALLBACK)
    expect(failure.title).toBe(FALLBACK)
    expect(failure.description).toBe(detail)
    expect(failure.duration).toBe(LONG_TOAST_MS)
    expect(LONG_TOAST_MS).toBeGreaterThan(4_000) // sonner's default; unreadable here
  })

  it('does not invent a reason when the body carried none', () => {
    // ApiError.message falls back to "Request failed with status N"; showing that
    // placeholder to a researcher is worse than showing the fallback title alone.
    const failure = describeProjectExportError(new ApiError(400, {}, {}), FALLBACK)
    expect(failure.title).toBe(FALLBACK)
    expect(failure.description).toBeUndefined()
  })

  it('does not tell the researcher to retry a timeout', () => {
    // The budget is fixed, so a retry gets the same one — the rule
    // `describeDatasetUploadError` established for the other direction.
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    const failure = describeProjectExportError(timeout, FALLBACK)
    expect(failure.description).not.toMatch(/try again/i)
    expect(failure.description).toMatch(/longer than the app waits/i)
  })
})
