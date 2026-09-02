import { TriangleAlert } from 'lucide-react'
import { getCodeColor, getContrastColor } from '@/lib/utils'
import { coderColor, coderInitials } from '@/lib/coder-color'
import {
  describeMagnitude,
  formatMagnitude,
  isUnrated,
  normalizedPosition,
  type Magnitude,
  type MagnitudeScale,
} from '@/lib/magnitude'

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
  /**
   * #35 — this coder's rating on `scale`, or null for UNRATED.
   *
   * ⚠️ The magnitude UI renders ONLY when `scale` is present: a number with no
   * declared instrument is exactly the MAXQDA "fuzzy variable" this feature exists
   * not to be. A code without a scale is chipped exactly as before.
   */
  magnitude?: Magnitude
  scale?: MagnitudeScale | null
  /**
   * #35 — the rating a MERGED copy of this same application carried when it
   * differed from `magnitude` (the merge kept ours). Rendered only against a
   * `scale`, like the rating itself: a marker beside the value, and the fact as
   * text. `null`/absent = no unresolved conflict.
   */
  magnitudeConflict?: number | null
}

export default function CodeChip({
  code, size = 'sm', onClick, coder, truncate, tabbable = true, magnitude, scale, magnitudeConflict,
}: CodeChipProps) {
  const bgColor = getCodeColor(code)
  const textColor = getContrastColor(bgColor)

  // A rating is shown only against a declared scale — see `scale` above.
  const rated = !!scale
  const unrated = isUnrated(magnitude)
  // `!= null`, never truthiness: a merged copy that rated it 0 is a conflict.
  const conflicted = rated && magnitudeConflict != null

  // 🔴 The track's shades are explicit rgba, NOT `currentColor` + `opacity`.
  // `opacity` cascades to children, so an opacity-dimmed track would dim the fill
  // inside it by the same factor and the two would be indistinguishable — the
  // meter would render as a flat bar at every value. `getContrastColor` returns
  // pure #000000 or #ffffff (#667), so the triplet is safe to derive.
  const ink = textColor === '#000000' ? '0, 0, 0' : '255, 255, 255'

  // The track needs bottom room. Only pay it when a track actually renders, so a
  // codebook without magnitude keeps its existing vertical rhythm exactly.
  const sizeClasses = size === 'xs'
    ? `text-[10px] px-1.5 ${rated ? 'pt-0.5 pb-[6px]' : 'py-0.5'}`
    : `text-[11px] px-2 ${rated ? 'pt-0.5 pb-[6px]' : 'py-0.5'}`

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
      {rated && (
        <>
          {/*
            The VALUE, printed exactly. `formatMagnitude` renders a Unicode minus
            rather than a hyphen — at 10px in a proportional font a hyphen reads as
            a dash, which on a bipolar scale is the difference between −1 and 1.
          */}
          <span
            className="font-mono text-[9.5px] font-bold leading-none px-1 rounded-[3px] shrink-0 tabular-nums"
            style={{
              backgroundColor: `rgba(${ink}, ${unrated ? 0.10 : 0.22})`,
              color: textColor,
            }}
            aria-hidden="true"
          >
            {unrated ? '—' : formatMagnitude(magnitude as number)}
          </span>
          {/*
            The normalized track: where this value sits WITHIN ITS OWN RANGE, which
            is what makes two different scales comparable at a glance.

            ⚠️ INSET from the pill edge and LIFTED off the bottom, deliberately.
            Run flush at `bottom: 0` full-width it reads as a heavier border rather
            than a meter — reviewed and rejected in the mockup round.

            ⚠️ Shades derive from `getContrastColor`'s pure black/white (#667), so
            the meter reads on a pale code colour as well as a dark one.

            ⚠️ `aria-hidden`: a bar announces nothing. The fact travels as the
            sr-only sentence below (#753's split).
          */}
          <span
            className="absolute left-[6px] right-[6px] bottom-[2px] h-[3px] rounded-full overflow-hidden"
            style={
              unrated
                ? {
                    backgroundImage:
                      `repeating-linear-gradient(90deg, rgba(${ink}, 0.42) 0 2px, transparent 2px 4px)`,
                  }
                : { backgroundColor: `rgba(${ink}, 0.24)` }
            }
            aria-hidden="true"
          >
            {!unrated && (
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${normalizedPosition(magnitude as number, scale) * 100}%`,
                  backgroundColor: `rgba(${ink}, 0.95)`,
                }}
              />
            )}
          </span>
          <span className="sr-only">
            {/* Leading comma so name-from-contents reads "Joy, 8 out of 10" */}
            {`, ${describeMagnitude(magnitude, scale)}`}
          </span>
          {conflicted && (
            <>
              {/*
                #35 — the merge disagreement flag. The OTHER number, not a bare
                mark: "≠5" says what the merged copy rated, so the coder can
                adjudicate from the chip. Amber is the status colour for
                "needs review" here (never colour alone: the icon and the text
                both carry it, and the fact is spoken below).
              */}
              <span
                className="inline-flex items-center gap-0.5 font-mono text-[9.5px] font-bold leading-none px-1 rounded-[3px] shrink-0 tabular-nums bg-amber-400 text-black"
                title={`A merged copy of your coding rated this ${formatMagnitude(magnitudeConflict as number)}; your rating was kept. Rate it again to settle the difference.`}
                aria-hidden="true"
              >
                <TriangleAlert className="w-2.5 h-2.5" aria-hidden="true" />
                ≠{formatMagnitude(magnitudeConflict as number)}
              </span>
              <span className="sr-only">
                {`, a merged copy rated it ${formatMagnitude(magnitudeConflict as number)}`}
              </span>
            </>
          )}
        </>
      )}
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
