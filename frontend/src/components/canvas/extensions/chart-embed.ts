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
      // #808 — the figure baseline. Three attrs, and per this directory's
      // the internal design notes every one must appear in all THREE places below or the HTML
      // round-trip drops it silently.
      //
      // `figureHash` fingerprints the numbers this embed DREW; `figureHeadline`
      // is the one figure worth showing a before/after for; `figureStampedAt`
      // is when the researcher last accepted them. Absent = no baseline = no
      // claim, which is the honest state for every embed inserted before this.
      figureHash:       { default: null },
      figureHeadline:   { default: null },
      figureStampedAt:  { default: null },
      // #1323 D12 — the fingerprint GENERATION the embed was placed under
      // (`figure-baseline.ts::CURRENT_FIGURE_EPOCH`, written by
      // `ThemeEditor.insertChart`, the one door). Absent = placed before it existed
      // (read as 0), so an embed of a kind that gained its fingerprint later can
      // say its figures changed instead of silently adopting them.
      figureEpoch:      { default: null },
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
          figureHash:       dom.getAttribute('data-figure-hash') || null,
          figureHeadline:   dom.getAttribute('data-figure-headline') || null,
          figureStampedAt:  dom.getAttribute('data-figure-stamped-at') || null,
          figureEpoch:      dom.getAttribute('data-figure-epoch') ? Number(dom.getAttribute('data-figure-epoch')) : null,
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
      'data-figure-hash': HTMLAttributes.figureHash,
      'data-figure-headline': HTMLAttributes.figureHeadline,
      'data-figure-stamped-at': HTMLAttributes.figureStampedAt,
      'data-figure-epoch': HTMLAttributes.figureEpoch,
    }, ['span', HTMLAttributes.title || 'Chart']]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChartEmbedView)
  },
})
