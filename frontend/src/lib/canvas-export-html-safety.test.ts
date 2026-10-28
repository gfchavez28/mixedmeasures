/**
 * #1339 — what the Canvas HTML/PDF export writes is HTML, so every value it
 * interpolates is escaped FOR ITS CONTEXT, and a link keeps its anchor only for
 * a scheme a report may carry.
 *
 * The content reaches the export from three doors, and only one of them is the
 * editor: a `.mmproject` import and the theme-content endpoint store Tiptap JSON
 * as written (`project_portability._remap_canvas_content` rewrites ids and keeps
 * every other attr verbatim). So the export cannot lean on Tiptap's
 * `isAllowedUri` — it checks only a scheme prefix, and never sees imported JSON.
 *
 * ⚠️ The assertions read the PARSED document (DOMParser), not the string: a
 * string assertion can pass on output a browser parses differently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(), frequencies: vi.fn(), saturation: vi.fn(),
    cooccurrence: vi.fn(), demographicComparison: vi.fn(),
  },
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { metricsApi } from '@/lib/api'
import { exportCanvasHtml, exportCanvasMarkdown } from './canvas-export'

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const CANVAS = { id: 1, name: 'Report "Q3" <draft>' } as never

function linkPara(href: unknown, text = 'see here') {
  return { type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }] }
}

function themes(...nodes: unknown[]): CanvasTheme[] {
  return [{ id: 1, name: 'Theme', content: { type: 'doc', content: nodes }, relationships_out: [] } as unknown as CanvasTheme]
}

async function html(nodes: unknown[], pngs = new Map<number, string>()): Promise<Document> {
  const out = await exportCanvasHtml(CANVAS, themes(...nodes), 3, pngs, LENS)
  return new DOMParser().parseFromString(out, 'text/html')
}

/** Every attribute named on* anywhere in the document — an injected handler. */
function handlerAttrs(doc: Document): string[] {
  const found: string[] = []
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) found.push(`${el.tagName}.${a.name}`)
  }
  return found
}

beforeEach(() => {
  vi.mocked(metricsApi.quickCompute).mockReset()
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [] } as never)
})

describe('#1339 — attribute contexts', () => {
  it('a " in a link href cannot open a new attribute', async () => {
    const doc = await html([linkPara('https://example.org/a" onmouseover="alert(1)')])
    expect(handlerAttrs(doc)).toEqual([])
    const a = doc.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.org/a" onmouseover="alert(1)')
  })

  it('a " in a chart title cannot open a new attribute on the image (onload fires on OPEN, no hover needed)', async () => {
    const title = 'Satisfaction "overall" x" onload="alert(1)'
    const doc = await html(
      [{ type: 'chart-embed', attrs: { materialId: 9, title, config: '{}' } }],
      new Map([[9, 'data:image/png;base64,AAAA']]),
    )
    expect(handlerAttrs(doc)).toEqual([])
    expect(doc.querySelector('img')!.getAttribute('alt')).toBe(title)
  })

  it("a memo embed's numericId is text, never markup (it was interpolated UNESCAPED)", async () => {
    const doc = await html([{ type: 'memo-embed', attrs: { numericId: '<img src=x onerror=alert(1)>', title: 'm' } }])
    expect(handlerAttrs(doc)).toEqual([])
    expect(doc.querySelectorAll('.memo img')).toHaveLength(0)
  })

  it('a non-string attr does not crash the whole export', async () => {
    await expect(html([{ type: 'chart-embed', attrs: { materialId: 9, title: 42, config: '{}' } }])).resolves.toBeTruthy()
    await expect(html([linkPara({ evil: true })])).resolves.toBeTruthy()
  })

  it('CONTROL: an ordinary title and https link survive unchanged', async () => {
    const doc = await html(
      [linkPara('https://example.org/?a=1&b=2'), { type: 'chart-embed', attrs: { materialId: 9, title: 'Mean & SD', config: '{}' } }],
      new Map([[9, 'data:image/png;base64,AAAA']]),
    )
    expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.org/?a=1&b=2')
    expect(doc.querySelector('img')!.getAttribute('alt')).toBe('Mean & SD')
    expect(doc.querySelector('h1')!.textContent).toBe('Report "Q3" <draft>')
  })
})

describe('#1339 — the scheme allow-list', () => {
  const REFUSED = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\u0001javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    // DECISION (developer): a scheme-less href resolves against the downloaded
    // FILE, so it leads nowhere; the words are kept, the anchor is not.
    'www.example.org',
    '#section-2',
  ]
  for (const href of REFUSED) {
    it(`drops the anchor and keeps the words for ${JSON.stringify(href)}`, async () => {
      const doc = await html([linkPara(href)])
      expect(doc.querySelectorAll('a')).toHaveLength(0)
      expect(doc.body.textContent).toContain('see here')
    })
  }

  for (const href of ['https://example.org', 'http://example.org/x', 'mailto:pi@example.org', 'HTTPS://EXAMPLE.ORG', ' https://example.org/pasted ']) {
    it(`CONTROL: keeps the anchor for ${href}`, async () => {
      const doc = await html([linkPara(href)])
      expect(doc.querySelector('a')!.getAttribute('href')).toBe(href)
    })
  }

  it('the Markdown export applies the same predicate (a refused link is its words)', async () => {
    const md = await exportCanvasMarkdown(CANVAS, themes(linkPara('javascript:alert(1)'), linkPara('https://example.org', 'ok')), 3, LENS)
    expect(md).not.toContain('javascript:')
    expect(md).toContain('see here')
    expect(md).toContain('[ok](https://example.org)')
  })
})

describe('#1339 — the exported file states its own script policy', () => {
  it('carries a CSP meta that forbids script, so a missed escape cannot run', async () => {
    const doc = await html([linkPara('https://example.org')])
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(meta).not.toBeNull()
    expect(meta!.getAttribute('content')).toMatch(/default-src 'none'/)
    expect(meta!.getAttribute('content')).not.toMatch(/script-src|unsafe-eval/)
    // it must come before any content it guards
    const kids = Array.from(doc.head.children)
    expect(kids.indexOf(meta!)).toBeLessThan(kids.findIndex(k => k.tagName === 'STYLE'))
  })

  it('the PDF path builds its document with the same policy (source pin: printHtmlDocument needs a real iframe)', async () => {
    const src = (await import('./canvas-export.ts?raw')).default as string
    const heads = src.match(/<!DOCTYPE html>[\s\S]*?<\/head>/g) ?? []
    expect(heads.length).toBe(2)
    for (const h of heads) expect(h).toContain('${EXPORT_CSP_META}')
  })
})
