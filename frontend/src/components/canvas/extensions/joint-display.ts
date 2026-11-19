import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import JointDisplayView from './JointDisplayView'
import { newRowKey } from '@/lib/joint-display'

const NODE_NAME = 'joint-display'

function rekeyFragment(fragment: Fragment, mint: () => string): Fragment {
  let changed = false
  const children: PMNode[] = []
  fragment.forEach(child => {
    let next = child
    if (child.type.name === NODE_NAME) {
      next = child.type.create({ ...child.attrs, displayKey: mint() }, child.content, child.marks)
    } else if (child.content.size > 0) {
      const inner = rekeyFragment(child.content, mint)
      if (inner !== child.content) next = child.copy(inner)
    }
    if (next !== child) changed = true
    children.push(next)
  })
  return changed ? Fragment.fromArray(children) : fragment
}

/**
 * #1670 D348 — every joint display that ARRIVES by paste or drop gets a fresh `displayKey`.
 *
 * `/joint` → the builder is the one door that MINTS a display; a paste, a copy-drag and a drop
 * from another section are a second door that kept the copied key, so two nodes shared the
 * export table, the dialog registry (`display-store.ts`), the view switch's radio group and the
 * kept state. ProseMirror runs `transformPasted` on a paste AND a drop (an in-editor move
 * included), so a move re-keys too — harmless: the key holds only the export lookup and
 * per-session view state, never stored data. Row keys are unchanged; under a new display key
 * they no longer collide. Exported for the test; `mint` is injectable for the same reason.
 */
export function rekeyArrivingDisplays(slice: Slice, mint: () => string = newRowKey): Slice {
  const content = rekeyFragment(slice.content, mint)
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

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
/**
 * #1699 (D379) — where a mounted display keeps its per-session state (open rows, the view
 * choice): '' on the canvas, where #1670 re-keys every copy; a SIDE on Canvas Compare, whose two
 * read-only editors mount a snapshot's copy and the live copy of one display under ONE
 * `displayKey` (a snapshot keeps its key by design, D348) — so without it they shared both.
 */
export interface JointDisplayOptions {
  stateScope: string
}

export const JointDisplay = Node.create<JointDisplayOptions>({
  name: NODE_NAME,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { stateScope: '' }
  },

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

  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('joint-display-rekey'),
      props: { transformPasted: slice => rekeyArrivingDisplays(slice) },
    })]
  },
})
