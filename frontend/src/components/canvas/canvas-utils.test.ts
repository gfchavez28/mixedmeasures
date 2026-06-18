/**
 * Tests for `cleanCanvasContent` — the schema-aware Tiptap content cleaner.
 *
 * The cleaner exists because the canvas Writing editor disables several node
 * types (heading, codeBlock, inline `code` mark). Without the cleaner, Tiptap
 * silently drops disallowed nodes during init, producing visibly-empty themes
 * for docs that round-trip fine through Word export. These tests pin the
 * transform rules so a future StarterKit upgrade or extension change can't
 * silently regress the recovery behavior.
 */

import { describe, it, expect } from 'vitest'
import { cleanCanvasContent, describeRewrites } from './canvas-utils'
import type { JSONContent } from '@tiptap/core'

// Allowlist mirrors the actual schema produced by useCanvasEditor (StarterKit
// minus heading/codeBlock/code, plus list nodes, blockquote, hardBreak, plus
// the canvas-specific embed types).
const ALLOWED_NODES = new Set([
  'doc', 'paragraph', 'text', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'hardBreak', 'horizontalRule',
  'excerpt-embed', 'chart-embed', 'memo-embed', 'callout-stat', 'image-embed',
  'mention',
])
const ALLOWED_MARKS = new Set(['bold', 'italic', 'strike', 'link'])

describe('cleanCanvasContent', () => {
  it('returns clean content untouched + no rewrites', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([])
    expect(cleaned).toEqual(doc)
  })

  it('converts heading → paragraph with bold marks (preserves emphasis)', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'My finding' }],
        },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([{ type: 'heading', transformedTo: 'bold-paragraph' }])
    expect(cleaned).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'My finding', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    })
  })

  it('does not duplicate bold marks if text was already bold inside a heading', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Bold heading', marks: [{ type: 'bold' }] }],
        },
      ],
    }
    const { cleaned } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    const text = (cleaned!.content![0].content![0] as JSONContent)
    expect(text.marks).toEqual([{ type: 'bold' }])
  })

  it('converts codeBlock → paragraph (no bold added)', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'python' },
          content: [{ type: 'text', text: 'print(1)' }],
        },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([{ type: 'codeBlock', transformedTo: 'paragraph' }])
    expect(cleaned!.content![0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'print(1)' }],
    })
  })

  it('strips disallowed marks from text nodes', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'inline', marks: [{ type: 'code' }, { type: 'bold' }] },
          ],
        },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([{ type: 'code', transformedTo: 'mark-dropped' }])
    const text = cleaned!.content![0].content![0] as JSONContent
    expect(text.marks).toEqual([{ type: 'bold' }])
  })

  it('falls back to plain-text paragraph for fully unknown node types', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        // Hypothetical unknown node, e.g. from an old extension
        {
          type: 'pdf-embed',
          attrs: { src: '/foo.pdf' },
          content: [{ type: 'text', text: 'Fallback prose' }],
        },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([{ type: 'pdf-embed', transformedTo: 'plain-text' }])
    expect(cleaned!.content![0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Fallback prose' }],
    })
  })

  it('drops unknown nodes that yield no text', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'pdf-embed', attrs: { src: '/foo.pdf' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    }
    const { cleaned } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(cleaned!.content).toHaveLength(1)
    expect(cleaned!.content![0].type).toBe('paragraph')
  })

  it('preserves the root doc node even though `doc` is in the allowlist via special-case', () => {
    const minimal: JSONContent = { type: 'doc', content: [] }
    const { cleaned } = cleanCanvasContent(minimal, ALLOWED_NODES, ALLOWED_MARKS)
    expect(cleaned).toEqual({ type: 'doc', content: [] })
  })

  it('recurses into nested children (list with a heading inside)', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'heading',
                  attrs: { level: 4 },
                  content: [{ type: 'text', text: 'Nested' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const { cleaned, rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toEqual([{ type: 'heading', transformedTo: 'bold-paragraph' }])
    const listItem = cleaned!.content![0].content![0] as JSONContent
    expect(listItem.content![0].type).toBe('paragraph')
    const innerText = listItem.content![0].content![0] as JSONContent
    expect(innerText.marks).toEqual([{ type: 'bold' }])
  })

  it('deduplicates rewrites of the same (type, transformedTo) pair', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'B' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'C' }] },
      ],
    }
    const { rewrites } = cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]).toEqual({ type: 'heading', transformedTo: 'bold-paragraph' })
  })

  it('handles null / undefined / non-object content', () => {
    expect(cleanCanvasContent(null, ALLOWED_NODES, ALLOWED_MARKS)).toEqual({
      cleaned: null, rewrites: [],
    })
    expect(cleanCanvasContent(undefined, ALLOWED_NODES, ALLOWED_MARKS)).toEqual({
      cleaned: null, rewrites: [],
    })
  })

  it('does not mutate the input doc', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'X' }] },
      ],
    }
    const snapshot = JSON.parse(JSON.stringify(doc))
    cleanCanvasContent(doc, ALLOWED_NODES, ALLOWED_MARKS)
    expect(doc).toEqual(snapshot)
  })
})

describe('describeRewrites', () => {
  it('returns empty string for no rewrites', () => {
    expect(describeRewrites([])).toBe('')
  })

  it('describes the heading transform clearly', () => {
    const text = describeRewrites([{ type: 'heading', transformedTo: 'bold-paragraph' }])
    expect(text).toContain('headings')
    expect(text).toContain('bold')
  })

  it('combines multiple transforms with semicolons', () => {
    const text = describeRewrites([
      { type: 'heading', transformedTo: 'bold-paragraph' },
      { type: 'codeBlock', transformedTo: 'paragraph' },
    ])
    expect(text).toMatch(/headings/)
    expect(text).toMatch(/code blocks/)
    expect(text).toContain(';')
  })

  it('mentions dropped marks by name', () => {
    const text = describeRewrites([{ type: 'code', transformedTo: 'mark-dropped' }])
    expect(text).toContain('code')
  })
})
