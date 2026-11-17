/**
 * #1301 D269 — the section delete's confirmation says what the delete does, truly: the
 * materials leave this canvas and stay in the project, nested themes are un-nested, and
 * Ctrl+Z brings it all back. It used to say the materials "will be permanently deleted"
 * (false twice). A callout is not a project material, so it is never said to stay.
 */
import { describe, it, expect } from 'vitest'
import { themeDeleteConfirmText } from './canvas-theme-delete-entry'

const UNDO = 'Undo (Ctrl+Z) brings it all back while you stay on the Canvas page.'

describe('#1301 D269 — themeDeleteConfirmText', () => {
  it('reads the accepted sentence for materials and nested themes', () => {
    expect(themeDeleteConfirmText('Barriers', { materials: 3, callouts: 0, children: 2 })).toBe(
      '"Barriers" contains 3 embedded materials and has 2 nested themes. Deleting it takes the '
      + 'materials off this canvas (they stay in your project) and un-nests the themes. ' + UNDO,
    )
  })

  it('says each clause only when its count is non-zero, singular per count', () => {
    expect(themeDeleteConfirmText('A', { materials: 1, callouts: 0, children: 0 })).toBe(
      '"A" contains 1 embedded material. Deleting it takes the material off this canvas '
      + '(it stays in your project). ' + UNDO,
    )
    expect(themeDeleteConfirmText('B', { materials: 0, callouts: 0, children: 1 })).toBe(
      '"B" has 1 nested theme. Deleting it un-nests the theme. ' + UNDO,
    )
  })

  it('counts a callout apart, and never says it stays in the project', () => {
    const onlyCallout = themeDeleteConfirmText('C', { materials: 0, callouts: 1, children: 0 })
    expect(onlyCallout).toBe('"C" contains 1 callout. Deleting it removes the callout with it. ' + UNDO)
    expect(onlyCallout).not.toContain('stay in your project')
    expect(themeDeleteConfirmText('D', { materials: 2, callouts: 3, children: 1 })).toBe(
      '"D" contains 2 embedded materials and 3 callouts, and has 1 nested theme. Deleting it takes '
      + 'the materials off this canvas (they stay in your project), removes the callouts with it '
      + 'and un-nests the theme. ' + UNDO,
    )
  })

  it('never says "permanently"', () => {
    for (const holds of [
      { materials: 5, callouts: 0, children: 0 },
      { materials: 0, callouts: 2, children: 3 },
      { materials: 0, callouts: 0, children: 0 },
    ]) {
      expect(themeDeleteConfirmText('E', holds)).not.toMatch(/permanent/i)
    }
  })
})
