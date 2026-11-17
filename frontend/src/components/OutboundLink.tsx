import type { AnchorHTMLAttributes, ReactNode } from 'react'

/**
 * #1625 (D240): the ONE place a link opens OUTSIDE the app.
 *
 * The packaged shell denies every new window and sends only off-app http(s) to the
 * system browser (`electron/main.js`'s `setWindowOpenHandler`), so a same-origin
 * `target="_blank"` link does NOTHING there — seven in-app links did nothing for
 * every packaged release. In-app links are router `<Link>`s and navigate in place.
 *
 * The href type admits only an https URL, so an app path cannot compile here, and
 * `frontend/eslint.config.js` refuses `target="_blank"` everywhere else.
 */
export type OutboundHref = `https://${string}`

interface OutboundLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> {
  href: OutboundHref
  children: ReactNode
}

export function OutboundLink({ href, children, ...rest }: OutboundLinkProps) {
  return (
    // eslint-disable-next-line no-restricted-syntax -- #1625 (D240): the one external-link component.
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  )
}
