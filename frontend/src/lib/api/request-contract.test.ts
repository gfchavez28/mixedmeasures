// @vitest-environment node
/**
 * #1534 D110 (1.5.9) — every `lib/api` request sends only names its route declares.
 *
 * **The class.** FastAPI drops a query parameter a route does not declare, and a body model
 * (production keeps `extra='ignore'`) drops an undeclared field — both without a word. The
 * Cross-analysis CSV sent `filters` to a route reading `filters_json` from the day it was
 * written (2026-02-19), so no release ever filtered the file; the Export dialog's *Summaries*
 * box sent `include_summaries` to a route that had read `include_sources` since #895 (v1.5.2).
 * Each half's tests passed against its own idea of the name — the backend tests call endpoints
 * directly (no query string is parsed), the frontend tests mock the request — so only a check
 * ACROSS the boundary sees it. This is that check.
 *
 * **How.** `route-params.json` is the server's declared names, per operation, held EQUAL to
 * `app.openapi()` by `backend/tests/test_route_params_map.py` (regenerate it with
 * `python scripts/route_params.py --write` from `backend/`). Here the TypeScript checker
 * resolves each request's URL and keys — template URLs, local URL helpers (`base(pid)`), a
 * URL wrapper (`withCoderScope(url, ids)`), `URLSearchParams` appends, `config.params`, a
 * key typed as a union of string literals, `include_${key}` over `Object.entries(x)`, and the
 * JSON body's type — and every key must be declared, or listed below with its reason.
 *
 * ⚠️ **What it cannot see, stated so a green run is not read as more:** a request built
 * outside `lib/api` (none today — every other importer of `client.ts` takes only `ApiError`
 * or `holdSessionReload`), a key the checker cannot resolve (it FAILS unless exempted, never
 * passes silently), and whether a declared name means what the client means by it.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript'
import { sourceFiles } from '@/test-support/source-tree'

const API_DIR = resolve(__dirname)
const FRONTEND = resolve(__dirname, '..', '..', '..')
const ROUTE_PARAMS = JSON.parse(readFileSync(join(API_DIR, 'route-params.json'), 'utf8')) as
  Record<string, { query: string[]; body: string[] | '*' | null }>

/** Undeclared QUERY keys that are known and decided — `"<op> <key>"` → why. A stale entry fails. */
const EXEMPT_QUERY: Record<string, string> = {
  'GET /api/projects/{project_id}/code-analysis/frequencies text_column_ids':
    '#749 — `/frequencies` declares no text_column_ids, decided: the fix belongs at the consumer that wants the narrower scope (`qual-client.md` §2)',
  'GET /api/projects/{project_id}/code-analysis/frequencies level':
    'the shared CodeAnalysisFilterParams carries the Relationships tab\'s co-occurrence level; frequencies have no level',
  'GET /api/projects/{project_id}/code-analysis/codes/{code_id}/segments code_ids':
    'the shared CodeAnalysisFilterParams type; the passage list is asked per code in its path',
  'GET /api/projects/{project_id}/code-analysis/codes/{code_id}/segments text_column_ids':
    'the shared CodeAnalysisFilterParams type; the passage list has no text-answer arm',
  'GET /api/projects/{project_id}/code-analysis/codes/{code_id}/segments source':
    'the shared CodeAnalysisFilterParams type; the passage list reads segments of every kind its selection names',
  'GET /api/projects/{project_id}/code-analysis/codes/{code_id}/segments level':
    'the shared CodeAnalysisFilterParams type; a passage list has no co-occurrence level',
  // The Segments CSV's `source` exemption is gone with #1535 D111 (1.5.9): the door no longer
  // sends it, and the route reads the document and clip lists it now forwards.
}

/** Bodies whose keys are not all declared, by operation → why. A stale entry fails. */
const EXEMPT_BODY: Record<string, string> = {
  'PATCH /api/projects/{project_id}':
    'typed as a whole Project (Partial<Project>), so the TYPE admits read-only fields; callers send the editable ones',
  'PATCH /api/projects/{project_id}/conversations/{conversation_id}':
    'typed as a whole Conversation (Partial), so the TYPE admits read-only fields; callers send the editable ones',
  'PATCH /api/projects/{project_id}/codes/{code_id}':
    'typed as a whole Code (Partial), so the TYPE admits read-only fields; callers send the editable ones',
  'PATCH /api/projects/{project_id}/metrics/{metric_id}':
    'a Record<string, unknown> body — its keys are the caller\'s, not resolvable from the type',
}

