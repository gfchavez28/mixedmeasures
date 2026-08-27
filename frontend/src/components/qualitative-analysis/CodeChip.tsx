import { getCodeColor, getContrastColor } from '@/lib/utils'
import { coderColor, coderInitials } from '@/lib/coder-color'

interface CodeChipProps {
  code: { id: number; name: string; color: string | null; category_color?: string | null; category_name?: string | null }
  size?: 'sm' | 'xs'
  onClick?: (codeId: number) => void
  // Track J · J1: when present, render a dual-encoded (initials + color) attribution
  // badge for the coder who applied this code. Only passed in multi-coder mode.
  // `archived` (#451) flags a coder who has left the roster — the badge dims and the
  // label says "(archived)" so they're never mistaken for an unattributed code.
  coder?: { id: number; username: string; display_color?: string | null; archived?: boolean } | null
  // Cap the chip at its parent's width and ellipsize the label (full name still revealed
  // on hover via the title). For narrow fixed-width columns like the reconciliation grid,
  // where an un-truncated chip would bleed into the neighbouring column.
  truncate?: boolean
  /**
   * #771 — remove this chip from the TAB ORDER without removing it from the
   * page. A `role="option"` row that carries interactive descendants costs the
   * keyboard user one stop per control per row; gating the stop on selection
   * keeps the control clickable and reachable while making a tour of the list
   * cost one stop per row. Only meaningful when `onClick` is supplied (that is
   * what makes this a `<button>` at all).
   */
  tabbable?: boolean
}

export default function CodeChip({ code, size = 'sm', onClick, coder, truncate, tabbable = true }: CodeChipProps) {
  const bgColor = getCodeColor(code)
  const textColor = getContrastColor(bgColor)

  const sizeClasses = size === 'xs'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-[11px] px-2 py-0.5'

  const Tag = onClick ? 'button' : 'span'

  const badgeColor = coder ? coderColor(coder) : ''

  return (
    <Tag
      className={`${sizeClasses} rounded-full inline-flex items-center gap-1 leading-tight ${
        truncate ? 'max-w-full min-w-0' : 'whitespace-nowrap'
      } ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      style={{ backgroundColor: bgColor, color: textColor }}
      title={code.category_name ? `${code.name} (${code.category_name})` : code.name}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(code.id) } : undefined}
      tabIndex={onClick && !tabbable ? -1 : undefined}
    >
      {truncate ? <span className="truncate min-w-0">{code.name}</span> : code.name}
      {coder && (
        <>
          {/*
            #753 — the initials are a DUAL ENCODING of the badge colour, for
            sighted colour-blind readers. They are not information a screen
            reader needs, and the attribution beside them is.

            Measured in Chrome's accessibility tree, because this is a place
            reasoning goes wrong in both directions. The badge's `aria-label` DID
            reach the chip's name (naming-prohibited on `generic` is not applied
            here, so "the label is being dropped" is false) — but the "TE" text
            node stayed in the tree as a child regardless, which is what NVDA
            read out beside the name. `role="img"` does not prune it either;
            only `aria-hidden` does, and hiding the span alone would take the
            label with it and leave the chip saying nothing about who coded it.

            So: hide the visual badge, and carry the attribution as its own text.
            It contributes through name-from-contents, which works for the
            read-only `<span>` chip too — an `aria-label` there would be a bare
            span with no role, the shape #700 found silently dropped.
          */}
          <span
            className={`inline-flex items-center justify-center rounded-full font-semibold leading-none px-1 text-[8px] shrink-0${coder.archived ? ' opacity-60 ring-1 ring-current' : ''}`}
            style={{ backgroundColor: badgeColor, color: getContrastColor(badgeColor), minWidth: '12px', height: '12px' }}
            aria-hidden="true"
            title={`coded by ${coder.username}${coder.archived ? ' (archived)' : ''}`}
          >
            {coderInitials(coder.username)}
          </span>
          <span className="sr-only">
            coded by {coder.username}{coder.archived ? ' (archived)' : ''}
          </span>
        </>
      )}
    </Tag>
  )
}
