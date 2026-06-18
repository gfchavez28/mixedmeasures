/**
 * Theme prose editor — composes useCanvasEditor with material node extensions
 * and slash command suggestion. Used for theme sections in the Writing View.
 */
import {
  useState, useRef, useEffect, useMemo, useImperativeHandle, useCallback,
  forwardRef, type MutableRefObject,
} from 'react'
import { EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Strikethrough, Link2, Unlink, List, ListOrdered, TextQuote } from 'lucide-react'
import type { AnyExtension } from '@tiptap/core'
import { toast } from 'sonner'
import { canvasApi } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import ThemeMentionList from './ThemeMentionList'
import type { ThemeMentionItem } from './ThemeMentionList'
import { useCanvasEditor } from './useCanvasEditor'
import { ExcerptEmbed, ChartEmbed, MemoEmbed, CalloutStat, ImageEmbed, SlashCommand } from './extensions'
import SlashCommandList from './SlashCommandList'
import type { SlashCommandListRef } from './SlashCommandList'
import { COMMANDS, type SlashCommand as SlashCommandItem } from './extensions/slash-commands'
import { describeRewrites } from './canvas-utils'

// ── Types ─────────────────────────────────────────────────────────────────

export interface InsertNodeHandle {
  insertExcerpt: (attrs: Record<string, unknown>) => void
  insertChart: (attrs: Record<string, unknown>) => void
  insertMemo: (attrs: Record<string, unknown>) => void
  insertImage: (attrs: Record<string, unknown>) => void
}

interface ThemeEditorProps {
  content: Record<string, unknown> | null
  onUpdate: (json: Record<string, unknown>) => void
  editable?: boolean
  placeholder?: string
  mentionItems?: ThemeMentionItem[]
  onMentionClick?: (id: string) => void
  /** Fires when a slash command requires parent handling (heading, excerpt, chart, memo) */
  onSlashCommand: (command: SlashCommandItem) => void
  /** Imperative handle for inserting material nodes from the Materials Drawer */
  insertNodeRef?: MutableRefObject<InsertNodeHandle | null>
  focusRef?: MutableRefObject<(() => void) | null>
  /** Called when this editor gains focus */
  onFocus?: () => void
  /** Called on every content change (keystroke-level), before debounced save */
  onContentChange?: () => void
  /** Accessible label for the editor (read by screen readers) */
  ariaLabel?: string
}

// ── Auto-save constants ──────────────────────────────────────────────────

const DEBOUNCE_MS = 3_000
const MAX_INTERVAL_MS = 30_000

// ── Component ────────────────────────────────────────────────────────────

