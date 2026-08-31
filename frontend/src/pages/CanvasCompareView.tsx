/**
 * Canvas comparison view — snapshot vs current or side-by-side canvases.
 *
 * URL params:
 *   ?canvas={id}&snapshot={id}  — snapshot comparison (left=snapshot, right=current)
 *   ?canvas={id}&canvas2={id}   — side-by-side (no diff highlighting)
 */
import { useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { EditorContent } from '@tiptap/react'
import type { AnyExtension } from '@tiptap/core'
import { ArrowLeft, FileQuestion, Loader2 } from 'lucide-react'
import { canvasApi, type SnapshotRelationship } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useCanvasEditor } from '@/components/canvas/useCanvasEditor'
import { ExcerptEmbed, ChartEmbed, MemoEmbed, CalloutStat, ImageEmbed } from '@/components/canvas/extensions'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Shared extensions for read-only rendering ────────────────────────────────

const readOnlyExtensions: AnyExtension[] = [
  ExcerptEmbed,
  ChartEmbed,
  MemoEmbed,
  CalloutStat,
  ImageEmbed,
]

// ── Read-only theme renderer ─────────────────────────────────────────────────

function ReadOnlyTheme({ name, color, content, diffClass, materialDiff, changed, changedLabel, statusLabel }: {
  name: string
  color: string | null
  content: Record<string, unknown> | null
  diffClass?: string
  materialDiff?: string
  /** #850(b) — this matched theme's prose differs between the two sides. */
  changed?: boolean
  /**
   * #865 — the WORD for that, passed in rather than chosen here. It used to be
   * picked from a `changedSide` prop, which is how the left pane came to say
   * *"Text changed since"* — not a sentence, and a second place for the page's
   * mark vocabulary to live. The caller owns the wording; this owns the render.
   */
  changedLabel?: string
  /** #850(c) — the word for an added/removed theme, paired with its colour. */
  statusLabel?: string
}) {
  const parsedContent = useMemo(() => {
    if (!content) return null
    if (typeof content === 'string') {
      try { return JSON.parse(content) } catch { return null }
    }
    return content
  }, [content])

  const { editor } = useCanvasEditor({
    content: parsedContent,
    editable: false,
    additionalExtensions: readOnlyExtensions,
    // #850(a) — this hook names the editor only when passed a label, and every
    // other Tiptap surface threads one through here; this one was the exception.
    //
    // ⚠️ **The filed finding was "8 unnamed `role=\"textbox\"` nodes" and that
    // does NOT reproduce in this build** — measured in Chrome's accessibility
    // tree on 2026-08-31, these read-only nodes carry `role: null` and expose as
    // StaticText, so there is no textbox to leave unnamed. The label is set
    // anyway: it is the documented channel, it costs nothing, and it is correct
    // the moment the role comes back. Recorded rather than dropped so the next
    // reader does not re-derive a Lighthouse count that has moved.
    ariaLabel: `${name} — theme text`,
    // #848: this renderer's content prop is the source of truth, so the editor
    // must follow it. Without this, an instance React reuses across a data
    // change keeps the prose it was created with. See the hook's docstring.
    recreateOnContentChange: true,
  })

  return (
    <div className={cn(
      'mb-6 pl-3 border-l-4',
      diffClass ?? (changed ? 'border-l-amber-500' : 'border-transparent'),
    )}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {color && <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />}
        <h3 className="text-sm font-semibold text-mm-text">{name}</h3>
        {/* #850(c) — every marked card carries the WORD, not just the hue. The
            relationship-diff footer below has labelled its two lists all along
            ("Added (N)" / "Removed (N)"), so the vocabulary already existed;
            the theme panes simply did not use it. Colour-blind readers and
            browse-mode readers get the same answer as everyone else. */}
        {statusLabel && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-mm-bg text-mm-text-secondary border border-mm-border-subtle">
            {statusLabel}
          </span>
        )}
        {changed && !statusLabel && changedLabel && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900">
            {changedLabel}
          </span>
        )}
      </div>
      {materialDiff && (
        <p className="text-[11px] text-mm-text-muted mb-2">{materialDiff}</p>
      )}
      {editor && (
        <div className="prose-sm max-w-none text-mm-text">
          <EditorContent editor={editor} />
        </div>
      )}
      {!parsedContent && (
        <p className="text-xs text-mm-text-faint italic">No content</p>
      )}
    </div>
  )
}

