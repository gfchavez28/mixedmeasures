/**
 * #1341 — two Materials inserts in a row left only the second.
 *
 * A headless Tiptap editor with the canvas's REAL embed nodes (their node views stripped — the
 * schema is what decides selection) and the Writing editor's StarterKit settings. The first
 * case is the CONTROL: Tiptap's `insertContent` — the old door — on this exact schema and
 * version, so a later Tiptap that stopped node-selecting an inserted atom would show here
 * rather than leave the other cases proving nothing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, type AnyExtension, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { ExcerptEmbed, ChartEmbed, MemoEmbed, CalloutStat, ImageEmbed, JointDisplay } from './extensions'
import { placeBlock } from './insert-block'

const EMBEDS = [ExcerptEmbed, ChartEmbed, MemoEmbed, CalloutStat, ImageEmbed, JointDisplay]
  .map(ext => (ext as AnyExtension).extend({ addNodeView: () => null }))

let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null })

function make(content: JSONContent): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, code: false, link: false }),
      ...EMBEDS,
    ],
    content,
  })
  return editor
}

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const p = (text?: string): JSONContent => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' })
const chart = (id: number) => ({ type: 'chart-embed', attrs: { materialId: id, title: `Chart ${id}` } })

/** The door, as `ThemeEditor.insertWithPendingSlash` runs it after #1341. */
function insert(ed: Editor, node: { type: string; attrs: Record<string, unknown> }, pending?: { from: number; to: number }) {
  let chain = ed.chain().focus()
  if (pending) chain = chain.deleteRange(pending)
  chain.command(({ tr }) => { placeBlock(tr, tr.doc.type.schema.nodeFromJSON(node)); return true }).run()
}

/** The document as `type` / `type:materialId` / `p:text`, in order (one level into lists). */
function shape(ed: Editor): string[] {
  const out: string[] = []
  ed.state.doc.forEach(n => {
    if (n.type.name === 'paragraph') out.push(`p:${n.textContent}`)
    else if (n.type.name === 'chart-embed') out.push(`chart:${n.attrs.materialId}`)
    else if (n.type.name === 'bulletList') {
      n.forEach(li => li.forEach(c => out.push(`li>${c.type.name === 'paragraph' ? `p:${c.textContent}` : `${c.type.name}:${c.attrs.materialId ?? ''}`}`)))
    } else out.push(n.type.name)
  })
  return out
}

/** Place the caret at the end of the first paragraph whose text is `text`. */
function caretAfterText(ed: Editor, text: string, offset = text.length) {
  let at = -1
  ed.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isTextblock && n.textContent === text) at = pos + 1 + offset
    return at < 0
  })
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at)))
}

describe('#1341 — inserting a block embed', () => {
  it('CONTROL: the old door (`insertContent`) node-selects the embed, and the next insert replaces it', () => {
    const ed = make(doc(p()))
    ed.chain().focus().insertContent(chart(1)).run()
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
    ed.chain().focus().insertContent(chart(2)).run()
    expect(shape(ed).filter(s => s.startsWith('chart'))).toEqual(['chart:2'])
  })

  it('two inserts in an empty theme leave both, in order, with the caret after them', () => {
    const ed = make(doc(p()))
    insert(ed, chart(1))
    expect(ed.state.selection).toBeInstanceOf(TextSelection)
    insert(ed, chart(2))
    expect(shape(ed)).toEqual(['chart:1', 'chart:2', 'p:'])
    expect(ed.state.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('after prose, and in the middle of a paragraph, nothing is lost and the text keeps its order', () => {
    const ed = make(doc(p('Hello'), p('Before after')))
    caretAfterText(ed, 'Hello')
    insert(ed, chart(1))
    insert(ed, chart(2))
    caretAfterText(ed, 'Before after', 'Before'.length)
    insert(ed, chart(3))
    insert(ed, chart(4))
    // The caret lands in the textblock already after the embed — no empty paragraph is made.
    expect(shape(ed)).toEqual(['p:Hello', 'chart:1', 'chart:2', 'p:Before', 'chart:3', 'chart:4', 'p: after'])
  })

  it('a node-selected embed (one the researcher clicked) is never replaced — the new one goes after it', () => {
    const ed = make(doc(p('Intro'), chart(1), p('Outro')))
    let pos = -1
    ed.state.doc.forEach((n, offset) => { if (n.type.name === 'chart-embed') pos = offset })
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, pos)))
    insert(ed, chart(2))
    expect(shape(ed)).toEqual(['p:Intro', 'chart:1', 'chart:2', 'p:Outro'])
  })

  it('typing straight after an insert does not replace the embed', () => {
    const ed = make(doc(p()))
    insert(ed, chart(1))
    ed.view.dispatch(ed.state.tr.insertText('x'))
    expect(shape(ed)).toEqual(['chart:1', 'p:x'])
  })

  it('inside a list item, both embeds stay in the item and the list survives', () => {
    const ed = make(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p('item')] }] }))
    caretAfterText(ed, 'item')
    insert(ed, chart(1))
    insert(ed, chart(2))
    // (The last `p:` is StarterKit 3's trailing node, there before the inserts.)
    expect(shape(ed)).toEqual(['li>p:item', 'li>chart-embed:1', 'li>chart-embed:2', 'li>p:', 'p:'])
  })

  it('a typed `/chart` is still consumed by the insert it asked for', () => {
    const ed = make(doc(p('Notes /chart')))
    let from = -1
    ed.state.doc.descendants((n, pos) => { if (from < 0 && n.isText) from = pos + 'Notes '.length; return from < 0 })
    caretAfterText(ed, 'Notes /chart')
    insert(ed, chart(1), { from, to: from + '/chart'.length })
    insert(ed, chart(2))
    expect(shape(ed)).toEqual(['p:Notes ', 'chart:1', 'chart:2', 'p:'])
  })

  it('a pasted image (the plugin door) at the end of a theme does not replace the one before it', () => {
    const ed = make(doc(p('Text')))
    caretAfterText(ed, 'Text')
    const image = (id: string) => ed.state.schema.nodes['image-embed'].create({ imageId: id })
    ed.view.dispatch(placeBlock(ed.state.tr, image('a')))
    ed.view.dispatch(placeBlock(ed.state.tr, image('b')))
    const ids: string[] = []
    ed.state.doc.forEach(n => { if (n.type.name === 'image-embed') ids.push(n.attrs.imageId) })
    expect(ids).toEqual(['a', 'b'])
  })
})
