import { useEffect, useRef, type RefObject } from 'react'

/**
 * #963 — a Retry landing for a surface whose own container unmounts.
 *
 * `LoadFailedNotice`'s `landingRef` wants an element that stays mounted while
 * the retry runs and after it succeeds (`components/LoadStatus.tsx`). The list
 * pages return their load state EARLY — the whole page is either the notice or
 * the list — so nothing inside them survives a successful retry, and a ref to
 * the notice's own wrapper resolves to a detached node, on which `.focus()` is
 * a silent no-op. Focus would land on `<body>`, which is the failure #955 and
 * #959 exist to stop.
 *
 * So the landing is the element OUTSIDE the page that always exists: the
 * layout's `<main id="main-content" tabIndex={-1}>`, which is the skip link's
 * target and the last rung of the dialog focus ladder
 * (`lib/dialog-focus-return.ts`). Reusing that rung rather than inventing a
 * destination keeps "where does focus go when its control disappears?" a
 * question with one answer.
 *
 * ⚠️ Resolved in an effect, not during render: the element belongs to a parent
 * layout, and reading the DOM while rendering is not something a child may do.
 * ⚠️ It may legitimately be `null` — a page rendered outside `ProjectLayout`
 * has no such element — and `LoadFailedNotice` already treats a null landing as
 * "no destination", so the caller needs no branch.
 */
export function useMainContentLanding(): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    ref.current = document.getElementById('main-content')
  }, [])
  return ref
}
