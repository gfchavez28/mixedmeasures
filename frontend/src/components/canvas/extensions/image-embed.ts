import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import ImageEmbedView from './ImageEmbedView'

export interface ImageEmbedOptions {
  uploadImage: ((file: File) => Promise<{ image_id: string }>) | null
}

export const ImageEmbed = Node.create<ImageEmbedOptions>({
  name: 'image-embed',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { uploadImage: null }
  },

  addAttributes() {
    return {
      imageId:     { default: null },
      alt:         { default: '' },
      width:       { default: 100 },
      materialTag: { default: null },
      tagNote:     { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'figure[data-type="image-embed"]',
      getAttrs: (el) => {
        const dom = el as HTMLElement
        return {
          imageId:     dom.getAttribute('data-image-id') || null,
          alt:         dom.getAttribute('data-alt') ?? '',
          width:       Number(dom.getAttribute('data-width')) || 100,
          materialTag: dom.getAttribute('data-material-tag') || null,
          tagNote:     dom.getAttribute('data-tag-note') || null,
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', {
      'data-type': 'image-embed',
      'data-image-id': HTMLAttributes.imageId,
      'data-alt': HTMLAttributes.alt,
      'data-width': HTMLAttributes.width,
      'data-material-tag': HTMLAttributes.materialTag,
      'data-tag-note': HTMLAttributes.tagNote,
    }, ['img', { src: '', alt: HTMLAttributes.alt ?? '' }]]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageEmbedView)
  },

  addProseMirrorPlugins() {
    const uploadFn = this.options.uploadImage
    if (!uploadFn) return []

    const nodeType = this.type

    return [new Plugin({
      props: {
        handleDrop(view, event) {
          const file = event.dataTransfer?.files?.[0]
          if (!file || !file.type.startsWith('image/')) return false
          event.preventDefault()
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
          uploadFn(file).then(({ image_id }) => {
            const node = nodeType.create({ imageId: image_id })
            const tr = view.state.tr.insert(pos?.pos ?? view.state.selection.from, node)
            view.dispatch(tr)
          }).catch(err => console.error('Image drop upload failed:', err))
          return true
        },
        handlePaste(view, event) {
          const file = event.clipboardData?.files?.[0]
          if (!file || !file.type.startsWith('image/')) return false
          event.preventDefault()
          uploadFn(file).then(({ image_id }) => {
            const node = nodeType.create({ imageId: image_id })
            const tr = view.state.tr.replaceSelectionWith(node)
            view.dispatch(tr)
          }).catch(err => console.error('Image paste upload failed:', err))
          return true
        },
      },
    })]
  },
})
