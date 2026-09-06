import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { cn, getCodeColor } from '@/lib/utils'
import { isCodeAppliedByActiveCoder } from '@/lib/coding-progress'
import type { Code, TextCodingResponse } from '@/lib/api'
import type { FloatingCoords } from '@/lib/floating-utils'

interface TextCodingContextMenuProps {
  comment: TextCodingResponse
  activeCodes: Array<{ id: number; name: string; color: string | null; is_active?: boolean; category_id?: number | null; category_color?: string | null }>
  codeIdToShortcutLabel: Map<number, string>
  onQuoteToggle: (dvId: number) => void
  onContextCodeApply?: (dvId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (dvId: number, coords: FloatingCoords) => void
  lastCoordsRef: React.RefObject<FloatingCoords | null>
  /** Track J · J1: active coder, so the "applied" check is per-me (#446). */
  activeCoderId?: number | null
  /**
   * #868 (d) — re-open the rating strip for an application that already exists.
   * The pointer route to the `r` verb, and the one that NAMES each code, which
   * is how a response carrying two scaled codes is disambiguated. What is
   * ratable comes from the host's `ratableCodes` derivation (`lib/rating-targets.ts`)
   * so this menu and the verb cannot disagree.
   */
  onRateCode?: (dvId: number, code: Code) => void
  ratableCodesFor?: (dvId: number) => Code[]
}

export default function TextCodingContextMenu({
  comment,
  activeCodes,
  codeIdToShortcutLabel,
  onQuoteToggle,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  lastCoordsRef,
  activeCoderId,
  onRateCode,
  ratableCodesFor,
}: TextCodingContextMenuProps) {
  const recordLabel = comment.row_identifier || comment.participant_name || `R${comment.dataset_row_id}`

  return (
    <ContextMenuContent>
      {/* ── Primary coding actions ── */}
      {onContextCodeApply && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Apply Code</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-64 overflow-y-auto w-52">
            {onContextCreateCode && (
              <>
                <ContextMenuItem onClick={() => onContextCreateCode(lastCoordsRef.current!)}>
                  New Code...
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {activeCodes.map(code => {
              const isApplied = isCodeAppliedByActiveCoder(comment.applied_code_details, comment.applied_code_ids ?? [], code.id, activeCoderId ?? null)
              const label = codeIdToShortcutLabel.get(code.id) ?? ''
              return (
                <ContextMenuItem
                  key={code.id}
                  onClick={() => onContextCodeApply(comment.dataset_value_id, code.id)}
                >
                  <span className="flex items-center gap-2 flex-1 min-w-0">
                    {isApplied && <Check className="w-3 h-3 text-green-600 flex-shrink-0" />}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: getCodeColor(code) }}
                    />
                    <span className={cn('truncate', isApplied && 'font-bold')}>{code.name}</span>
                  </span>
                  {label && (
                    <span className="text-xs text-mm-text-faint ml-2 font-mono flex-shrink-0">{label}</span>
                  )}
                </ContextMenuItem>
              )
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {onContextCreateNote && (
        <ContextMenuItem onClick={() => onContextCreateNote(comment.dataset_value_id, lastCoordsRef.current!)}>
          Add Note
        </ContextMenuItem>
      )}
      {/* #868 (d) — one item per code THIS coder has applied that declares a
          scale (the document row's exact shape). Absent, not disabled, when
          there is nothing to rate: the menu is already long. */}
      {onRateCode && ratableCodesFor && ratableCodesFor(comment.dataset_value_id).map(code => (
        <ContextMenuItem key={`rate-${code.id}`} onClick={() => onRateCode(comment.dataset_value_id, code)}>
          Rate &ldquo;{code.name}&rdquo;… <span className="text-xs text-mm-text-faint ml-2 font-mono">r</span>
        </ContextMenuItem>
      ))}
      <ContextMenuItem onClick={() => onQuoteToggle(comment.dataset_value_id)}>
        {comment.is_quoted ? 'Unquote' : 'Quote'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* ── Clipboard ── */}
      <ContextMenuItem
        onClick={() => {
          if (comment.value_text) {
            navigator.clipboard.writeText(comment.value_text)
            toast.success('Copied to clipboard')
          }
        }}
      >
        Copy Text
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          const quote = `"${comment.value_text || ''}" — ${recordLabel}`
          navigator.clipboard.writeText(quote)
          toast.success('Copied to clipboard')
        }}
      >
        Copy as Quote
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
