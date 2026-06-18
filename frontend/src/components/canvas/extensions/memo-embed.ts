import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import MemoEmbedView from './MemoEmbedView'

export const MemoEmbed = Node.create({
  name: 'memo-embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      memoId:      { default: null },
      numericId:   { default: null },
      title:       { default: '' },
      preview:     { default: '' },
      materialTag: { default: null },
      tagNote:     { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="memo-embed"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        return {
          memoId:      dom.getAttribute('data-memo-id') ? Number(dom.getAttribute('data-memo-id')) : null,
          numericId:   dom.getAttribute('data-numeric-id') ? Number(dom.getAttribute('data-numeric-id')) : null,
          title:       dom.getAttribute('data-title') ?? '',
          preview:     dom.getAttribute('data-preview') ?? '',
          materialTag: dom.getAttribute('data-material-tag') || null,
          tagNote:     dom.getAttribute('data-tag-note') || null,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', {
      'data-type': 'memo-embed',
      'data-memo-id': HTMLAttributes.memoId,
      'data-numeric-id': HTMLAttributes.numericId,
      'data-title': HTMLAttributes.title,
      'data-preview': HTMLAttributes.preview,
      'data-material-tag': HTMLAttributes.materialTag,
      'data-tag-note': HTMLAttributes.tagNote,
    }, ['span', HTMLAttributes.title || 'Memo']]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MemoEmbedView)
  },
})
