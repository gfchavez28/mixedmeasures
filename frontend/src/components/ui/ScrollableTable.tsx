import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * #385: a height-constrained scroll container for wide tables that live inside
 * a vertically-scrolling page. Scrolls BOTH axes within a bounded box so the
 * horizontal scrollbar pins to the box bottom (reachable) instead of riding the
 * bottom of the full content (the split-scroll bug fixed in DatasetView / #383).
 *
 * The `data-scrollable-table` marker is load-bearing: `lib/chart-export.tsx`
 * temporarily un-clamps these during PNG/SVG capture so exports aren't clipped
 * to the visible rows.
 *
 * Tables with a `sticky top-0` thead keep working — the header sticks to this
 * container. For sticky-left columns, follow the #383 z-layering: body cells
 * z-10, header cells z-20, sticky top-left corner z-30.
 *
 * 🔴 `relative` is load-bearing (#1156): the box must be the CONTAINING BLOCK of
 * what it scrolls. An `sr-only` span is `position: absolute`, and an overflow box
 * clips an absolute descendant only when it is that descendant's containing block —
 * so on the Participants page each row's screen-reader-only "Conversation:" word,
 * resolved against an ancestor size container instead, sat where its row was,
 * 70vh-and-beyond down the page, and the window scrolled ~1,050 px past the table
 * into a blank screen. jsdom computes no layout; `ScrollableTable.test.tsx` pins the
 * technique and the live check is pressing End at 640×360 and 1280×900.
 */
function ScrollableTable({
  className,
  maxHeight = "70vh",
  style,
  ref,
  ...props
}: React.ComponentProps<"div"> & { maxHeight?: string }) {
  return (
    <div
      ref={ref}
      data-scrollable-table=""
      className={cn("relative overflow-auto", className)}
      style={{ maxHeight, ...style }}
      {...props}
    />
  )
}

export { ScrollableTable }