// ── Diff computation ─────────────────────────────────────────────────────────

interface SourceRef { type: string; id: number }

function parseRefs(raw: string | SourceRef[] | null): SourceRef[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw) } catch { return [] }
}

function refKey(r: SourceRef): string { return `${r.type}:${r.id}` }

/**
 * Did a MATCHED theme's prose change? — #850(b).
 *
 * 🔴 There was no code path that could answer this. `diff.matched` rendered with
 * `diffClass` undefined on BOTH panes, so only wholly added or removed themes
 * were marked — and the question a snapshot diff exists to answer is *what did I
 * write since?* A reader compared two columns of long prose by eye.
 *
 * ⚠️ Compared as SERIALIZED CONTENT, deliberately, not by walking the Tiptap
 * doc. The blob is what the snapshot stored and what the editor renders, so a
 * mismatch is exactly "these two render differently"; a structural walk would
 * have to decide which node attrs count, and getting that wrong reports a change
 * that is not there — worse than the silence it replaces, because this marker's
 * whole value is that it can be trusted.
 *
 * ⚠️ Key ORDER is not normalised and does not need to be: both sides come from
 * the same producer (`CanvasTheme.content`, written by one editor), so a
 * key-order difference would mean the storage format changed under us — which is
 * a real change worth surfacing, not a false positive to suppress.
 */
function themeContentChanged(left: ThemeForCompare, right: ThemeForCompare): boolean {
  return canonicalContent(left.content) !== canonicalContent(right.content)
}

/**
 * A theme's content as ONE canonical string, whichever shape it arrived in.
 *
 * 🔴 **The two sides do not store it the same way, and that is not obvious from
 * either type.** A snapshot serialises `content` to a JSON STRING when it is
 * written (`snapshot_data.themes[].content`), while the live canvas carries the
 * parsed OBJECT. Comparing them raw makes every matched theme differ, so the
 * "text changed" marker fires on every row — noise on a page whose only value is
 * that its marks can be trusted, and strictly worse than the silence it
 * replaced.
 *
 * ⚠️ Caught by the discrimination test (identical themes must NOT be marked),
 * not by the positive one. A guard that only checks the marker APPEARS passes
 * against a marker that never stops appearing.
 *
 * ⚠️ This is the same parse `ReadOnlyTheme` does before handing content to the
 * editor, which is what keeps the comparison honest: it compares what the two
 * sides actually RENDER.
 */
function canonicalContent(content: ThemeForCompare['content']): string {
  if (content == null) return ''
  const parsed = typeof content === 'string'
    ? (() => { try { return JSON.parse(content) } catch { return content } })()
    : content
  return JSON.stringify(parsed)
}

/**
 * The material delta between a matched pair, worded FROM THE RIGHT PANE.
 *
 * 🔴 #850(d) — this returned a bare `+2 materials` that BOTH panes rendered, the
 * left one prefixed `"Snapshot: "`. The two call sites were textually the same
 * call with the same arguments, so the strings could not differ — and `added`
 * counts present-in-RIGHT, so the snapshot's own pane claimed a gain that
 * belongs to the current state. Exactly backwards, stated confidently.
 *
 * One delta is ONE fact about a PAIR, so it is computed once and rendered once,
 * on the side it is true of. ⚠️ The wording has to name the other side, and
 * which that is depends on the mode: a snapshot comparison and a
 * canvas-vs-canvas comparison are not the same sentence. #795's rule — ask
 * whether the label's implied sentence is true of THIS thing.
 */
