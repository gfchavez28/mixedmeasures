import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import ExcerptEmbedView from './ExcerptEmbedView'

export const ExcerptEmbed = Node.create({
  name: 'excerpt-embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      excerptId:      { default: null },
      displayText:    { default: '' },
      sourceContext:  { default: '' },
      conversationId: { default: null },
      // Slab 5c: a clip embed needs its own source id, or "View Source" cannot
      // render (it keys on conversationId, which a clip never has). Each new
      // attr must appear in ALL THREE places below — addAttributes, parseHTML's
      // getAttrs, and renderHTML — or the HTML round-trip silently drops it.
      observationId:  { default: null },
      materialTag:    { default: null },
      tagNote:        { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="excerpt-embed"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        return {
          excerptId:      dom.getAttribute('data-excerpt-id') ? Number(dom.getAttribute('data-excerpt-id')) : null,
          displayText:    dom.getAttribute('data-display-text') ?? '',
          sourceContext:  dom.getAttribute('data-source-context') ?? '',
          conversationId: dom.getAttribute('data-conversation-id') ? Number(dom.getAttribute('data-conversation-id')) : null,
          observationId:  dom.getAttribute('data-observation-id') ? Number(dom.getAttribute('data-observation-id')) : null,
          materialTag:    dom.getAttribute('data-material-tag') || null,
          tagNote:        dom.getAttribute('data-tag-note') || null,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', {
      'data-type': 'excerpt-embed',
      'data-excerpt-id': HTMLAttributes.excerptId,
      'data-display-text': HTMLAttributes.displayText,
      'data-source-context': HTMLAttributes.sourceContext,
      'data-conversation-id': HTMLAttributes.conversationId,
      'data-observation-id': HTMLAttributes.observationId,
      'data-material-tag': HTMLAttributes.materialTag,
      'data-tag-note': HTMLAttributes.tagNote,
    }, ['blockquote', HTMLAttributes.displayText || '']]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ExcerptEmbedView)
  },
})
