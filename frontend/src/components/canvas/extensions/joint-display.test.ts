/**
 * The joint display's NODE (ROADMAP row 56, D162): its three attributes survive the HTML round
 * trip (this directory's the internal design notes: every attr in THREE places or it is dropped silently), the
 * schema-aware cleaner keeps it, and BOTH editors register it — an editor that does not would
 * turn it into an empty paragraph and its self-healing save would delete it (D164's older-build
 * case, inside this build).
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateHTML, generateJSON, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { stripComments } from '@/lib/strip-comments'
import { cleanCanvasContent } from '../canvas-utils'

vi.mock('./JointDisplayView', () => ({ default: () => null }))
const { JointDisplay } = await import('./joint-display')

const DISPLAY = {
  title: 'Teachers by gain group',
  group_by_column_id: 11,
  rows: [{ key: 'r1', construct: 'Training “dosage” & <adequacy>', code_ids: [31, null],
    pins: [{ excerptId: 41, displayText: 'It wasn’t enough — "eight hours".', group: 'High', role: 'typical' }] }],
}
const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Prose.' }] },
    { type: 'joint-display', attrs: { displayKey: 'k-1', figureEpoch: 3, display: DISPLAY } },
  ],
}
const extensions = [StarterKit, JointDisplay]

describe('the joint-display node', () => {
  it('round-trips all three attributes through HTML, quotes and markup in the text included', () => {
    const html = generateHTML(doc, extensions)
    expect(html).toContain('data-type="joint-display"')
    const back = generateJSON(html, extensions) as typeof doc
    const node = back.content.find(n => n.type === 'joint-display') as (typeof doc.content)[1]
    expect(node.attrs).toEqual({ displayKey: 'k-1', figureEpoch: 3, display: DISPLAY })
  })

  it('is kept by the schema-aware cleaner when the editor registers it — and lost when it does not', () => {
    const withNode = getSchema(extensions)
    const kept = cleanCanvasContent(doc, new Set(Object.keys(withNode.nodes)), new Set(Object.keys(withNode.marks)))
    expect(kept.rewrites).toEqual([])
    expect(kept.cleaned?.content?.[1]).toEqual(doc.content[1])
    // The control: an editor without the node rewrites it — the loss the registration prevents.
    const without = getSchema([StarterKit])
    const lost = cleanCanvasContent(doc, new Set(Object.keys(without.nodes)), new Set(Object.keys(without.marks)))
    expect(lost.cleaned?.content?.some(n => n.type === 'joint-display')).toBe(false)
  })

  it('both editors register it (the writable theme editor and the read-only Compare view)', () => {
    for (const rel of ['../ThemeEditor.tsx', '../../../pages/CanvasCompareView.tsx']) {
      const path = join(__dirname, rel)
      const src = stripComments(readFileSync(path, 'utf8'), path)
      expect(src.length, `read ${rel}`).toBeGreaterThan(2_000)
      // The theme editor lists the node; Compare configures it per side (#1699, D379).
      expect(src, rel).toMatch(/\bJointDisplay(,|\.configure\(\{ stateScope: )/)
    }
  })

  it('is placed under the current fingerprint generation through ONE door', () => {
    const path = join(__dirname, '../ThemeEditor.tsx')
    const src = stripComments(readFileSync(path, 'utf8'), path)
    expect(src).toMatch(/insertWithPendingSlash\('joint-display', \{ \.\.\.attrs, figureEpoch: CURRENT_FIGURE_EPOCH \}\)/)
  })
})