/** Requests whose URL is not resolvable by design — `"<file> <url>"` → why. */
const UNRESOLVED_OK: Record<string, string> = {
  'download.ts ${path}': 'downloadFromApi\'s own pass-through: every caller of it is scanned at its own call site',
}

interface Row {
  file: string
  where: string
  method: string
  url: string
  op: string | null
  query: string[]
  queryDynamic: boolean
  body: string[] | null
  bodyDynamic: boolean
}

// ── The scanner ────────────────────────────────────────────────────────────────

const PLANTED = join(API_DIR, '__planted_request_contract__.ts')
const PLANTED_SOURCE = `
import api from './client'
export const plantedApi = {
  badQuery: () => api.get('/projects/1/text-analysis/export', { params: { column_ids: '1', filtersx: '[]' } }),
  goodQuery: () => api.get('/projects/1/text-analysis/export', { params: { column_ids: '1', filters_json: '[]' } }),
  badBody: () => api.post('/projects/1/text-analysis/filtered-frequencies', { column_ids: [1], filterz: [] }),
  dynamicKey: (k: string) => {
    const sp = new URLSearchParams()
    sp.append(k, '1')
    return api.get(\`/projects/1/text-analysis/export?\${sp.toString()}\`)
  },
}
`

function scan(): { real: Row[]; planted: Row[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(FRONTEND, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: d => { throw new Error(String(d.messageText)) },
  })!
  // The walk is `sourceFiles()` (#729): a floor, the tree's identity, no test files.
  const files = sourceFiles({
    ext: 'ts', root: 'lib/api', recursive: false, floor: 25,
    sentinels: ['lib/api/text-analysis.ts', 'lib/api/export.ts', 'lib/api/client.ts'],
  })
  const host = ts.createCompilerHost(parsed.options)
  const baseGet = host.getSourceFile.bind(host)
  host.getSourceFile = (name, lang, onError, create) =>
    name === PLANTED ? ts.createSourceFile(name, PLANTED_SOURCE, lang) : baseGet(name, lang, onError, create)
  const baseExists = host.fileExists.bind(host)
  host.fileExists = name => name === PLANTED || baseExists(name)
  const baseRead = host.readFile.bind(host)
  host.readFile = name => (name === PLANTED ? PLANTED_SOURCE : baseRead(name))
  const program = ts.createProgram([...files, PLANTED], parsed.options, host)
  const checker = program.getTypeChecker()
  const text = (n: ts.Node) => n.getText()

  const routes = Object.keys(ROUTE_PARAMS).map(k => {
    const [method, path] = k.split(' ')
    return { key: k, method, segs: path.split('/').filter(Boolean) }
  })
  function matchOp(clientPath: string, method: string): string | null {
    const segs = clientPath.split('/').filter(Boolean)
    let best: string | null = null
    let bestScore = -1
    for (const r of routes) {
      if (r.method !== method || r.segs.length !== segs.length) continue
      let ok = true
      let score = 0
      for (let i = 0; i < segs.length; i++) {
        const c = segs[i]
        const s = r.segs[i]
        const sParam = s.startsWith('{')
        if (c === '*') { if (sParam) score += 1; continue }
        if (c === s) { score += 2; continue }
        if (sParam) continue
        ok = false
        break
      }
      if (ok && score > bestScore) { best = r.key; bestScore = score }
    }
    return best
  }

  function resolveInit(node: ts.Node): ts.Expression | null {
    if (!ts.isIdentifier(node)) return null
    const decl = checker.getSymbolAtLocation(node)?.valueDeclaration
    return decl && ts.isVariableDeclaration(decl) && decl.initializer ? decl.initializer : null
  }
  function calleeReturn(call: ts.CallExpression): { expr: ts.Expression | null; fn: ts.Node } | null {
    if (!ts.isIdentifier(call.expression)) return null
    const decl = checker.getSymbolAtLocation(call.expression)?.valueDeclaration
    let fn: ts.FunctionLikeDeclaration | null = null
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isArrowFunction(decl.initializer)) fn = decl.initializer
    if (decl && ts.isFunctionDeclaration(decl)) fn = decl
    if (!fn || !fn.body) return null
    if (!ts.isBlock(fn.body)) return { expr: fn.body, fn }
    let ret: ts.Expression | null = null
    const v = (n: ts.Node) => { if (!ret && ts.isReturnStatement(n) && n.expression) ret = n.expression; ts.forEachChild(n, v) }
    v(fn.body)
    return { expr: ret, fn }
  }
  function propsOfType(type: ts.Type): { keys: string[]; dynamic: boolean } {
    const t = checker.getNonNullableType(type)
    if (t.isUnion()) {
      const keys = new Set<string>()
      let dynamic = false
      for (const u of t.types) { const r = propsOfType(u); r.keys.forEach(k => keys.add(k)); dynamic ||= r.dynamic }
      return { keys: [...keys], dynamic }
    }
    const dynamic = !!checker.getIndexInfoOfType(t, ts.IndexKind.String)
    return { keys: t.getProperties().map(p => p.getName()), dynamic }
  }
  /** `include_${key}` where `key` is element 0 of `Object.entries(x).forEach(([key, …]) => …)`. */
  function expandEntriesTemplate(arg: ts.TemplateExpression): string[] | null {
    if (arg.templateSpans.length !== 1) return null
    const span = arg.templateSpans[0]
    if (!ts.isIdentifier(span.expression)) return null
    const decl = checker.getSymbolAtLocation(span.expression)?.valueDeclaration
    if (!decl || !ts.isBindingElement(decl) || !ts.isArrayBindingPattern(decl.parent)) return null
    if (decl.parent.elements.indexOf(decl) !== 0) return null
    const param = decl.parent.parent
    const fn = param?.parent
    const call = fn?.parent
    if (!fn || !ts.isArrowFunction(fn) || !call || !ts.isCallExpression(call)) return null
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'forEach') return null
    const entries = call.expression.expression
    if (!ts.isCallExpression(entries) || text(entries.expression) !== 'Object.entries') return null
    const { keys, dynamic } = propsOfType(checker.getTypeAtLocation(entries.arguments[0]))
    if (dynamic) return null
    return keys.map(k => arg.head.text + k + span.literal.text)
  }
  function literalKeys(arg: ts.Expression): string[] | null {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text]
    if (ts.isTemplateExpression(arg)) return expandEntriesTemplate(arg)
    const t = checker.getTypeAtLocation(arg)
    const parts = t.isUnion() ? t.types : [t]
    if (parts.every(p => p.isStringLiteral())) return parts.map(p => (p as ts.StringLiteralType).value)
    return null
  }
  function searchParamKeys(fn: ts.Node | undefined): { keys: string[]; dynamic: boolean } {
    const keys = new Set<string>()
    let dynamic = false
    if (!fn) return { keys: [], dynamic }
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ['append', 'set'].includes(n.expression.name.text) && n.arguments.length >= 1
        && checker.typeToString(checker.getTypeAtLocation(n.expression.expression)) === 'URLSearchParams') {
        const got = literalKeys(n.arguments[0])
        if (got) got.forEach(k => keys.add(k))
        else dynamic = true
      }
      if (ts.isNewExpression(n) && text(n.expression) === 'URLSearchParams' && n.arguments?.length) {
        // `new URLSearchParams(params as Record<string, string>)`: the keys are the cast's OPERAND's.
        let init: ts.Expression = n.arguments[0]
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
        const r = propsOfType(checker.getTypeAtLocation(init))
        r.keys.forEach(k => keys.add(k))
        dynamic ||= r.dynamic
      }
      ts.forEachChild(n, v)
    }
    v(fn)
    return { keys: [...keys], dynamic }
  }
  const wrapperAdded: string[] = []
  function keysAddedBy(fn: ts.Node) {
    const v = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)
        || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        for (const m of n.text.matchAll(/[?&]([A-Za-z_]\w*)=/g)) wrapperAdded.push(m[1])
      }
      ts.forEachChild(n, v)
    }
    v(fn)
    searchParamKeys(fn).keys.forEach(k => wrapperAdded.push(k))
  }
  function urlText(node: ts.Expression, depth = 0): string {
    if (depth > 4) return '<?>'
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node)) {
      let s = node.head.text
      for (const span of node.templateSpans) {
        const e = span.expression
        const et = text(e)
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
          const r = calleeReturn(e)
          if (r?.expr) { s += urlText(r.expr, depth + 1).replace(/\$\{[^}]*\}/g, '${p}') + span.literal.text; continue }
        }
        // `${qs ? '?' + qs : ''}` / `${flag ? '?k=true' : ''}`: the rest is a query string
        if (/['"`]\?/.test(et)) {
          for (const m of et.matchAll(/[?&]([A-Za-z_]\w*)=/g)) wrapperAdded.push(m[1])
          s += '?${' + et + '}' + span.literal.text
          continue
        }
        s += '${' + et + '}' + span.literal.text
      }
      return s
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const r = calleeReturn(node)
      const a0 = node.arguments[0]
      const a0IsUrl = a0 && (ts.isTemplateExpression(a0) || ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))
        && /\//.test(text(a0))
      if (a0IsUrl && r?.fn) { keysAddedBy(r.fn); return urlText(a0, depth + 1) }
      if (r?.expr) return urlText(r.expr, depth + 1).replace(/\$\{[^}]*\}/g, '${p}')
    }
    if (ts.isIdentifier(node)) {
      const init = resolveInit(node)
      if (init) return urlText(init, depth + 1)
    }
    return '${' + text(node) + '}'
  }
  function enclosingFn(node: ts.Node): ts.Node | undefined {
    let n: ts.Node | undefined = node.parent
    while (n && !ts.isFunctionLike(n)) n = n.parent
    return n
  }

  const rows: Row[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName !== PLANTED && !files.includes(sf.fileName)) continue
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = text(n.expression)
        const m = callee.match(/^api\.(get|post|put|patch|delete)$/)
        if (m || callee === 'downloadFromApi') {
          const method = m ? m[1].toUpperCase() : 'GET'
          wrapperAdded.length = 0
          const url = urlText(n.arguments[0])
          const sent = new Set(wrapperAdded)
          const [rawPath, ...rest] = url.split('?')
          const qs = rest.join('?')
          let queryDynamic = false
          for (const mm of qs.replace(/\$\{[^}]*\}/g, '').matchAll(/(?:^|&)([A-Za-z_]\w*)=/g)) sent.add(mm[1])
          if (/\$\{/.test(qs)) {
            const r = searchParamKeys(enclosingFn(n))
            r.keys.forEach(k => sent.add(k))
            queryDynamic ||= r.dynamic
          }
          const cfgArg = method === 'GET' || method === 'DELETE' ? n.arguments[1] : n.arguments[2]
          if (cfgArg && m) {
            const pSym = checker.getNonNullableType(checker.getTypeAtLocation(cfgArg)).getProperty('params')
            if (pSym) {
              const r = propsOfType(checker.getTypeOfSymbolAtLocation(pSym, cfgArg))
              r.keys.forEach(k => sent.add(k))
              queryDynamic ||= r.dynamic
            }
          }
          let body: string[] | null = null
          let bodyDynamic = false
          if (['POST', 'PUT', 'PATCH'].includes(method) && n.arguments[1]) {
            const bt = checker.getNonNullableType(checker.getTypeAtLocation(n.arguments[1]))
            const symName = bt.getSymbol()?.getName()
            const skip = ['FormData', 'Blob', 'File'].includes(symName ?? '')
              || (bt.flags & ts.TypeFlags.StringLike) !== 0 || checker.isArrayType(bt)
              || (bt.flags & ts.TypeFlags.Undefined) !== 0
            if (!skip) { const r = propsOfType(bt); body = r.keys; bodyDynamic = r.dynamic }
          }
          const clientPath = '/api' + rawPath.replace(/\$\{[^}]*\}/g, '*').replace(/[^/]*\*[^/]*/g, '*')
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart())
          const file = sf.fileName.slice(API_DIR.length + 1)
          rows.push({
            file, where: `${file}:${line + 1}`, method, url,
            op: clientPath === '/api*' ? null : matchOp(clientPath, method),
            query: [...sent], queryDynamic, body, bodyDynamic,
          })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return {
    real: rows.filter(r => !r.file.startsWith('__planted')),
    planted: rows.filter(r => r.file.startsWith('__planted')),
  }
}

