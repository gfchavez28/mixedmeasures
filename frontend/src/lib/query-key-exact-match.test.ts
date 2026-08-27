/**
 * #800's rule, enforced: `getQueryData` / `setQueryData` are **EXACT-match**,
 * while `invalidateQueries` / `cancelQueries` / `refetchQueries` are **PREFIX-match**.
 *
 * **What it looked like when it was violated.** `TextCodingView`'s "Quote N texts"
 * undo read the cache with `getQueryData(['text-data', projectId])` while the query
 * that fills that cache declares an EIGHT-element key
 * (`['text-data', projectId, columnIdsStr, datasetFilterIds, hideEmpty, searchText,
 * randomSeed, quotedOnly]`). The read matched nothing and returned `undefined` on
 * every call, so the loop that deletes the newly-created excerpts never ran — and the
 * view then announced *"Texts unquoted"*. The quotes were still there. (It also read
 * `.comments`; the response field is `texts`, so the call was dead twice over.)
 *
 * **Why a scan and not a render test.** The defect is invisible at runtime in the
 * shape that matters: nothing throws, nothing logs, and the announcement is cheerful.
 * A component test would have to mount a 1,400-line page, seed a real query cache with
 * the full eight-element key, and drive an undo — and would then be asserting against
 * the very key shape that was wrong. The property that IS statically checkable is the
 * one that was violated: *an exact-match accessor must not be handed a strict prefix
 * of a key this file declares.*
 *
 * ⚠️ Deliberately scoped to WITHIN A FILE. A key declared in one module and read in
 * another is a real variant of this bug, but matching those textually produces
 * phantoms, and a guard that reports phantoms is worse than one that finds nothing
 * (#772). This catches the shape that has actually shipped.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Split a bracketed array literal's body into top-level elements. */
function elements(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** The array literal starting at `open` (index of its `[`), as elements. */
function arrayAt(src: string, open: number): string[] | null {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) {
      depth--
      if (depth === 0) return elements(src.slice(open + 1, i))
    }
  }
  return null
}

/** Every `queryKey: [ … ]` literal in a file. */
export function declaredKeys(src: string): string[][] {
  const keys: string[][] = []
  const re = /queryKey:\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const arr = arrayAt(src, m.index + m[0].length - 1)
    if (arr) keys.push(arr)
  }
  return keys
}

/** Every key literal handed to an EXACT-match accessor. */
export function exactMatchKeys(src: string): { fn: string; key: string[] }[] {
  const found: { fn: string; key: string[] }[] = []
  const re = /\b(getQueryData|setQueryData)\s*(?:<[^(]*>)?\s*\(\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const arr = arrayAt(src, re.lastIndex - 1)
    if (arr) found.push({ fn: m[1], key: arr })
  }
  return found
}

function isStrictPrefix(short: string[], long: string[]): boolean {
  if (short.length >= long.length) return false
  return short.every((el, i) => el === long[i])
}

export function offendersIn(src: string): string[] {
  const declared = declaredKeys(src)
  const out: string[] = []
  for (const { fn, key } of exactMatchKeys(src)) {
    for (const d of declared) {
      if (isStrictPrefix(key, d)) {
        out.push(`${fn}([${key.join(', ')}]) is a strict prefix of queryKey [${d.join(', ')}]`)
      }
    }
  }
  return out
}

describe('#800 — an exact-match cache accessor is never handed a prefix key', () => {
  const files = sourceFiles(SRC)

  // ⚠️ Explicit timeout (#841): this walks and strips the whole source tree, and
  // since #838 that means a TypeScript parse per file — comfortably under 5 s
  // alone, past it under full-suite contention. Same budget and same reason as
  // `strip-comments.test.ts`. `stripComments` caches on source text and the
  // cache is per-FILE (vitest gives each test file its own process), so the
  // first scan in this file pays and the rest are nearly free.
  it('reads a real population (the scan is not blind)', { timeout: 60_000 }, () => {
    // POPULATION self-check (#730): `expect(offenders).toEqual([])` passes by
    // finding nothing, including when the walk or the matcher has rotted.
    let accessors = 0
    let declared = 0
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'), f)
      accessors += exactMatchKeys(src).length
      declared += declaredKeys(src).length
    }
    expect(files.length).toBeGreaterThan(200)
    expect(accessors).toBeGreaterThan(20)
    expect(declared).toBeGreaterThan(50)
  })

  it('fires on the exact shape that shipped (predicate falsifier)', () => {
    // PREDICATE falsifier (#729): prove the matcher catches the real defect,
    // rather than passing because it matches nothing at all.
    const bad = `
      useQuery({ queryKey: ['text-data', projectId, columnIdsStr, hideEmpty] })
      const fresh = queryClient.getQueryData<{ texts: T[] }>(['text-data', projectId])
    `
    expect(offendersIn(bad)).toHaveLength(1)

    // …and does NOT fire on the correct full-key read.
    const good = `
      useQuery({ queryKey: ['text-data', projectId, columnIdsStr, hideEmpty] })
      const fresh = queryClient.getQueryData(['text-data', projectId, columnIdsStr, hideEmpty])
    `
    expect(offendersIn(good)).toEqual([])
  })

  it('no source file reads or writes a truncated key', { timeout: 60_000 }, () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'), f)
      for (const o of offendersIn(src)) {
        offenders.push(`${f.slice(SRC.length + 1)}: ${o}`)
      }
    }
    expect(
      offenders,
      'getQueryData/setQueryData are EXACT-match. A key that is a strict prefix of ' +
        'the declared queryKey matches NOTHING — the read returns undefined and the ' +
        'write lands where no reader looks, both silently. Use the full key, or ' +
        'switch to the prefix-matching pair (refetchQueries + getQueriesData).',
    ).toEqual([])
  })
})
