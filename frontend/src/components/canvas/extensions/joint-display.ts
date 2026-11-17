import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import JointDisplayView from './JointDisplayView'

/**
 * The joint display (ROADMAP row 56, D162) — a table on the canvas where each construct's
 * qualitative and quantitative strands sit side by side per group, with the researcher's fit,
 * meta-inference and pinned quotes.
 *
 * It lives IN theme content, on its own node, because everything that protects canvas content
 * already walks theme content — snapshots, the withdrawal scrub, the `.mmproject` remap,
 * search, duplicate-canvas (D162). The server reads the node in four places
 * (`backend/app/services/joint_display_node.py` declares where); this is the client's half.
 *
 * Three attributes, each in all THREE places (this directory's the internal design notes, or the HTML round
 * trip drops it): `displayKey` (a uuid — keys its export table, there is no Material id),
 * `figureEpoch` (the fingerprint generation it was placed under, #1323 D12) and `display`
 * (ONE object holding everything else, `lib/joint-display.ts`; an OBJECT in stored content,
 * a JSON string only across the HTML round trip). `atom`: its cells are edited in the node
 * view, never as editor text, so a cell edit is one `updateAttributes` transaction and the
 * editor's own history undoes it.
 */
export const JointDisplay = Node.create({
  name: 'joint-display',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      displayKey: { default: null },
      figureEpoch: { default: null },
      display: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="joint-display"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        const raw = dom.getAttribute('data-display')
        let display: unknown = null
        if (raw) {
          try { display = JSON.parse(raw) } catch { display = raw }
        }
        return {
          displayKey: dom.getAttribute('data-display-key') || null,
          figureEpoch: dom.getAttribute('data-figure-epoch') ? Number(dom.getAttribute('data-figure-epoch')) : null,
          display,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    const display = HTMLAttributes.display
    return ['figure', {
      'data-type': 'joint-display',
      'data-display-key': HTMLAttributes.displayKey,
      'data-figure-epoch': HTMLAttributes.figureEpoch,
      'data-display': display == null ? null : (typeof display === 'string' ? display : JSON.stringify(display)),
    }, ['span', 'Joint display']]
  },

  addNodeView() {
    return ReactNodeViewRenderer(JointDisplayView)
  },
})
