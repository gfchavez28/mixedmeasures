/**
 * #1226 — every door that DELETES a source forgets the cached project pages.
 *
 * SQLite reuses ids (no AUTOINCREMENT): delete the newest conversation, import
 * another, and the new one IS conversation 2 again. Its workbench read
 * `['conversation', pid, cid]`, `['segments', cid]` and `['notes', cid]` from the
 * cache — the deleted transcript under the deleted name, with no request — and
 * *Quote segment* on a row of it saved an excerpt on the NEW interview's passage
 * (DRIVEN on HEAD 201003e9, 2026-10-15). Documents the same (DRIVEN).
 *
 * The doors are found by what they CALL, never by page name:
 *  1. the delete METHODS are read out of `lib/api/*` — every method whose
 *     `api.delete(…)` path is `/projects/${…}/<source kind>/${…}` and nothing
 *     after it (so `deleteRow`, `deleteClip`, `deleteImage` are not doors);
 *  2. every call of one of them anywhere in `src/` is a door, and its scope —
 *     the `useMutation({…})` options it sits in, else its nearest block — must
 *     call `forgetCachedProjectPages`; inside a mutation, from `onSettled` (a
 *     delete the client stopped waiting for may still have finished, #1206's
 *     `ProjectDeleteDialog` reasoning).
 *
 * ⚠️ What this cannot prove: that the removal happens while the deleted source's
 * page is INACTIVE (true of every door today — none is on the source's own page),
 * or that the call works — `source-delete-forget-cache.render.test.tsx` renders two.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'

const SOURCE_KINDS = ['conversations', 'documents', 'observations', 'datasets']
const WHOLE_SOURCE_PATH = new RegExp(`^/projects/\\{\\}/(${SOURCE_KINDS.join('|')})/\\{\\}$`)
const FORGET = 'forgetCachedProjectPages'

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** A template's text with every `${…}` replaced by `{}`. */
function templateShape(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  return node.head.text + node.templateSpans.map(s => '{}' + s.literal.text).join('')
}