const ThemeEditor = forwardRef<InsertNodeHandle, ThemeEditorProps>(function ThemeEditor(
  {
    content,
    onUpdate,
    editable = true,
    placeholder = 'Write about this theme — your analysis, interpretation, key findings. Type / to embed materials.',
    mentionItems,
    onMentionClick,
    onSlashCommand,
    insertNodeRef,
    focusRef,
    onFocus,
    onContentChange,
    ariaLabel,
  },
  ref,
) {
  const { projectId } = useProjectLayout()

  // Refs for stable callbacks inside extensions
  const onSlashCommandRef = useRef(onSlashCommand)
  onSlashCommandRef.current = onSlashCommand
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  // Slash command popup state
  const [slashPopup, setSlashPopup] = useState<{
    items: SlashCommandItem[]
    command: (item: SlashCommandItem) => void
    clientRect: (() => DOMRect | null) | null
  } | null>(null)
  const slashListRef = useRef<SlashCommandListRef>(null)

  // Build material + slash extensions (stable via useMemo)
  const additionalExtensions = useMemo<AnyExtension[]>(() => [
    ExcerptEmbed,
    ChartEmbed,
    MemoEmbed,
    CalloutStat,
    ImageEmbed.configure({
      uploadImage: (file: File) => canvasApi.uploadImage(projectId, file),
    }),
    SlashCommand.configure({
      suggestion: {
        char: '/',
        items: ({ query }: { query: string }) =>
          COMMANDS.filter(c => c.label.toLowerCase().includes(query.toLowerCase())),
        command: ({ editor: ed, range, props: cmd }) => {
          // Delete the "/" trigger text
          ed.chain().focus().deleteRange(range).run()
          const c = cmd as SlashCommandItem
          // Inline commands: handle directly
          if (c.type === 'text') return
          if (c.type === 'divider') { ed.chain().focus().setHorizontalRule().run(); return }
          if (c.type === 'callout') {
            ed.chain().focus().insertContent({
              type: 'callout-stat',
              attrs: { value: '', label: '' },
            }).run()
            return
          }
          // Parent-handled commands: heading, excerpt, chart, memo
          onSlashCommandRef.current(c)
        },
        render: () => ({
          onStart: (props) => {
            setSlashPopup({
              items: props.items as SlashCommandItem[],
              command: props.command as (item: SlashCommandItem) => void,
              clientRect: props.clientRect ?? null,
            })
          },
          onUpdate: (props) => {
            setSlashPopup(prev =>
              prev
                ? { ...prev, items: props.items as SlashCommandItem[], clientRect: props.clientRect ?? null }
                : null,
            )
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              setSlashPopup(null)
              return true
            }
            return slashListRef.current?.onKeyDown(props.event) ?? false
          },
          onExit: () => {
            setSlashPopup(null)
          },
        }),
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- build-once editor extensions; projectId is captured in the slash handlers, and rebuilding on its change would tear down/recreate the Tiptap editor
  ], [])

  const { editor, mentionPopup, mentionListRef, rewrites } = useCanvasEditor({
    content,
    editable,
    placeholder,
    mentionItems,
    additionalExtensions,
    starterKitOverrides: { horizontalRule: {} },
    ariaLabel,
    onBlur: (json) => {
      // Immediate save on blur — cancel any pending debounce
      clearTimeout(debounceRef.current)
      lastSaveRef.current = Date.now()
      onUpdateRef.current(json)
    },
  })

  // ── Schema-mismatch recovery ───────────────────────────────────────────
  // When useCanvasEditor reports rewrites (Word/Google-Docs paste, an older
  // schema, a programmatic import that used disallowed nodes), surface a
  // one-time non-blocking toast and persist the cleaned content so future
  // loads are silent. Guarded so it only fires once per editor mount.
  const rewriteHandledRef = useRef(false)
  useEffect(() => {
    if (!editor || !editable || rewrites.length === 0) return
    if (rewriteHandledRef.current) return
    rewriteHandledRef.current = true
    const summary = describeRewrites(rewrites)
    toast.info('Formatting simplified to fit the editor', {
      id: 'canvas-content-rewrite',
      description: summary,
      duration: 6000,
    })
    // Self-heal save so subsequent loads find clean content. Uses the same
    // path as user edits — debounce/maxinterval state is updated to match.
    clearTimeout(debounceRef.current)
    lastSaveRef.current = Date.now()
    onUpdateRef.current(editor.getJSON() as Record<string, unknown>)
  }, [editor, editable, rewrites])

  // ── Debounced auto-save ────────────────────────────────────────────────

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Initialized in a mount effect (not `useRef(Date.now())`) so Date.now() isn't
  // called during render — react-hooks impure-call rule. First read of this ref is
  // in an event/timeout handler, always after the mount effect runs, so the
  // mount-time-baseline throttle behavior is preserved.
  const lastSaveRef = useRef<number>(0)
  useEffect(() => {
    lastSaveRef.current = Date.now()
  }, [])

  useEffect(() => {
    if (!editor) return
    const handler = () => {
      onContentChangeRef.current?.()
      clearTimeout(debounceRef.current)
      const now = Date.now()
      // Force save if max interval exceeded
      if (now - lastSaveRef.current >= MAX_INTERVAL_MS) {
        lastSaveRef.current = now
        onUpdateRef.current(editor.getJSON() as Record<string, unknown>)
        return
      }
      debounceRef.current = setTimeout(() => {
        lastSaveRef.current = Date.now()
        onUpdateRef.current(editor.getJSON() as Record<string, unknown>)
      }, DEBOUNCE_MS)
    }
    editor.on('update', handler)
    return () => {
      editor.off('update', handler)
      clearTimeout(debounceRef.current)
    }
  }, [editor])

  // ── Focus tracking ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!editor || !onFocus) return
    editor.on('focus', onFocus)
    return () => { editor.off('focus', onFocus) }
  }, [editor, onFocus])

  // ── Editable sync ──────────────────────────────────────────────────────

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  // ── Imperative handles ─────────────────────────────────────────────────

  const insertExcerpt = useCallback(
    (attrs: Record<string, unknown>) => {
      editor?.chain().focus().insertContent({ type: 'excerpt-embed', attrs }).run()
    },
    [editor],
  )
  const insertChart = useCallback(
    (attrs: Record<string, unknown>) => {
      editor?.chain().focus().insertContent({ type: 'chart-embed', attrs }).run()
    },
    [editor],
  )
  const insertMemo = useCallback(
    (attrs: Record<string, unknown>) => {
      editor?.chain().focus().insertContent({ type: 'memo-embed', attrs }).run()
    },
    [editor],
  )
  const insertImage = useCallback(
    (attrs: Record<string, unknown>) => {
      editor?.chain().focus().insertContent({ type: 'image-embed', attrs }).run()
    },
    [editor],
  )

  // Expose via both ref patterns (forwardRef and MutableRefObject)
  useImperativeHandle(ref, () => ({ insertExcerpt, insertChart, insertMemo, insertImage }), [insertExcerpt, insertChart, insertMemo, insertImage])
  useEffect(() => {
    if (insertNodeRef) {
      insertNodeRef.current = { insertExcerpt, insertChart, insertMemo, insertImage }
      return () => { insertNodeRef.current = null }
    }
  }, [insertNodeRef, insertExcerpt, insertChart, insertMemo, insertImage])

  // Expose imperative focus
  useEffect(() => {
    if (focusRef) {
      focusRef.current = editor ? () => editor.commands.focus('end') : null
      return () => { focusRef.current = null }
    }
  }, [editor, focusRef])

  // Click handler for mention pills
  useEffect(() => {
    if (!onMentionClick || !editor) return
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('[data-type="mention"]')
      if (el) {
        const id = el.getAttribute('data-id')
        if (id) onMentionClick(id)
      }
    }
    editor.view.dom.addEventListener('click', handler)
    return () => editor.view.dom.removeEventListener('click', handler)
  }, [editor, onMentionClick])

  if (!editor) return null

  return (
    <div className="relative">
      {editable && (
        <BubbleMenu editor={editor}>
          <div className="flex items-center gap-0.5 bg-mm-surface border border-mm-border-medium rounded-md shadow-sm px-1 py-0.5">
            <BubbleBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} label="Bold">
              <Bold className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} label="Italic">
              <Italic className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} label="Bullet list">
              <List className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} label="Ordered list">
              <ListOrdered className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} label="Blockquote">
              <TextQuote className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} label="Strikethrough">
              <Strikethrough className="w-3.5 h-3.5" />
            </BubbleBtn>
            <BubbleBtn
              active={editor.isActive('link')}
              onClick={() => {
                if (editor.isActive('link')) {
                  editor.chain().focus().unsetLink().run()
                } else {
                  const url = window.prompt('URL')
                  if (url) editor.chain().focus().setLink({ href: url }).run()
                }
              }}
              label={editor.isActive('link') ? 'Remove link' : 'Add link'}
            >
              {editor.isActive('link') ? <Unlink className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
            </BubbleBtn>
          </div>
        </BubbleMenu>
      )}

      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none text-mm-text [&_.ProseMirror]:min-h-[2em] [&_.ProseMirror]:px-0 [&_.ProseMirror]:py-0 [&_[data-type=mention]]:inline [&_[data-type=mention]]:text-[11px] [&_[data-type=mention]]:font-semibold [&_[data-type=mention]]:px-1.5 [&_[data-type=mention]]:py-px [&_[data-type=mention]]:rounded-full [&_[data-type=mention]]:bg-indigo-50 [&_[data-type=mention]]:text-indigo-600 [&_[data-type=mention]]:cursor-pointer [&_[data-type=mention]:hover]:underline dark:[&_[data-type=mention]]:bg-indigo-900/30 dark:[&_[data-type=mention]]:text-indigo-300"
      />

      {/* Theme mention suggestion popup */}
      {mentionPopup && (
        <ThemeMentionList
          ref={mentionListRef}
          items={mentionPopup.items}
          command={mentionPopup.command}
          clientRect={mentionPopup.clientRect}
        />
      )}

      {/* Slash command suggestion popup */}
      {slashPopup && (
        <SlashCommandList
          ref={slashListRef}
          items={slashPopup.items}
          command={slashPopup.command}
          clientRect={slashPopup.clientRect}
        />
      )}
    </div>
  )
})

export default ThemeEditor

// ── BubbleMenu button ────────────────────────────────────────────────────

function BubbleBtn({
  active, onClick, label, children,
}: {
  active: boolean; onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`p-1 rounded transition-colors ${
        active ? 'bg-mm-bg text-mm-text' : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-bg'
      }`}
    >
      {children}
    </button>
  )
}