function computeMaterialDiff(
  leftRefs: SourceRef[],
  rightRefs: SourceRef[],
  sinceLabel: string,
): string {
  const leftSet = new Set(leftRefs.map(refKey))
  const rightSet = new Set(rightRefs.map(refKey))
  const added = rightRefs.filter(r => !leftSet.has(refKey(r))).length
  const removed = leftRefs.filter(r => !rightSet.has(refKey(r))).length
  const parts: string[] = []
  if (added > 0) parts.push(`${added} material${added !== 1 ? 's' : ''} added`)
  if (removed > 0) parts.push(`${removed} removed`)
  if (parts.length === 0) return ''
  return `${parts.join(', ')} since ${sinceLabel}`
}

interface ThemeForCompare {
  /**
   * #848 — the stable identity every rendered card is keyed on.
   *
   * These lists are rebuilt as queries resolve, and their MEMBERSHIP changes:
   * before the snapshot arrives every current theme is "right only"; after it,
   * only the genuinely-added ones are. An index-derived key therefore means a
   * different theme on either side of that transition, and React reuses the
   * instance. MEASURED: `ro-0` was "Assessment Outcomes" at t=1233ms and
   * "New theme" at t=1352ms — the heading updated, the prose did not.
   */
  id: number
  name: string
  color: string | null
  content: Record<string, unknown> | null
  referenced_source_ids: string | SourceRef[] | null
}

interface MatchResult {
  matched: { left: ThemeForCompare; right: ThemeForCompare }[]
  leftOnly: ThemeForCompare[]
  rightOnly: ThemeForCompare[]
}

function matchThemes(leftThemes: ThemeForCompare[], rightThemes: ThemeForCompare[]): MatchResult {
  const matched: MatchResult['matched'] = []
  const rightUsed = new Set<number>()

  for (const lt of leftThemes) {
    const key = lt.name.trim().toLowerCase()
    const ri = rightThemes.findIndex((rt, i) => !rightUsed.has(i) && rt.name.trim().toLowerCase() === key)
    if (ri >= 0) {
      matched.push({ left: lt, right: rightThemes[ri] })
      rightUsed.add(ri)
    }
  }

  const leftOnly = leftThemes.filter(lt => !matched.some(m => m.left === lt))
  const rightOnly = rightThemes.filter((_, i) => !rightUsed.has(i))

  return { matched, leftOnly, rightOnly }
}

// ── Relationship diff ────────────────────────────────────────────────────────

