/**
 * Pin a quote (D163; mockup `5-cells.html` §3) — from ONE group's coded passages, so a quote
 * cannot come from the wrong group.
 *
 * The suggestions are `POST …/joint-display/passages` (D209): the display's own grouping,
 * sources and coder scope, the chips following the scope while blind (D102). Pinning goes
 * through `POST …/excerpts/whole-passage`, so the pinned passage is a QUOTE in every sense —
 * on the Quote Board, in the quote exports, removed by a withdrawal — and the pin carries
 * exactly `excerptEmbedAttrs` (the one source, this directory's the internal design notes) plus its group.
 *
 * ⚠️ The body mounts only while open, so a closed picker holds no query observer (§8).
 */
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LoadingNotice } from '@/components/LoadStatus'
import { excerptsApi, jointDisplayApi, type JointDisplayAnswerPassage } from '@/lib/api'
import type { CodedSegmentWithContext } from '@/lib/api/code-analysis'
import { excerptEmbedAttrs } from '@/lib/canvas-excerpt'
import { listStatus, loadFailureReason } from '@/lib/list-status'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import {
  pinPassagesRequest, pinPoolUnit, type DisplayCoderScope, type JointDisplay, type JointDisplayPin,
} from '@/lib/joint-display'
import { GROUPING_GONE_TEXT, PIN_PICKER_DESCRIPTION, pinPickerText } from '@/lib/joint-display-vocabulary'
import { isGroupingGone } from '@/lib/joint-display-report'
import { isImplicitPair } from '@/lib/joint-display-strands'

interface PinPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  display: JointDisplay
  construct: string
  group: string
  /** The row's codes the server resolved (name for each id) — with its strand (joint display slice 2, r2-5). */
  codes: { id: number; name: string; strandKey?: string }[]
  scope: DisplayCoderScope
  /** Adds the pin to the LIVE display (`commitDisplay`); says whether it was already pinned. */
  onPin: (pin: JointDisplayPin) => 'added' | 'duplicate' | 'failed'
}

