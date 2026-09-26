/**
 * The machine-coder provenance fields — ONE copy, used by the coding import and
 * the machine-coder dialog.
 *
 * ⚠️ `fireEvent`, never `user-event` (not a dependency of this repo).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

import MachineProvenanceFields, { type MachineProvenanceValues } from './MachineProvenanceFields'

afterEach(cleanup)

const EMPTY: MachineProvenanceValues = { model: '', access: '', parameters: '', prompt: '' }

function Harness({ initial = EMPTY }: { initial?: MachineProvenanceValues }) {
  const [values, setValues] = useState(initial)
  return (
    <MachineProvenanceFields
      idPrefix="t"
      values={values}
      onChange={patch => setValues(prev => ({ ...prev, ...patch }))}
    />
  )
}

describe('MachineProvenanceFields', () => {
  it('🔴 Settings is MULTI-LINE — a single-line input deletes pasted line breaks', () => {
    // `temperature=0⏎top_p=1` in an <input> arrives as one setting whose value
    // is "0top_p=1". A textarea keeps the break the parser splits on.
    render(<Harness initial={{ ...EMPTY, parameters: 'temperature=0\ntop_p=1' }} />)
    const settings = screen.getByLabelText('Settings')
    expect(settings.tagName).toBe('TEXTAREA')
    expect(settings).toHaveValue('temperature=0\ntop_p=1')
  })

  it('🔴 SAYS which settings will not be recorded, in the field’s description', () => {
    render(<Harness initial={{ ...EMPTY, parameters: 'temperature: 0, top_p=1' }} />)
    const settings = screen.getByLabelText('Settings')
    expect(screen.getByText(/Will not be recorded: “temperature: 0”/)).toBeInTheDocument()
    expect(settings).toHaveAccessibleDescription(/Will not be recorded: “temperature: 0”/)
  })

  it('says nothing when every setting is readable', () => {
    render(<Harness initial={{ ...EMPTY, parameters: 'temperature=0, top_p=1' }} />)
    expect(screen.queryByText(/Will not be recorded/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Settings')).not.toHaveAccessibleDescription(/Will not/)
  })

  it('an EXAMPLE reads as an example, never as a filled-in value', () => {
    // The model placeholder was the bare string "gpt-4o-2024-08-06" and looked
    // recorded; a researcher could leave it blank believing it was.
    render(<Harness />)
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', expect.stringMatching(/^e\.g\. /))
    expect(screen.getByLabelText('Settings')).toHaveAttribute('placeholder', expect.stringMatching(/^e\.g\. /))
    expect(screen.getByLabelText('Model')).toHaveAccessibleDescription(/recorded as not known/)
  })

  it('the prompt uses the shared Textarea, not a hand-rolled one', () => {
    // The hand-rolled copy sat on a darker fill with no focus ring and read as
    // disabled. Source-level, because jsdom resolves no Tailwind.
    const file = join(__dirname, 'MachineProvenanceFields.tsx')
    const src = stripComments(readFileSync(file, 'utf8'), file)
    expect(src).not.toMatch(/<textarea\b/)
    expect(src).toMatch(/from '@\/components\/ui\/textarea'/)
  })
})

describe('the provenance form has ONE home', () => {
  it('neither consumer re-declares the fields', () => {
    // Two copies had drifted (different settings examples) and shared both
    // defects; a third copy would start the split again.
    for (const rel of ['../pages/CodingImport.tsx', './MachineCoderDialog.tsx']) {
      const file = join(__dirname, rel)
      const src = stripComments(readFileSync(file, 'utf8'), file)
      expect(src, rel).toMatch(/<MachineProvenanceFields\b/)
      expect(src, rel).not.toMatch(/How it was reached/)
      expect(src, rel).not.toMatch(/<textarea\b/)
    }
  })
})
