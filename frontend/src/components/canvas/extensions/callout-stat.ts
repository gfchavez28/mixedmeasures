import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import CalloutStatView from './CalloutStatView'

export const CalloutStat = Node.create({
  name: 'callout-stat',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      value:             { default: '' },
      label:             { default: '' },
      sourceDescription: { default: null },
      materialTag:       { default: null },
      tagNote:           { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="callout-stat"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        return {
          value:             dom.getAttribute('data-value') ?? '',
          label:             dom.getAttribute('data-label') ?? '',
          sourceDescription: dom.getAttribute('data-source-description') || null,
          materialTag:       dom.getAttribute('data-material-tag') || null,
          tagNote:           dom.getAttribute('data-tag-note') || null,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', {
      'data-type': 'callout-stat',
      'data-value': HTMLAttributes.value,
      'data-label': HTMLAttributes.label,
      'data-source-description': HTMLAttributes.sourceDescription,
      'data-material-tag': HTMLAttributes.materialTag,
      'data-tag-note': HTMLAttributes.tagNote,
    }, ['span', `${HTMLAttributes.value || ''} ${HTMLAttributes.label || ''}`]]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutStatView)
  },
})
