import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { COMMANDS, DEFERRED_SLASH_TYPES, IMMEDIATE_SLASH_TYPES } from './slash-commands'

/**
 * #823(j) — the typed `/chart` is consumed by a command that COMPLETES.
 *
 * `ThemeEditor` used to delete the slash trigger the moment a command was
 * chosen, then hand chart/excerpt/memo to a drawer and image to the OS file
 * picker — every one of which the researcher can still cancel, leaving them
 * with neither an embed nor the text they typed.
 */

describe('every slash command is classified as deferred or immediate', () => {
  it('classifies all of them, and the two sets do not overlap', () => {
    // POPULATION assertion (#729/#730): a new command type must be classified
    // deliberately. Without this it silently inherits the immediate path — and
    // if it opens anything dismissable, it eats the researcher's text.
    for (const c of COMMANDS) {
      const deferred = DEFERRED_SLASH_TYPES.has(c.type)
      const immediate = IMMEDIATE_SLASH_TYPES.has(c.type)
      expect(deferred || immediate, `"${c.type}" is on neither side — classify it`).toBe(true)
      expect(deferred && immediate, `"${c.type}" is on both sides`).toBe(false)
    }
  })

  it('found a real command list', () => {
    // The loop above is vacuous over an empty array.
    expect(COMMANDS.length).toBeGreaterThan(5)
  })

  it('defers exactly the commands that open something dismissable', () => {
    // Measured against `WritingCanvas.handleThemeSlashCommand`: excerpt/chart/
    // memo open a drawer, image opens the OS file picker. heading/section
    // create a theme outright and open nothing.
    expect([...DEFERRED_SLASH_TYPES].sort()).toEqual(['chart', 'excerpt', 'image', 'memo'])
  })
})

describe('the editor consumes the trigger at the INSERT, not at the choice', () => {
  const SRC = join(__dirname, '..', 'ThemeEditor.tsx')
  const source = stripComments(readFileSync(SRC, 'utf8'), SRC)

  it('read the file it is scanning', () => {
    // Self-check per narrowing (#814): every assertion below is a substring
    // test and passes vacuously against an empty string.
    expect(source).toContain('SlashCommand.configure')
    expect(source.length).toBeGreaterThan(5_000)
  })

  it('routes the deferred commands through the pending range', () => {
    expect(source).toContain('DEFERRED_SLASH_TYPES')
    expect(source).toContain('pendingSlashRange')
  })

  it('all four insert handles go through ONE consumer', () => {
    // The reason this is a single helper: four call sites deleting a stored
    // range independently is four chances to forget the staleness check.
    for (const node of ['excerpt-embed', 'chart-embed', 'memo-embed', 'image-embed']) {
      expect(source).toContain(`insertWithPendingSlash('${node}'`)
    }
    // …and nobody inserts one of those nodes around it.
    const direct = source.match(/insertContent\(\{ type: '(excerpt|chart|memo|image)-embed'/g)
    expect(direct, 'an embed is inserted without consuming the pending slash range').toBeNull()
  })

  it('verifies the trigger is still there before deleting it', () => {
    // The three other entry points into these handles (drawer, pending item,
    // drag) typed nothing; a stale range must never eat a researcher's prose.
    expect(source).toMatch(/startsWith\('\/'\)/)
  })
})
