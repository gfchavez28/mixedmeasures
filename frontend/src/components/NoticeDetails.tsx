import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The notice rule's R3 (decided 2026-11-18; record the internal design notes,
 * git-ignored): a notice states on screen only what the researcher needs to read this number,
 * decide this action or recover. The longer account lives here, in ONE collapsed section on the
 * same screen, until the in-app guide exists.
 *
 * - The browser's own `<details>`, as the formula reference (`ColumnFormDialog`) and the
 *   reliability tab's disagreement tables (`IrrMatrix`) already use: keyboards and screen readers
 *   handle it with no library.
 * - It holds no state and has no `open` prop, so it is closed every time its notice mounts.
 * - `label` names what is inside ("Where copies remain and what the record recognises"), never a
 *   bare "More" or "Details".
 * - Closed, its contents are not rendered, so a dialog description holding it reads only the
 *   short text on opening. Check that in Chrome's accessibility tree; jsdom cannot show it.
 * - The summary is at least 24 px tall (WCAG 2.5.8).
 */
export function NoticeDetails({
  label, children, className,
}: { label: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn('group text-xs', className)} data-notice-details="">
      <summary
        className={
          'inline-flex min-h-6 cursor-pointer select-none list-none items-center gap-1 rounded-sm '
          + 'text-mm-text-muted hover:text-mm-text focus-visible:outline-none focus-visible:ring-2 '
          + 'focus-visible:ring-ring [&::-webkit-details-marker]:hidden'
        }
      >
        <ChevronRight aria-hidden="true" className="h-3 w-3 flex-shrink-0 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="mt-1 space-y-1 pl-4 text-mm-text-secondary">{children}</div>
    </details>
  )
}