/** Each finding, keyed as the exemption tables are. */
function findings(rows: Row[]) {
  const query: { key: string; where: string }[] = []
  const body: { key: string; where: string; fields: string[] }[] = []
  const unresolved: { key: string; where: string }[] = []
  for (const r of rows) {
    if (!r.op) { unresolved.push({ key: `${r.file} ${r.url}`, where: r.where }); continue }
    const route = ROUTE_PARAMS[r.op]
    for (const k of r.query) if (!route.query.includes(k)) query.push({ key: `${r.op} ${k}`, where: r.where })
    if (r.queryDynamic) query.push({ key: `${r.op} <a key the checker cannot resolve>`, where: r.where })
    if (r.body && route.body !== '*') {
      const declared = route.body ?? []
      const extra = r.body.filter(k => !declared.includes(k))
      if (extra.length || r.bodyDynamic) body.push({ key: r.op, where: r.where, fields: r.bodyDynamic ? [...extra, '<index signature>'] : extra })
    }
  }
  return { query, body, unresolved }
}

describe('#1534 D110 — every request sends only names its route declares', () => {
  let real: Row[] = []
  let planted: Row[] = []
  beforeAll(() => {
    ({ real, planted } = scan())
  }, 120_000)

  it('reads the whole client and resolves every request to a route (population floor)', () => {
    expect(existsSync(join(API_DIR, 'route-params.json'))).toBe(true)
    expect(Object.keys(ROUTE_PARAMS).length).toBeGreaterThan(300)
    expect(real.length).toBeGreaterThan(300)
    expect(new Set(real.map(r => r.op).filter(Boolean)).size).toBeGreaterThan(300)
    const unresolved = findings(real).unresolved.filter(u => !(u.key in UNRESOLVED_OK))
    expect(unresolved).toEqual([])
  })

  it('every query key is a name its route declares, or is exempt with a reason', () => {
    const bad = findings(real).query.filter(f => !(f.key in EXEMPT_QUERY))
    expect(bad).toEqual([])
  })

  it('every JSON body field is one its route declares, or the body is exempt with a reason', () => {
    const bad = findings(real).body.filter(f => !(f.key in EXEMPT_BODY))
    expect(bad).toEqual([])
  })

  it('every exemption still names a live finding (a stale one fails)', () => {
    const f = findings(real)
    const live = new Set([...f.query, ...f.body, ...f.unresolved].map(x => x.key))
    const stale = [...Object.keys(EXEMPT_QUERY), ...Object.keys(EXEMPT_BODY), ...Object.keys(UNRESOLVED_OK)]
      .filter(k => !live.has(k))
    expect(stale).toEqual([])
  })

  it('the two #1534 doors now send the route\'s own names (positive control)', () => {
    const exportRow = real.find(r => r.op === 'GET /api/projects/{project_id}/text-analysis/export')!
    expect(exportRow.query).toContain('filters_json')
    expect(exportRow.query).not.toContain('filters')
    const excel = real.find(r => r.op === 'GET /api/projects/{project_id}/export/excel' && r.query.length > 1)!
    expect(excel.query).toContain('include_sources')
    expect(excel.query).not.toContain('include_summaries')
    // The two exports typed `QualCsvParams` for this guard resolve to the routes' names.
    for (const op of [
      'GET /api/projects/{project_id}/code-analysis/source-frequencies/csv',
      'GET /api/projects/{project_id}/code-analysis/demographic-comparison/csv',
    ]) {
      const row = real.find(r => r.op === op)!
      expect(row.queryDynamic).toBe(false)
      expect(row.query).toEqual(expect.arrayContaining(['exclude_facilitator', 'conversation_ids', 'code_ids']))
    }
  })

  it('FALSIFIER — a planted wrong query key, wrong body field and unresolvable key each fail; the right key passes', () => {
    const f = findings(planted)
    expect(f.query.map(x => x.key)).toEqual(expect.arrayContaining([
      'GET /api/projects/{project_id}/text-analysis/export filtersx',
      'GET /api/projects/{project_id}/text-analysis/export <a key the checker cannot resolve>',
    ]))
    expect(f.query.map(x => x.key)).not.toContain('GET /api/projects/{project_id}/text-analysis/export filters_json')
    expect(f.body).toEqual([expect.objectContaining({
      key: 'POST /api/projects/{project_id}/text-analysis/filtered-frequencies', fields: ['filterz'],
    })])
  })
})
