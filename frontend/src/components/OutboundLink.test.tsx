/**
 * #1625 (D240): `OutboundLink` is the ONE place a link opens outside the app — the
 * desktop shell sends an off-app https link to the system browser, and denies every
 * same-origin new window. Its href type admits only https (a compile-time fact; the
 * `@ts-expect-error` below fails `tsc` if that ever loosens).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OutboundLink } from './OutboundLink'

afterEach(() => cleanup())

describe('OutboundLink', () => {
  it('opens an https link in a new window, with no opener or referrer', () => {
    render(<OutboundLink href="https://example.org/releases" className="x">Release notes</OutboundLink>)
    const link = screen.getByRole('link', { name: 'Release notes' })
    expect(link).toHaveAttribute('href', 'https://example.org/releases')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveClass('x')
  })

  it('refuses an app path at compile time', () => {
    // @ts-expect-error — an in-app path is a router <Link>, never an OutboundLink (#1625).
    render(<OutboundLink href="/projects/1/datasets/2">Data</OutboundLink>)
    expect(screen.getByRole('link', { name: 'Data' })).toBeInTheDocument()
  })
})
