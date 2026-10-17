/**
 * #1117 — the import confirmation says which version made a project file, as a fact,
 * where it used to show an amber warning that an older file "may not import correctly".
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import ProjectFileOrigin from './ProjectFileOrigin'

afterEach(cleanup)

describe('ProjectFileOrigin (#1117)', () => {
  it('names the version that made the file', () => {
    render(<ProjectFileOrigin appVersion="1.0.0" />)
    expect(screen.getByText('Made with Mixed Measures 1.0.0.')).toBeInTheDocument()
  })

  it('says nothing when the file does not say', () => {
    const { container: absent } = render(<ProjectFileOrigin appVersion={undefined} />)
    expect(absent).toBeEmptyDOMElement()
    cleanup()
    const { container: unknown } = render(<ProjectFileOrigin appVersion="unknown" />)
    expect(unknown).toBeEmptyDOMElement()
  })

  it('is what the import confirmation renders, from the manifest', () => {
    const src = stripComments(readFileSync(join(__dirname, '..', 'pages', 'Dashboard.tsx'), 'utf8'))
    expect(src).toContain('<ProjectFileOrigin appVersion={importPreview?.manifest?.app_version} />')
  })
})
