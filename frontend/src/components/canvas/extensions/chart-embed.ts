import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import ChartEmbedView from './ChartEmbedView'

export const ChartEmbed = Node.create({
  name: 'chart-embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      materialId: { default: null },
      config:           { default: '{}' },
      title:            { default: '' },
      materialTag:      { default: null },
      tagNote:          { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="chart-embed"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        return {
          materialId: dom.getAttribute('data-material-id') ? Number(dom.getAttribute('data-material-id')) : null,
          config:           dom.getAttribute('data-config') ?? '{}',
          title:            dom.getAttribute('data-title') ?? '',
          materialTag:      dom.getAttribute('data-material-tag') || null,
          tagNote:          dom.getAttribute('data-tag-note') || null,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', {
      'data-type': 'chart-embed',
      'data-material-id': HTMLAttributes.materialId,
      'data-config': HTMLAttributes.config,
      'data-title': HTMLAttributes.title,
      'data-material-tag': HTMLAttributes.materialTag,
      'data-tag-note': HTMLAttributes.tagNote,
    }, ['span', HTMLAttributes.title || 'Chart']]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChartEmbedView)
  },
})