/** `xApi.method` for every API method that DELETEs a whole source, read from `text`. */
export function deleteMethodsIn(text: string, fileName: string): string[] {
  const sf = parse(text, fileName)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue
        let found = false
        const inner = (n: ts.Node) => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === 'api.delete' && n.arguments[0]) {
            const shape = templateShape(n.arguments[0])
            if (shape && WHOLE_SOURCE_PATH.test(shape)) found = true
          }
          ts.forEachChild(n, inner)
        }
        inner(prop)
        if (found) out.push(`${node.name.text}.${prop.name.getText(sf)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function isUseMutationOptions(node: ts.Node, sf: ts.SourceFile): boolean {
  return ts.isObjectLiteralExpression(node) && !!node.parent
    && ts.isCallExpression(node.parent) && node.parent.expression.getText(sf) === 'useMutation'
}

function callsForget(scope: ts.Node): boolean {
  let hit = false
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === FORGET) hit = true
    if (!hit) ts.forEachChild(n, visit)
  }
  visit(scope)
  return hit
}

export interface Door { line: number; method: string; problem: string | null }

/** Every call of a delete method in `text`, and what is wrong with its door. */
export function doorsIn(text: string, fileName: string, methods: Set<string>): Door[] {
  const sf = parse(text, fileName)
  const doors: Door[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && methods.has(node.expression.getText(sf))) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      let options: ts.ObjectLiteralExpression | null = null
      let block: ts.Block | null = null
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if (!block && ts.isBlock(p)) block = p
        if (isUseMutationOptions(p, sf)) { options = p as ts.ObjectLiteralExpression; break }
      }
      let problem: string | null = null
      if (options) {
        const onSettled = options.properties.find(pr => pr.name?.getText(sf) === 'onSettled')
        if (!onSettled) problem = `its useMutation has no onSettled calling ${FORGET}`
        else if (!callsForget(onSettled)) problem = `its onSettled does not call ${FORGET}`
      } else if (!block || !callsForget(block)) {
        problem = `its block does not call ${FORGET}`
      }
      doors.push({ line, method: node.expression.getText(sf), problem })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return doors
}

function apiDeleteMethods(): string[] {
  const files = sourceFiles({ ext: 'ts', floor: 20, root: 'lib/api', recursive: false, sentinels: ['lib/api/conversations.ts'] })
  return files.flatMap(abs => deleteMethodsIn(readFileSync(abs, 'utf8'), abs))
}

describe('#1226 — a source delete door forgets the cached project pages', () => {
  it('the delete methods are read from the API modules, and are the four known ones at least', () => {
    const methods = apiDeleteMethods()
    // A population self-check (#730): an empty list would make every door "fine".
    expect(methods).toEqual(expect.arrayContaining([
      'conversationsApi.delete', 'documentsApi.remove', 'observationsApi.remove', 'datasetsApi.delete',
    ]))
    // …and the path filter is exact: a row, a clip or an image is not a source.
    expect(methods.some(m => /deleteRow|deleteClip|deleteImage|Column/.test(m))).toBe(false)
  })

  it('every call of one, anywhere in src/, forgets — from onSettled inside a mutation', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const methods = new Set(apiDeleteMethods())
    const files = sourceFiles({
      ext: 'both', floor: 300,
      sentinels: ['pages/ConversationsListPage.tsx', 'pages/DocumentsListPage.tsx',
        'pages/ObservationsListPage.tsx', 'pages/DatasetsListPage.tsx'],
    })
    const needles = [...methods].map(m => `${m}(`)
    const found: string[] = []
    const offenders: string[] = []
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8')
      if (!needles.some(n => text.includes(n))) continue
      for (const d of doorsIn(text, abs, methods)) {
        found.push(srcRel(abs))
        if (d.problem) offenders.push(`${srcRel(abs)}:${d.line} ${d.method} — ${d.problem}`)
      }
    }
    // Each list page is a door, and the observation wizard removes its own shell twice.
    for (const page of ['ConversationsListPage', 'DocumentsListPage', 'ObservationsListPage', 'DatasetsListPage']) {
      expect(found, `${page} was not seen as a door`).toContain(`pages/${page}.tsx`)
    }
    expect(found.length).toBeGreaterThanOrEqual(6)
    expect(
      offenders,
      'A source delete hands its id to the next source created (#1226). Call '
        + `${FORGET}(queryClient) in the mutation's onSettled (or beside the call), `
        + 'so the deleted source\'s cached pages cannot be shown as the new one.',
    ).toEqual([])
  })

  it('the predicate: fires on a door with no forget, or a forget only in onSuccess; passes onSettled and a block', () => {
    const methods = new Set(['xApi.delete'])
    const door = (body: string) => doorsIn(body, 'a.tsx', methods).map(d => d.problem)
    expect(door('useMutation({ mutationFn: (id) => xApi.delete(1, id), onSuccess: () => {} })'))
      .toEqual([`its useMutation has no onSettled calling ${FORGET}`])
    expect(door(`useMutation({ mutationFn: (id) => xApi.delete(1, id), onSuccess: () => ${FORGET}(qc), onSettled: () => {} })`))
      .toEqual([`its onSettled does not call ${FORGET}`])
    expect(door(`useMutation({ mutationFn: async (id) => { return xApi.delete(1, id) }, onSettled: () => ${FORGET}(qc) })`))
      .toEqual([null])
    expect(door(`async function f() { if (a) { await xApi.delete(1, 2); ${FORGET}(qc) } }`)).toEqual([null])
    expect(door('async function f() { if (a) { await xApi.delete(1, 2) } }'))
      .toEqual([`its block does not call ${FORGET}`])
    // Not a door: another method of the same object, and a deeper path.
    expect(door('xApi.deleteRow(1, 2, 3)')).toEqual([])
    expect(deleteMethodsIn(
      'export const xApi = { remove: (p: number, d: number) => api.delete(`/projects/${p}/documents/${d}`),'
        + ' deleteImage: (p: number, d: number, i: number) => api.delete(`/projects/${p}/documents/${d}/images/${i}`) }',
      'x.ts',
    )).toEqual(['xApi.remove'])
  })
})
