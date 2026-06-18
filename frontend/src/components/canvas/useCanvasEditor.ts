/**
 * Shared Tiptap editor setup hook. Callers pass in an `extensions` array
 * to compose the editor's behavior:
 *   - ThemeEditor.tsx — theme prose with material nodes + slash commands
 *   - CanvasCompareView.tsx — read-only Tiptap renderer for snapshot diff
 */
import { useState, useRef, useMemo } from 'react'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import Mention from '@tiptap/extension-mention'
import { getSchema } from '@tiptap/core'
import type { AnyExtension, JSONContent } from '@tiptap/core'
import type { ThemeMentionItem, ThemeMentionListRef } from './ThemeMentionList'
import { cleanCanvasContent, type ContentRewrite } from './canvas-utils'

export interface MentionPopupState {
  items: ThemeMentionItem[]
  command: (item: { id: string; label: string }) => void
  clientRect: (() => DOMRect | null) | null
}

export interface UseCanvasEditorOptions {
  content: Record<string, unknown> | null
  editable?: boolean
  placeholder?: string
  mentionItems?: ThemeMentionItem[]
  /** Extra extensions added after the base set (material nodes, slash, etc.) */
  additionalExtensions?: AnyExtension[]
  /** Override individual StarterKit options (e.g. { horizontalRule: {} } to enable HR) */
  starterKitOverrides?: Record<string, unknown>
  /** Accessible label for the editor (read by screen readers) */
  ariaLabel?: string
  onBlur?: (json: Record<string, unknown>) => void
}

export interface UseCanvasEditorReturn {
  editor: ReturnType<typeof useEditor>
  mentionPopup: MentionPopupState | null
  mentionListRef: React.RefObject<ThemeMentionListRef | null>
  /**
   * Transforms applied to the incoming `content` so it would fit the editor's
   * schema. Empty if the doc was already clean. Stable across re-renders of
   * the same content. Callers use this to surface a one-time notification and
   * trigger a self-healing save.
   */
  rewrites: ContentRewrite[]
}

export function useCanvasEditor({
  content,
  editable = true,
  placeholder = 'Write something...',
  mentionItems,
  additionalExtensions,
  starterKitOverrides,
  ariaLabel,
  onBlur,
}: UseCanvasEditorOptions): UseCanvasEditorReturn {
  // Mention popup state (rendered via React, not tippy.js)
  const [mentionPopup, setMentionPopup] = useState<MentionPopupState | null>(null)
  const mentionListRef = useRef<ThemeMentionListRef | null>(null)

  // Keep mentionItems in a ref so the suggestion plugin always reads current items
  const mentionItemsRef = useRef(mentionItems)
  mentionItemsRef.current = mentionItems

  // Build extensions list
  const extensions = useMemo(() => {
    const base: AnyExtension[] = [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: false,
        ...starterKitOverrides,
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-mm-blue underline' },
      }),
    ]

    if (mentionItems) {
      base.push(
        Mention.configure({
          HTMLAttributes: { class: 'theme-mention' },
          suggestion: {
            char: '@',
            items: ({ query }: { query: string }) => {
              return (mentionItemsRef.current ?? []).filter(item =>
                item.label.toLowerCase().includes(query.toLowerCase()),
              )
            },
            render: () => ({
              onStart: (props) => {
                setMentionPopup({
                  items: props.items as ThemeMentionItem[],
                  command: props.command,
                  clientRect: props.clientRect ?? null,
                })
              },
              onUpdate: (props) => {
                setMentionPopup(prev =>
                  prev
                    ? { ...prev, items: props.items as ThemeMentionItem[], clientRect: props.clientRect ?? null }
                    : null,
                )
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') {
                  setMentionPopup(null)
                  return true
                }
                return mentionListRef.current?.onKeyDown(props.event) ?? false
              },
              onExit: () => {
                setMentionPopup(null)
              },
            }),
          },
        }),
      )
    }

    if (additionalExtensions) {
      base.push(...additionalExtensions)
    }

    return base
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable deps only
  }, [placeholder, !!mentionItems, additionalExtensions, starterKitOverrides])

  // Pre-clean the incoming content against the editor's schema so unsupported
  // nodes (e.g. `heading` from a Word/Google-Docs paste) don't get silently
  // dropped by Tiptap during init. Returns the rewrites to the caller so they
  // can surface a one-time notice + self-heal-save the cleaned shape.
  const { cleaned, rewrites } = useMemo(() => {
    if (!content) return { cleaned: null as JSONContent | null, rewrites: [] as ContentRewrite[] }
    let allowedNodes: Set<string>
    let allowedMarks: Set<string>
    try {
      const schema = getSchema(extensions)
      allowedNodes = new Set(Object.keys(schema.nodes))
      allowedMarks = new Set(Object.keys(schema.marks))
    } catch {
      // If schema introspection fails for any reason, fall through with
      // the content untouched — preserves existing behavior.
      return { cleaned: content as JSONContent, rewrites: [] as ContentRewrite[] }
    }
    return cleanCanvasContent(content as JSONContent, allowedNodes, allowedMarks)
  }, [content, extensions])

  const editor = useEditor({
    extensions,
    content: cleaned ?? undefined,
    editable,
    editorProps: ariaLabel ? { attributes: { 'aria-label': ariaLabel } } : {},
    onBlur({ editor: ed }) {
      onBlur?.(ed.getJSON() as Record<string, unknown>)
    },
  })

  return { editor, mentionPopup, mentionListRef, rewrites }
}
