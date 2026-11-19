/**
 * #1670 D348 — a joint display that arrives by paste or drop gets a fresh `displayKey`.
 *
 * Driven through ProseMirror's OWN clipboard pipeline (the editor's serializer, then
 * `view.pasteHTML`, which runs parseFromClipboard and the `transformPasted` props), on the real
 * node with its view stripped (insert-block-1341.test.ts's pattern). A drop runs the same
 * `transformPasted` prop (prosemirror-view's `handleDrop`), asked here through `someProp`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import { JointDisplay, rekeyArrivingDisplays } from './joint-display'

const JD = (JointDisplay as AnyExtension).extend({ addNodeView: () => null })
let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null })

const DISPLAY = { title: 'Original', group_by_column_id: 7, rows: [{ key: 'r1', construct: 'Trust' }] }

function make() {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, link: false }), JD],
    content: {
      type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'joint-display', attrs: { displayKey: 'key-A', figureEpoch: 3, display: DISPLAY } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    },
  })
  return editor
}

function displays(ed: Editor) {
  const out: { displayKey: string | null; figureEpoch: number | null; display: typeof DISPLAY }[] = []
  ed.state.doc.descendants(n => {
    if (n.type.name === 'joint-display') out.push(n.attrs as (typeof out)[number])
  })
  return out
}

function copyDisplayHtml(ed: Editor): string {
  let pos = -1
  ed.state.doc.descendants((n, p) => { if (n.type.name === 'joint-display' && pos < 0) pos = p })
  ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, pos)))
  return ed.view.serializeForClipboard(ed.state.selection.content()).dom.innerHTML as string
}

function pasteAtEnd(ed: Editor, html: string) {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.atEnd(ed.state.doc)))
  ed.view.pasteHTML(html, new Event('paste') as ClipboardEvent)
}

describe('#1670 D348 — a pasted or dropped joint display gets its own key', () => {
  it('CONTROL: the clipboard carries the key, so the parser alone would keep it', () => {
    const ed = make()
    expect(copyDisplayHtml(ed)).toContain('data-display-key="key-A"')
  })

  it('copy + paste: two displays, two keys; everything else in the copy is kept', () => {
    const ed = make()
    pasteAtEnd(ed, copyDisplayHtml(ed))
    const [original, copy] = displays(ed)
    expect(displays(ed)).toHaveLength(2)
    expect(original.displayKey).toBe('key-A')
    expect(copy.displayKey).toBeTruthy()
    expect(copy.displayKey).not.toBe('key-A')
    expect(copy.figureEpoch).toBe(3)
    expect(copy.display).toEqual(DISPLAY) // row keys unchanged (D348)
  })

  it('two pastes of one copy: three distinct keys', () => {
    const ed = make()
    const html = copyDisplayHtml(ed)
    pasteAtEnd(ed, html)
    pasteAtEnd(ed, html)
    expect(new Set(displays(ed).map(d => d.displayKey)).size).toBe(3)
  })

  it('a drop runs the same prop: the editor re-keys a dragged slice', () => {
    const ed = make()
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'joint-display') pos = p })
    let slice = new Slice(Fragment.from(ed.state.doc.nodeAt(pos)!), 0, 0)
    ed.view.someProp('transformPasted', f => { slice = f(slice, ed.view, false) })
    expect(slice.content.firstChild!.attrs.displayKey).not.toBe('key-A')
  })

  it('reaches a display nested in another block, and leaves a slice with none untouched', () => {
    const ed = make()
    const schema = ed.schema
    const jd = schema.nodes['joint-display'].create({ displayKey: 'key-N', figureEpoch: 1, display: DISPLAY })
    const quote = schema.nodes.blockquote.create(null, [jd])
    const nested = rekeyArrivingDisplays(new Slice(Fragment.from(quote), 0, 0), () => 'fresh')
    expect(nested.content.firstChild!.firstChild!.attrs.displayKey).toBe('fresh')

    const prose = new Slice(Fragment.from(schema.nodes.paragraph.create(null, schema.text('hi'))), 0, 0)
    expect(rekeyArrivingDisplays(prose, () => 'fresh')).toBe(prose)
  })
})
