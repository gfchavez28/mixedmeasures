/**
 * #1268 — no sentence the client or the desktop shell shows a researcher tells them to
 * check a log. There is none they can open: the backend logs to stderr only, and the
 * shell forwards that to its own console (`electron/main.js`). The Data Quality tab said
 * "…or check the server logs." under a failed summary — a dead end at the moment the
 * researcher is already stuck.
 *
 * A source scan over `src/` (the one walker, `test-support/source-tree.ts`) and the
 * shell's own `electron/*.js`, with comments stripped first by the one stripper
 * (`lib/strip-comments.ts`), so prose explaining the rule is never read as breaking it
 * (#772). Guarded both ways (#729/#730): a population floor plus sentinels on the walk,
 * and a predicate falsifier on every shape the old sentence could take.
 *
 * The backend's strings are scanned by `backend/tests/test_no_log_instructions.py`, with
 * the same pattern.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import {
  shellSources, sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS,
} from '@/test-support/source-tree'

/** Mirrors `LOG_INSTRUCTION` in the backend scan. Broad on purpose: a false positive
 *  is a sentence to reword; a false negative is the dead end this file exists to stop. */
const LOG_INSTRUCTION =
  /\bserver[\s-]?logs?\b|\b(check|see|read|open)\s+(the\s+)?(app\s+|application\s+)?logs?\b|\blog\s+files?\b/i

function offences(src: string, fileName: string): string[] {
  return stripComments(src, fileName)
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => LOG_INSTRUCTION.test(line))
    .map(([n, line]) => `${n}: ${line.trim()}`)
}

describe('#1268 — no user-facing sentence sends a researcher to a log', () => {
  it('none in the client', () => {
    const files = sourceFiles({
      ext: 'both',
      floor: 400,
      sentinels: ['components/analysis/DataQualityTab.tsx', 'pages/MergeProject.tsx'],
    })
    const found = files.flatMap(abs =>
      offences(readFileSync(abs, 'utf8'), abs).map(o => `${srcRel(abs)}:${o}`))
    expect(found, 'a desktop install has no log a researcher can open — say what they can do').toEqual([])
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('none in the desktop shell', () => {
    const found = shellSources({ floor: 5, sentinels: ['main.js', 'fatal-error.js'] }).flatMap(abs =>
      offences(readFileSync(abs, 'utf8'), basename(abs)).map(o => `electron/${basename(abs)}:${o}`))
    expect(found).toEqual([])
  })

  it('the matcher fires on the old sentence as JSX text and as a string, and not in a comment', () => {
    // PREDICATE falsifier — each shape a real offence took, and the prose that must pass.
    const jsx = '<p className="x">Try adjusting your variable selection or check the server logs.</p>'
    const str = "toast.error('Project import failed, and nothing was changed. Check server logs for details.')"
    const shell = "dialog.showErrorBox('Mixed Measures', 'See the log file for details.')"
    expect(offences(jsx, 'a.tsx')).toHaveLength(1)
    expect(offences(str, 'a.ts')).toHaveLength(1)
    expect(offences(shell, 'main.js')).toHaveLength(1)
    const prose = [
      '// It said "check the server logs", which a desktop user cannot.',
      '/* check the server logs */',
      '<div>{/* check the server logs */}</div>',
      "const message = 'Change the variable selection to try again.'",
    ].join('\n')
    expect(offences(prose, 'a.tsx')).toEqual([])
  })
})
