/**
 * #1422 — the Canvas Markdown export wrote user text into Markdown unescaped: a quote holding a
 * blank line left its blockquote (the participant's later paragraphs read as the researcher's
 * prose), a `|` added a table column, `2020. ` made a list, `# ` a heading, `<Trust>` vanished,
 * and a link's DESTINATION could close itself and open a `javascript:` link past #1339.
 * #1457 (Markdown + HTML) — an @mention and a Shift+Enter line break vanished.
 *
 * ⚠️ The frontend has no Markdown renderer, so these assertions are on the Markdown TEXT; each
 * expected form was rendered with markdown-it (CommonMark + GFM tables) in the review
 * (2026-11-13g, r1) and printed the input's own characters. The HTML half reads the PARSED
 * document, as `canvas-export-html-safety.test.ts` does.
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
import { reportToMarkdown, type JointDisplayReport } from './joint-display-report'

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const NO_NAMES = () => null
const CANVAS = { id: 1, name: 'Canvas' } as never

const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const br = { type: 'hardBreak' }
const link = (href: string) => [{ type: 'link', attrs: { href } }]
const item = (...content: unknown[]) => ({ type: 'listItem', content })

function themes(nodes: unknown[], name = 'Theme', relationships: unknown[] = []): CanvasTheme[] {
  return [
    { id: 1, name, content: { type: 'doc', content: nodes }, relationships_out: relationships } as unknown as CanvasTheme,
    { id: 2, name: 'Other', content: null, relationships_out: [] } as unknown as CanvasTheme,
  ]
}

/** The theme's body: what follows `## Theme`, up to the next section. */
async function md(nodes: unknown[]): Promise<string> {
  const out = await exportCanvasMarkdown(CANVAS, themes(nodes), 3, LENS, NO_NAMES)
  return out.split('## Theme\n\n')[1].split('\n\n## Other')[0]
}

async function html(nodes: unknown[]): Promise<Document> {
  const out = await exportCanvasHtml(CANVAS, themes(nodes), 3, new Map(), LENS, NO_NAMES)
  return new DOMParser().parseFromString(out, 'text/html')
}

/** CommonMark's backslash escape, undone: what a renderer prints for escaped plain text. */
const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1')

beforeEach(() => {
  vi.mocked(metricsApi.quickCompute).mockReset()
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [] } as never)
})

describe('#1422 — a quote stays a quote', () => {
  const quote = (displayText: string, more: Record<string, unknown> = {}) =>
    ({ type: 'excerpt-embed', attrs: { displayText, sourceContext: 'P3 · Interview 2', ...more } })

  it("a participant's second paragraph is INSIDE the blockquote, and so are the attribution and tag", async () => {
    const out = await md([quote('first para\n\nsecond para', { materialTag: 'confirms' })])
    expect(out).toBe('> "first para\n>\n> second para"\n>\n> *\u2014 P3 · Interview 2*\n>\n> Tag: confirms')
    for (const line of out.split('\n')) expect(line.startsWith('>')).toBe(true)
  })

  it('a single line break in a quote is a hard break inside it', async () => {
    expect(await md([quote('line one\nline two')])).toBe('> "line one\\\n> line two"\n>\n> *\u2014 P3 · Interview 2*')
  })

  it('a quote line cannot start a block inside the quote', async () => {
    expect(await md([quote('ok\n\n# not a heading\n\n2020. not a list')])).toContain('> \\# not a heading\n>\n> 2020\\. not a list"')
  })

  it('HTML: the quote keeps its paragraphs and its single line break', async () => {
    const doc = await html([quote('first para\n\nsecond para\nsame para')])
    const ps = Array.from(doc.querySelectorAll('blockquote.excerpt > p'))
    expect(ps.map(e => e.textContent)).toEqual(['"first para', 'second parasame para"'])
    expect(ps[1].querySelectorAll('br')).toHaveLength(1)
  })
})

