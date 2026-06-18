/**
 * TypePickerPopover — Radix Popover wrapping a column-type swatch list.
 *
 * Phase 4.3/4.4: replaces the inline static type span on crosswalk cells
 * as the SINGLE entry point for changing a column's type (per directive
 * §2 item 25 — the cell context menu intentionally does NOT duplicate
 * this action). Click the badge → popover opens with all 9 column types
 * as a list of TypeBadge swatches; click one → fires onTypeChange and
 * closes.
 *
 * Pre-flight (foot-gun + GAP 3.9): if the column has any recode
 * definitions, type changes will 409 with `recode_definitions_exist`.
 * Rather than letting all 9 swatch clicks 409, the popover detects this
 * up front and shows ONLY a "Has recode definitions" message + Recode
 * Workbench link. Single round-trip avoided; researcher gets context.
 *
 * a11y:
 *   - Trigger has aria-label="Change type for {column_code}".
 *   - Each option is a button with type="button"; Radix Popover provides
 *     focus trap + Escape to close + return focus to trigger.
 *   - The current type is shown with aria-current="true" + check mark.
 *   - Disabled (in pre-flight state) trigger is still focusable but its
 *     aria-disabled prevents activation.
 */

import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { TypeBadge } from '@/components/TypeBadge'
import { COLUMN_TYPES } from '@/lib/dataset-constants'
import { Check, AlertCircle, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TypePickerPopoverProps {
  /** The current column type. */
  currentType: string
  /** Friendly column identifier for the trigger's aria-label. */
  columnCode: string | null
  columnText?: string
  /** Number of recode definitions on this column. >0 ⇒ pre-flight blocks
   * the picker and surfaces the Recode Workbench link instead. */
  recodeDefCount: number
  /** Project + dataset + column IDs needed to (a) build the Recode Workbench
   * link in pre-flight state, (b) thread to the type-change handler. */
  projectId: number
  datasetId: number
  columnId: number
  /** Fires when the user picks a different type. The parent is responsible
   * for the actual mutation (bulkTypeUpdate single-column array). */
  onTypeChange: (columnId: number, datasetId: number, newType: string) => void
  /** The clickable element (typically the existing type label). The
   * popover wraps this as the trigger. */
  children: ReactNode
}

export function TypePickerPopover({
  currentType,
  columnCode,
  columnText,
  recodeDefCount,
  projectId,
  datasetId,
  columnId,
  onTypeChange,
  children,
}: TypePickerPopoverProps) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const hasRecodes = recodeDefCount > 0

  const handlePick = (newType: string) => {
    if (newType === currentType) {
      setOpen(false)
      return
    }
    onTypeChange(columnId, datasetId, newType)
    setOpen(false)
  }

  const goToRecodeWorkbench = () => {
    navigate(
      `/projects/${projectId}/datasets/${datasetId}/recode?column=${columnId}`,
    )
    setOpen(false)
  }

  const triggerAria = `Change type for ${columnCode ?? `column ${columnId}`}${
    columnText ? `: ${columnText}` : ''
  } — current type ${currentType}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        aria-label={triggerAria}
        // Stop click from bubbling to the cell (which is also a draggable +
        // selectable). Without this, clicking the type label would also
        // toggle the cell's selection and start a drag activation.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="start"
        // Defensive: if the popover opens during a drag, the user probably
        // didn't mean to. Phase 3 pattern: handleDragStart closes popovers.
      >
        {hasRecodes ? (
          <div className="flex flex-col gap-2 p-2" data-testid="type-picker-recode-block">
            <div className="flex items-start gap-2">
              <AlertCircle
                className="w-4 h-4 flex-none text-amber-600 dark:text-amber-400 mt-0.5"
                aria-hidden
              />
              <div className="flex-1 text-sm">
                <p className="font-medium text-mm-text">
                  Has recode definitions
                </p>
                <p className="text-xs text-mm-text-muted mt-0.5">
                  {recodeDefCount === 1
                    ? 'This column has 1 recode definition.'
                    : `This column has ${recodeDefCount} recode definitions.`}{' '}
                  Clear them in the Recode Workbench before changing the type.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={goToRecodeWorkbench}
              className="self-end inline-flex items-center gap-1 text-xs text-mm-blue hover:underline focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded"
            >
              Open Recode Workbench
              <ExternalLink className="w-3 h-3" aria-hidden />
            </button>
          </div>
        ) : (
          <div role="menu" aria-label="Change column type" className="flex flex-col">
            <p className="text-[11px] text-mm-text-muted px-2 py-1.5 border-b border-mm-border-subtle">
              Change type for{' '}
              <span className="font-mono text-mm-text">
                {columnCode ?? `col ${columnId}`}
              </span>
            </p>
            {COLUMN_TYPES.map((t) => {
              const isCurrent = t === currentType
              return (
                <button
                  key={t}
                  type="button"
                  role="menuitem"
                  aria-current={isCurrent || undefined}
                  onClick={() => handlePick(t)}
                  className={cn(
                    'flex items-center justify-between gap-2 px-2 py-1.5 rounded',
                    'text-left text-sm hover:bg-mm-surface-hover',
                    'focus-visible:ring-2 focus-visible:ring-ring focus:outline-none',
                    isCurrent && 'bg-mm-bg/60',
                  )}
                  data-testid={`type-picker-option-${t}`}
                >
                  <TypeBadge type={t} />
                  {isCurrent && (
                    <Check
                      className="w-3.5 h-3.5 text-mm-text-muted flex-none"
                      aria-label="current"
                    />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