function formatRelDiff(
  leftRels: SnapshotRelationship[],
  rightRels: { relationship_type: string; label: string | null; is_bidirectional: boolean; source_name: string; target_name: string }[],
  leftNames: Map<number, string>,
): { added: string[]; removed: string[] } {
  const relKey = (src: string, tgt: string, type: string) => `${src.toLowerCase()}|${tgt.toLowerCase()}|${type}`

  const leftSet = new Map<string, string>()
  for (const r of leftRels) {
    const src = leftNames.get(r.source_theme_id) ?? '?'
    const tgt = leftNames.get(r.target_theme_id) ?? '?'
    const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
    const label = r.relationship_type === 'custom' ? (r.label || '') : r.relationship_type
    leftSet.set(relKey(src, tgt, r.relationship_type), `${src} ${arrow} ${tgt}: ${label}`)
  }

  const rightSet = new Map<string, string>()
  for (const r of rightRels) {
    const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
    const label = r.relationship_type === 'custom' ? (r.label || '') : r.relationship_type
    rightSet.set(relKey(r.source_name, r.target_name, r.relationship_type), `${r.source_name} ${arrow} ${r.target_name}: ${label}`)
  }

  const added = [...rightSet.entries()].filter(([k]) => !leftSet.has(k)).map(([, v]) => v)
  const removed = [...leftSet.entries()].filter(([k]) => !rightSet.has(k)).map(([, v]) => v)
  return { added, removed }
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CanvasCompareView() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { projectId } = useProjectLayout()

  const canvasId = Number(searchParams.get('canvas')) || 0
  const snapshotId = Number(searchParams.get('snapshot')) || 0
  const canvas2Id = Number(searchParams.get('canvas2')) || 0
  const isSnapshotMode = snapshotId > 0
  const isSideBySide = canvas2Id > 0

  // ⚠️ #849 — the whole query result is kept, not just `data`. All three used to
  // destructure `data` alone, so `isPending`/`isError` were unreachable and a
  // missing snapshot rendered a CONFIDENT FALSE DIFF: "Snapshot: ... ()" in the
  // header, "No themes" on the left, the full current canvas on the right —
  // i.e. "the snapshot was empty; you added everything since". No error, no
  // toast, no empty state. `PageErrorBoundary` cannot catch it either: a failed
  // `useQuery` RETURNS, it does not throw.
  const canvasEnabled = canvasId > 0
  const snapshotEnabled = isSnapshotMode && canvasId > 0
  const canvas2Enabled = isSideBySide && canvas2Id > 0

  // Fetch current canvas (right panel, or left for side-by-side)
  const canvasQuery = useQuery({
    queryKey: ['canvas', projectId, canvasId],
    queryFn: () => canvasApi.get(projectId, canvasId),
    enabled: canvasEnabled,
  })
  const canvas = canvasQuery.data

  // Fetch snapshot detail (left panel in snapshot mode)
  const snapshotQuery = useQuery({
    queryKey: ['snapshot-detail', projectId, canvasId, snapshotId],
    queryFn: () => canvasApi.getSnapshot(projectId, canvasId, snapshotId),
    enabled: snapshotEnabled,
    // Snapshots are a 10-rotation, so a gone id is the EXPECTED failure here,
    // not a flake. Retrying it only lengthens the window the wrong render is up.
    retry: false,
  })
  const snapshot = snapshotQuery.data

  // Fetch second canvas (right panel in side-by-side mode)
  const canvas2Query = useQuery({
    queryKey: ['canvas', projectId, canvas2Id],
    queryFn: () => canvasApi.get(projectId, canvas2Id),
    enabled: canvas2Enabled,
    retry: false,
  })
  const canvas2 = canvas2Query.data

  // Build theme arrays for comparison
  const leftThemes: ThemeForCompare[] = useMemo(() => {
    if (isSnapshotMode && snapshot?.snapshot_data) {
      // ⚠️ `[...]` first — `.sort()` is IN PLACE. Without the copy this reorders
      // React Query's own cached array on every recompute. `rightThemes` below
      // always copied; only this arm did not.
      return [...snapshot.snapshot_data.themes]
        .sort((a, b) => a.doc_order - b.doc_order)
        .map(t => ({
          id: t.id,
          name: t.name,
          color: t.color,
          content: t.content as unknown as Record<string, unknown> | null,
          referenced_source_ids: t.referenced_source_ids,
        }))
    }
    if (isSideBySide && canvas) {
      return [...canvas.themes].sort((a, b) => a.doc_order - b.doc_order).map(t => ({
        id: t.id,
        name: t.name,
        color: t.color,
        content: t.content,
        referenced_source_ids: t.referenced_source_ids,
      }))
    }
    return []
  }, [isSnapshotMode, isSideBySide, snapshot, canvas])

  const rightThemes: ThemeForCompare[] = useMemo(() => {
    const source = isSideBySide ? canvas2 : canvas
    if (!source) return []
    return [...source.themes].sort((a, b) => a.doc_order - b.doc_order).map(t => ({
      id: t.id,
      name: t.name,
      color: t.color,
      content: t.content,
      referenced_source_ids: t.referenced_source_ids,
    }))
  }, [isSideBySide, canvas, canvas2])

  // Diff computation (snapshot mode only)
  const diff = useMemo(() => {
    if (!isSnapshotMode) return null
    return matchThemes(leftThemes, rightThemes)
  }, [isSnapshotMode, leftThemes, rightThemes])

  // Relationship diff
  const relDiff = useMemo(() => {
    if (!isSnapshotMode || !snapshot?.snapshot_data || !canvas) return null
    const leftRels = snapshot.snapshot_data.relationships
    const leftNames = new Map(snapshot.snapshot_data.themes.map(t => [t.id, t.name]))
    const themeNames = new Map(canvas.themes.map(t => [t.id, t.name]))
    const rightRels: { relationship_type: string; label: string | null; is_bidirectional: boolean; source_name: string; target_name: string }[] = []
    for (const t of canvas.themes) {
      for (const r of (t.relationships_out ?? [])) {
        rightRels.push({
          relationship_type: r.relationship_type,
          label: r.label,
          is_bidirectional: r.is_bidirectional,
          source_name: themeNames.get(r.source_theme_id) ?? '?',
          target_name: themeNames.get(r.target_theme_id) ?? '?',
        })
      }
    }
    return formatRelDiff(leftRels, rightRels, leftNames)
  }, [isSnapshotMode, snapshot, canvas])

  // Labels
  const leftLabel = isSnapshotMode
    ? `Snapshot: ${snapshot?.name ?? '...'} (${snapshot ? formatRelativeTime(snapshot.created_at) : ''})`
    : canvas?.name ?? '...'
  const rightLabel = isSideBySide ? (canvas2?.name ?? '...') : 'Current state'
  // #850(d) — the delta's sentence has to name the OTHER side, and which that is
  // depends on the mode. "since the snapshot" is wrong for canvas-vs-canvas.
  //
  // ⚠️ #865: the second branch is UNREACHABLE today — this is read only inside
  // the `diff` arm, and `diff` is null unless `isSnapshotMode`. Kept rather than
  // collapsed to a constant because it is correct the moment a canvas-vs-canvas
  // diff ships, and a hardcoded "the snapshot" would then be silently wrong in
  // the mode that has no snapshot.
  const sinceLabel = isSnapshotMode
    ? 'the snapshot'
    : (canvas?.name ? `"${canvas.name}"` : 'the other canvas')

  /**
   * The three marks, worded ONCE (#865).
   *
   * 🔴 **The legend and the badges used to say different things about the same
   * mark.** The key read *"Only in Current state"* while the card it explains
   * was stamped *"Added since"* — a dangling phrase with no object, and one the
   * reader had to match up by colour. The pane badges and the key now read from
   * one object, so a wording change cannot land on one and not the other.
   *
   * ⚠️ **Mode-aware, because "since" is a claim about time** that a
   * canvas-vs-canvas comparison cannot make. Same reasoning as `sinceLabel`.
   */
  const marks = {
    leftOnly: isSnapshotMode ? 'Only in the snapshot' : `Only in ${leftLabel}`,
    rightOnly: isSnapshotMode ? 'Added since the snapshot' : `Only in ${rightLabel}`,
    // ⚠️ ONE word for both panes, deliberately. #850(c)'s rule is that a mark
    // carries a WORD and not only a hue; which side you are reading is already
    // said by the pane's own named region and heading, and "Text changed since"
    // — the old left-hand wording — is not a sentence.
    changed: 'Text changed',
  }

  const handleBack = () => {
    navigate(`/projects/${projectId}/analysis/canvas?canvas=${canvasId}`)
  }

  // ── #849: resolve before comparing ────────────────────────────────────────
  //
  // 🔴 This gate is what makes the comparison HONEST, and it is the same gate
  // #848 needs. A diff computed while one side is still fetching is not a
  // partial answer, it is a WRONG one: `matchThemes([], right)` is a perfectly
  // valid result meaning "every theme is new", so the page states that with the
  // same confidence it states a real diff. It also renders a header reading
  // literally `Snapshot: ... ()`.
  //
  // ⚠️ `isPending` is true for a DISABLED query too, so each arm is paired with
  // its own `enabled` condition — otherwise side-by-side mode would wait forever
  // on the snapshot query it never runs.
  const waiting =
    (canvasEnabled && canvasQuery.isPending) ||
    (snapshotEnabled && snapshotQuery.isPending) ||
    (canvas2Enabled && canvas2Query.isPending)

  const missingSnapshot = snapshotEnabled && snapshotQuery.isError
  const missingCanvas =
    (canvasEnabled && canvasQuery.isError) || (canvas2Enabled && canvas2Query.isError)
  const nothingToCompare = !canvasEnabled

  const backButton = (
    <button
      onClick={handleBack}
      className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
      aria-label="Back to canvas"
    >
      <ArrowLeft className="w-4 h-4" />
    </button>
  )

  if (nothingToCompare || missingSnapshot || missingCanvas) {
    // ⚠️ Worded per CAUSE, because the remedies differ: a rotated-out snapshot is
    // normal housekeeping and the canvas is still there; a missing canvas is not.
    const { heading, detail } = nothingToCompare
      ? {
          heading: 'Nothing to compare',
          detail: 'This link is missing the canvas it should open. Go back and choose a snapshot from the canvas you want to compare.',
        }
      : missingSnapshot
        ? {
            heading: 'This snapshot is no longer available',
            detail: 'Canvases keep the ten most recent snapshots, so older ones are removed automatically. A saved link or a bookmark can outlive the snapshot it points to. Your canvas itself is unaffected.',
          }
        : {
            heading: 'This canvas is no longer available',
            detail: 'It may have been deleted or archived since this link was made.',
          }
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-mm-border-subtle bg-mm-surface">
          {backButton}
          <span className="text-sm font-medium text-mm-text">Compare</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-[420px] text-center">
            {/* Not colour-only: an icon, a heading and prose all carry the state. */}
            <FileQuestion className="w-8 h-8 mx-auto mb-3 text-mm-text-faint" aria-hidden="true" />
            <h2 className="text-base font-semibold text-mm-text mb-2">{heading}</h2>
            <p className="text-sm text-mm-text-muted mb-4">{detail}</p>
            <button
              onClick={handleBack}
              className="text-sm px-3 py-1.5 rounded border border-mm-border-subtle text-mm-text hover:bg-mm-bg transition-colors"
            >
              Back to canvas
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (waiting) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-mm-border-subtle bg-mm-surface">
          {backButton}
          <span className="text-sm font-medium text-mm-text">Compare</span>
        </div>
        <div className="flex-1 flex items-center justify-center" role="status" aria-live="polite">
          <span className="flex items-center gap-2 text-sm text-mm-text-muted">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            Loading comparison…
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-mm-border-subtle bg-mm-surface">
        <button
          onClick={handleBack}
          className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
          aria-label="Back to canvas"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        {/* #850(a) — these were two bare spans, so the page had NO h1/h2 at all
            and a reader navigating by heading met only theme `h3`s, twice, with
            nothing saying which side was which. */}
        <div className="flex-1 flex items-center justify-center gap-2 text-sm">
          <h1 id="compare-left-label" className="font-medium text-mm-text truncate max-w-[300px]">{leftLabel}</h1>
          <span className="text-mm-text-faint" aria-hidden="true">{'\u2194'}</span>
          <h1 id="compare-right-label" className="font-medium text-mm-text truncate max-w-[300px]">{rightLabel}</h1>
        </div>
      </div>

      {/* #850(c) — the KEY. Added/removed were encoded by border colour alone
          with nothing on the page to decode them, and a changed theme had no
          marking at all. Every mark here is word + colour, never colour alone;
          the overlay flags colour-only encoding as a standing check because no
          colourblind mode exists.

          🔴 #865 — gated on `diff`, which is the thing that PRODUCES the marks.
          It used to render unconditionally, so a canvas-vs-canvas comparison —
          where `diff` is null and both panes render plain, unmarked themes —
          showed a key explaining three marks that cannot occur. A legend for
          absent marks is the same wrong-information shape as #850(d)'s
          mislabelled delta, one element up.

          ⚠️ Gated on `diff` rather than on `isSnapshotMode`: they coincide
          today, and only the first is the honest predicate — if a side-by-side
          diff ever ships, the key should appear with it and not need finding. */}
      {diff && (
      <div className="shrink-0 flex items-center flex-wrap gap-x-4 gap-y-1 px-4 py-1.5 border-b border-mm-border-subtle bg-mm-bg text-[11px] text-mm-text-secondary">
        <span className="font-medium text-mm-text-muted">What the marks mean:</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 border-l-4 border-l-indigo-500 h-3" aria-hidden="true" />
          {marks.leftOnly}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 border-l-4 border-l-rose-500 h-3" aria-hidden="true" />
          {marks.rightOnly}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 border-l-4 border-l-amber-500 h-3" aria-hidden="true" />
          {marks.changed}
        </span>
      </div>
      )}

      {/* Dual panel */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left panel */}
        <section
          aria-labelledby="compare-left-label"
          className="flex-1 overflow-auto border-b lg:border-b-0 lg:border-r border-mm-border-subtle"
        >
          <div className="max-w-[600px] mx-auto px-6 py-6">
            {diff ? (
              <>
                {/* #850(d): the LEFT pane carries no delta. It is the BEFORE
                    side, and the one delta this pair has is rendered on the
                    right, where its sentence is true. */}
                {diff.matched.map(m => (
                  <ReadOnlyTheme
                    key={`m-l-${m.left.id}`}
                    name={m.left.name}
                    color={m.left.color}
                    content={m.left.content}
                    changed={themeContentChanged(m.left, m.right)}
                    changedLabel={marks.changed}
                  />
                ))}
                {diff.leftOnly.map(t => (
                  <ReadOnlyTheme
                    key={`lo-${t.id}`}
                    name={t.name}
                    color={t.color}
                    content={t.content}
                    diffClass="border-l-indigo-500"
                    statusLabel={marks.leftOnly}
                  />
                ))}
              </>
            ) : (
              leftThemes.map(t => (
                <ReadOnlyTheme key={`l-${t.id}`} name={t.name} color={t.color} content={t.content} />
              ))
            )}
            {leftThemes.length === 0 && (
              <p className="text-sm text-mm-text-faint text-center py-8">No themes</p>
            )}
          </div>
        </section>

        {/* Right panel */}
        <section aria-labelledby="compare-right-label" className="flex-1 overflow-auto">
          <div className="max-w-[600px] mx-auto px-6 py-6">
            {diff ? (
              <>
                {diff.matched.map(m => {
                  const md = computeMaterialDiff(
                    parseRefs(m.left.referenced_source_ids),
                    parseRefs(m.right.referenced_source_ids),
                    sinceLabel,
                  )
                  return (
                    <ReadOnlyTheme
                      key={`m-r-${m.right.id}`}
                      name={m.right.name}
                      color={m.right.color}
                      content={m.right.content}
                      materialDiff={md || undefined}
                      changed={themeContentChanged(m.left, m.right)}
                      changedLabel={marks.changed}
                    />
                  )
                })}
                {diff.rightOnly.map(t => (
                  <ReadOnlyTheme
                    key={`ro-${t.id}`}
                    name={t.name}
                    color={t.color}
                    content={t.content}
                    diffClass="border-l-rose-500"
                    statusLabel={marks.rightOnly}
                  />
                ))}
              </>
            ) : (
              rightThemes.map(t => (
                <ReadOnlyTheme key={`r-${t.id}`} name={t.name} color={t.color} content={t.content} />
              ))
            )}
            {rightThemes.length === 0 && (
              <p className="text-sm text-mm-text-faint text-center py-8">No themes</p>
            )}
          </div>
        </section>
      </div>

      {/* Relationship diff (snapshot mode only) */}
      {relDiff && (relDiff.added.length > 0 || relDiff.removed.length > 0) && (
        <div className="shrink-0 border-t border-mm-border-subtle px-6 py-3 bg-mm-surface max-h-40 overflow-auto">
          <p className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider mb-1">Relationship changes</p>
          <div className="flex gap-6 text-xs">
            {relDiff.added.length > 0 && (
              <div>
                <p className="text-rose-600 dark:text-rose-400 font-medium mb-0.5">Added ({relDiff.added.length})</p>
                {relDiff.added.map((r, i) => <p key={i} className="text-mm-text-muted">{r}</p>)}
              </div>
            )}
            {relDiff.removed.length > 0 && (
              <div>
                <p className="text-indigo-600 dark:text-indigo-400 font-medium mb-0.5">Removed ({relDiff.removed.length})</p>
                {relDiff.removed.map((r, i) => <p key={i} className="text-mm-text-muted">{r}</p>)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