describe('#1422 — user text is text, never markup', () => {
  // [typed, the Markdown it must become]; every row renders (markdown-it) as `typed`.
  const CASES: [string, string][] = [
    ['2020. was the year', '2020\\. was the year'],
    ['1) a list', '1\\) a list'],
    ['# not a heading', '\\# not a heading'],
    ['- not a bullet', '\\- not a bullet'],
    ['+ not a bullet', '\\+ not a bullet'],
    ['> not a quote', '\\> not a quote'],
    ['---', '\\---'],
    ['===', '\\==='],
    ['a * b * c', 'a \\* b \\* c'],
    ['`tick`', '\\`tick\\`'],
    ['<Trust> matters', '\\<Trust> matters'],
    ['[x](https://example.org)', '\\[x\\](https://example.org)'],
    ['~~kept~~', '\\~\\~kept\\~\\~'],
    ['&copy; 2020', '\\&copy; 2020'],
    ['a | b', 'a \\| b'],
    ['back\\slash', 'back\\\\slash'],
    ['_em_ word', '\\_em\\_ word'],
    // CONTROLS: what CommonMark would not read stays as typed (a raw .md stays readable).
    ['apollo11_interview', 'apollo11_interview'],
    ['p < .001, x > 3, AT&T', 'p < .001, x > 3, AT&T'],
    ['-5 degrees, 3.5 points', '-5 degrees, 3.5 points'],
  ]
  for (const [typed, want] of CASES) {
    it(`a paragraph typed ${JSON.stringify(typed)}`, async () => {
      const out = await md([p(t('Before.')), p(t(typed))])
      expect(out).toBe(`Before.\n\n${want}`)
      expect(unescape(want)).toBe(typed)
    })
  }

  it('four leading spaces do not make a code block', async () => {
    expect(await md([p(t('Before.')), p(t('    indented'))])).toBe('Before.\n\nindented')
  })

  it("emphasis keeps its edge spaces OUTSIDE (`**bold **next` printed its asterisks)", async () => {
    expect(await md([p(t('bold ', [{ type: 'bold' }]), t('next, '), t(' it', [{ type: 'italic' }]), t('.'))]))
      .toBe('**bold** next,  *it*.')
  })

  it('link text with a bracket stays one link', async () => {
    expect(await md([p(t('see ] here', link('https://example.org/a')))])).toBe('[see \\] here](<https://example.org/a>)')
  })

  it('2026-10-29 addendum: a destination cannot close itself and open a javascript: link', async () => {
    const out = await md([p(t('click', link('https://x.example/) [evil](javascript:alert(1)')))])
    expect(out).toBe('[click](<https://x.example/) [evil](javascript:alert(1)>)')
    // ONE link: CommonMark's pointy destination — no line break, no unescaped `<` or `>` — up
    // to the end, so the `](javascript:` inside it is the href's text (rendered: one https href).
    expect(out).toMatch(/^\[click\]\(<(?:[^<>\\\n]|\\.)*>\)$/)
    const close = (s: string) => s.replace(/<[^>]*>/g, '')
    expect(close(out)).not.toMatch(/javascript:/i)
    expect(await md([p(t('spaced', link('https://example.org/a b')))])).toBe('[spaced](<https://example.org/a b>)')
  })

  it('canvas and theme names: `_draft_`, `<x>` and a trailing ` #` are text', async () => {
    const out = await exportCanvasMarkdown(
      { id: 1, name: 'Report _draft_ <x>' } as never, themes([p(t('x'))], 'Question #'), 3, LENS, NO_NAMES,
    )
    expect(out.startsWith('# Report \\_draft\\_ \\<x>\n\n## Question \\#\n\n')).toBe(true)
  })

  it('a table cell with a `|` and a newline stays ONE cell in ONE row', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({
      metrics: [{ id: 1, name: 'Trust | care\nline 2', metric_type: 'mean', input_source_id: 1, input_source_type: 'dataset_column',
        results: [{ group_value: null, valid_n: 5, result_data: { mean: 3.2 } }] }],
    } as never)
    const out = await md([{ type: 'chart-embed', attrs: { materialId: 1, title: 'Chart *x*', config: JSON.stringify({ column_ids: [1], metric_type: 'mean', chart_type: 'horizontal_bar' }) } }])
    expect(out).toContain('**Chart \\*x\\***\n\n| Metric | Value | N |\n| --- | --- | --- |\n| Trust \\| care line 2 | 3.2 | 5 |')
  })

  it('every embed attr and relationship label is escaped where it enters', async () => {
    const out = await exportCanvasMarkdown(CANVAS, themes([
      { type: 'memo-embed', attrs: { numericId: 4, title: 'Memo *one*', preview: 'para\n\n# second', materialTag: 'a|b' } },
      { type: 'callout-stat', attrs: { value: '', label: '# of people', sourceDescription: 'Survey *2020*' } },
      { type: 'image-embed', attrs: { alt: 'a ] b *c*' } },
      { type: 'excerpt-embed', attrs: { displayText: 'ok', sourceContext: 'P*1*', materialTag: '<x>' } },
    ], 'Theme', [{ id: 1, source_theme_id: 1, target_theme_id: 2, relationship_type: 'custom', label: '*why* | how', is_bidirectional: false }]), 3, LENS, NO_NAMES)
    expect(out).toContain('**Memo M-4: Memo \\*one\\***\n\npara\n\n\\# second\n\nTag: a\\|b')
    expect(out).toContain('\\# of people\n\n*Source: Survey \\*2020\\**')
    expect(out).toContain('*[Image: a ] b \\*c\\*]*')
    expect(out).toContain('> *\u2014 P\\*1\\**\n>\n> Tag: \\<x>')
    expect(out).toContain('- Theme \u2192 Other: \\*why\\* \\| how')
  })

  it('a whole string keeps its brackets unless they could make a link, a reference or a task box', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({
      metrics: [{ id: 1, name: 'CI [17.0, 82.3]; x](javascript:y)', metric_type: 'mean', input_source_id: 1, input_source_type: 'dataset_column',
        results: [{ group_value: null, valid_n: 5, result_data: { mean: 3.2 } }] }],
    } as never)
    const out = await exportCanvasMarkdown(CANVAS, themes([
      { type: 'excerpt-embed', attrs: { displayText: 'It was [laughs] fine.\n\n[1]: https://example.org' } },
      { type: 'chart-embed', attrs: { materialId: 1, title: 'T', config: JSON.stringify({ column_ids: [1], metric_type: 'mean', chart_type: 'horizontal_bar' }) } },
    ], '[ ] todo', [{ id: 1, source_theme_id: 1, target_theme_id: 2, relationship_type: 'custom', label: '', is_bidirectional: false }]), 3, LENS, NO_NAMES)
    expect(out).toContain('> "It was [laughs] fine.\n>\n> [1\\]: https://example.org"')
    expect(out).toContain('| CI [17.0, 82.3]; x\\](javascript:y) | 3.2 | 5 |')
    expect(out).toContain('- \\[ ] todo → Other')
  })

  it("the joint display's Markdown uses the SAME escape (cells, title, note)", () => {
    const report: JointDisplayReport = {
      title: 'Display *one*', message: null, headers: ['Construct', 'A'],
      rows: [{ kind: 'construct', construct: '*Trust*', cells: ['<Trust> | x'] } as never],
      note: 'Scope: coders: _me_.', appendix: [],
    }
    const out = reportToMarkdown(report)
    expect(out).toContain('**Display \\*one\\***')
    expect(out).toContain('| \\*Trust\\* | \\<Trust> \\| x |')
    expect(out).toContain('Scope: coders: \\_me\\_.')
  })

  it('CONTROL: ordinary prose, bold, italics, a quote and a list are byte-identical to before', async () => {
    expect(await md([
      p(t('Plain words, 3.5 points. '), t('Bold', [{ type: 'bold' }]), t(' and '), t('italic', [{ type: 'italic' }]), t('.')),
      { type: 'bulletList', content: [item(p(t('one'))), item(p(t('two')))] },
      { type: 'excerpt-embed', attrs: { displayText: 'It helped.' } },
    ])).toBe('Plain words, 3.5 points. **Bold** and *italic*.\n\n- one\n- two\n\n> "It helped."')
  })
})