export default function PinPicker(props: PinPickerProps) {
  const { open, onOpenChange, construct, group } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Pin a quote · {group} · {construct}</DialogTitle>
          <DialogDescription>
            {PIN_PICKER_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>
        {open && <PickerBody {...props} />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * One suggestion: a passage of a conversation or document, or (joint display slice 2, r4-2) a
 * coded open-text ANSWER — always the whole answer, since a quote of an answer is the whole
 * answer (`excerpt_text_from`; the withdrawal scrub matches it by equality, #1473).
 */
type Passage =
  | { kind: 'segment'; key: string; segment: CodedSegmentWithContext; text: string; who: string | null; source: string; quoted: boolean }
  | { kind: 'answer'; key: string; answer: JointDisplayAnswerPassage; text: string; who: string | null; source: string; quoted: boolean }

function PickerBody({
  projectId, display, group, codes, scope, onPin,
}: PinPickerProps) {
  const queryClient = useQueryClient()
  // Joint display slice 2 (r2-5): the choice is a (strand, code) — one code may sit on two
  // strands over different sources, and a quote is chosen from ITS strand's sources.
  const [choice, setChoice] = useState(0)
  const codeId = codes[choice]?.id ?? null
  const strandKey = codes[choice]?.strandKey
  const [pinning, setPinning] = useState<string | null>(null)
  // R9 (r2-5, r4-1): the request is the model's one builder, from the PIN'S STRAND — a codes
  // strand's conversations and documents, or a survey comments strand's questions — so a
  // suggestion is a passage that strand's numbers count (D209).
  const request = useMemo(
    () => (codeId == null ? null : pinPassagesRequest(display, strandKey, group, codeId, scope)),
    [display, strandKey, group, codeId, scope],
  )
  // #1668 (D344): the words follow the same strand the request reads — answers or passages.
  const words = pinPickerText(pinPoolUnit(display, strandKey))

  // The key IS the request, so it carries the effective coder scope (#454).
  const query = useQuery({
    queryKey: ['joint-display-passages', projectId, request],
    queryFn: () => jointDisplayApi.passages(projectId, request!),
    enabled: request != null,
  })
  const status = request == null ? 'ready' : listStatus(query)

  const passages: Passage[] = useMemo(() => {
    const out: Passage[] = []
    const seg = (s: CodedSegmentWithContext, source: string): Passage => ({
      kind: 'segment', key: `s${s.id}`, segment: s, text: s.text,
      who: s.participant_name ?? s.speaker_name, source, quoted: s.is_quoted,
    })
    for (const conv of query.data?.conversations ?? []) {
      for (const s of conv.segments) out.push(seg(s, conv.conversation_name))
    }
    for (const doc of query.data?.documents ?? []) {
      for (const s of doc.segments) out.push(seg(s, doc.document_name))
    }
    for (const a of query.data?.answers ?? []) {
      out.push({ kind: 'answer', key: `a${a.dataset_value_id}`, answer: a, text: a.text,
        who: a.participant_name, source: a.source_name, quoted: a.is_quoted })
    }
    return out
  }, [query.data])

  const pin = async (p: Passage) => {
    setPinning(p.key)
    try {
      const quote = await excerptsApi.wholePassage(projectId, p.kind === 'answer'
        ? { dataset_value_id: p.answer.dataset_value_id }
        : { segment_id: p.segment.id })
      const outcome = onPin({
        ...(excerptEmbedAttrs(quote) as Omit<JointDisplayPin, 'group' | 'role' | 'purpose'>), group, role: null, purpose: '',
        // r2-5: a plain key, only on a display with named strands (a slice-1 pin carries none).
        ...(strandKey && !isImplicitPair(display) ? { strand: strandKey } : {}),
      })
      if (outcome === 'duplicate') toast.info('That quote is already pinned in this group.')
      if (outcome === 'added') toast.success('Quote pinned.')
      if (quote.created) {
        // A new quote: the Quote Board's and the passage lists' "quoted" marks move.
        queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        queryClient.invalidateQueries({ queryKey: ['joint-display-passages', projectId] })
      }
    } catch {
      toast.error('The quote could not be pinned.')
    } finally {
      setPinning(null)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {codes.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-mm-text-secondary">Code</span>
          <select
            className="h-8 rounded-md border border-mm-border-medium bg-mm-surface px-2 text-sm text-mm-text"
            value={choice}
            onChange={e => setChoice(Number(e.target.value))}
          >
            {codes.map((c, i) => <option key={`${c.strandKey ?? ''}:${c.id}`} value={i}>{c.name}</option>)}
          </select>
        </label>
      )}
      {codes.length === 0 && (
        <p className="text-sm text-mm-text-muted">This construct binds no code, so there are no coded passages to pin from.</p>
      )}
      {status === 'loading' && <LoadingNotice label={words.loading} size="panel" />}
      {status === 'failed' && (
        <p role="alert" className="text-sm text-mm-text">
          {/* #1653 (D347): a gone grouping variable in the display's own sentence. */}
          {isGroupingGone(query.error) ? GROUPING_GONE_TEXT : `${words.failed} ${loadFailureReason(query.error)}`}
        </p>
      )}
      {status === 'ready' && request != null && (
        <>
          <p className="text-xs text-mm-text-muted" aria-live="polite">
            {words.count(query.data?.total_segments ?? 0, query.data?.has_more === true)}
          </p>
          <ul className="flex-1 min-h-0 overflow-y-auto space-y-2" aria-label={words.list}>
            {passages.length === 0 && (
              <li className="text-sm text-mm-text-muted">{words.empty}</li>
            )}
            {passages.map(p => (
              <li key={p.key} className="flex items-start gap-3 rounded-md border border-mm-border-subtle px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-mm-text">“{p.text}”</p>
                  <p className="mt-0.5 text-xs text-mm-text-muted">
                    {[p.who, p.source].filter(Boolean).join(' · ')}
                    {p.quoted ? ' · already a quote' : ''}
                  </p>
                </div>
                <Button
                  type="button" size="sm" variant="outline" className={MODE_DISABLED_CLASS}
                  aria-label={`Pin “${p.text.slice(0, 60)}”`}
                  aria-disabled={pinning != null}
                  onClick={() => { if (pinning == null) void pin(p) }}
                >
                  {pinning === p.key ? 'Pinning…' : 'Pin'}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