describe('#1457 — @mentions and Shift+Enter line breaks', () => {
  const mention = { type: 'mention', attrs: { id: '7', label: 'Barriers', mentionSuggestionChar: '@' } }

  it('Markdown: a mention prints `@` and its label', async () => {
    expect(await md([p(t('as '), mention, t(' shows'))])).toBe('as @Barriers shows')
  })

  it('Markdown: a hard break in a paragraph, a list item, a quote; a heading joins with a space', async () => {
    expect(await md([p(t('line A'), br, t('line B'))])).toBe('line A\\\nline B')
    expect(await md([{ type: 'bulletList', content: [item(p(t('item A'), br, t('item A2')))] }])).toBe('- item A\\\n  item A2')
    expect(await md([{ type: 'blockquote', content: [p(t('q 1'), br, t('q 2'))] }])).toBe('> q 1\\\n> q 2')
    expect(await md([{ type: 'heading', attrs: { level: 1 }, content: [t('Head A'), br, t('Head B')] }])).toBe('### Head A Head B')
  })

  it('Markdown: a break cannot start a block, and a TRAILING break prints no backslash', async () => {
    expect(await md([p(t('line A'), br, t('# line B'))])).toBe('line A\\\n\\# line B')
    expect(await md([p(t('ends here'), br)])).toBe('ends here')
  })

  it("Markdown: a list item's second paragraph and its nested list stay in the item", async () => {
    expect(await md([{ type: 'orderedList', content: [item(p(t('para 1')), p(t('para 2')), { type: 'bulletList', content: [item(p(t('child')))] })] }]))
      .toBe('1. para 1\n\n   para 2\n\n   - child')
  })

  it('HTML: a mention is its label, and a break is a <br> in a paragraph, list item, quote and heading', async () => {
    const doc = await html([
      p(t('as '), mention, t(' shows')),
      p(t('a'), br, t('b')),
      { type: 'bulletList', content: [item(p(t('c'), br, t('d')))] },
      { type: 'blockquote', content: [p(t('e'), br, t('f'))] },
      { type: 'heading', attrs: { level: 1 }, content: [t('g'), br, t('h')] },
    ])
    expect(doc.body.textContent).toContain('as @Barriers shows')
    for (const sel of ['p:nth-of-type(2)', 'li > p', 'blockquote > p', 'h3']) {
      expect(doc.querySelectorAll(`${sel} br`).length, sel).toBe(1)
    }
  })

  it('a mention with no label prints its id (`label ?? id`, as Tiptap and the Word export do)', async () => {
    const bare = { type: 'mention', attrs: { id: '7', label: null } }
    expect(await md([p(t('see '), bare)])).toBe('see @7')
    expect((await html([p(t('see '), bare)])).body.textContent).toContain('see @7')
  })
})

describe('the formats agree with the Word export — underline and a list\'s first number', () => {
  const ol = (start: unknown, n = 2) =>
    ({ type: 'orderedList', attrs: { start }, content: Array.from({ length: n }, (_, i) => item(p(t(`item ${i}`)))) })

  it('underline: <u> in HTML; plain words in Markdown (r1-9 — no syntax, and inline HTML can print as tags)', async () => {
    const node = p(t('under', [{ type: 'underline' }]), t(' and '), t('both', [{ type: 'underline' }, { type: 'bold' }]))
    expect((await html([node])).querySelector('u')?.textContent).toBe('under')
    expect((await html([node])).querySelectorAll('strong > u, u > strong')).toHaveLength(1)
    expect(await md([node])).toBe('under and **both**')
  })

  it('an ordered list counts from its start: Markdown `3.`/`4.`, HTML <ol start="3">', async () => {
    expect(await md([ol(3)])).toBe('3. item 0\n4. item 1')
    expect((await html([ol(3)])).querySelector('ol')!.getAttribute('start')).toBe('3')
    expect(await md([ol(0)])).toBe('0. item 0\n1. item 1')
    expect((await html([ol(0)])).querySelector('ol')!.getAttribute('start')).toBe('0')
  })

  // r2's `_new_numbering`: a non-negative int, else 1 (a bool is not an int there).
  for (const bad of [-2, 2.5, '3', true, null, undefined, Number.NaN]) {
    it(`a malformed start (${String(bad)}) counts from 1, as in Word`, async () => {
      expect(await md([ol(bad)])).toBe('1. item 0\n2. item 1')
      expect((await html([ol(bad)])).querySelector('ol')!.hasAttribute('start')).toBe(false)
    })
  }

  it('a start CommonMark cannot hold (a marker past nine digits) counts from 1 in Markdown only', async () => {
    expect(await md([ol(999_999_999, 2)])).toBe('1. item 0\n2. item 1')
    expect(await md([ol(999_999_998, 2)])).toBe('999999998. item 0\n999999999. item 1')
    expect((await html([ol(999_999_999, 2)])).querySelector('ol')!.getAttribute('start')).toBe('999999999')
  })
})
