/**
 * #1341 — every block-embed insert on the canvas goes through `insert-block.ts::placeBlock`.
 *
 * The population (counted 2026-11-13g): ThemeEditor's five `insert*` handles (the Materials
 * drawer's excerpt/chart/memo, a pending-item click, a drag onto a theme, the `/image` upload,
 * the joint display's builder) all reach `insertWithPendingSlash`; `/callout` inserted on its
 * own; an image PASTE went through `image-embed.ts`'s plugin. `/divider` is Tiptap's own
 * `setHorizontalRule`, which already moves the caret past the rule, and an image DROP uses
 * `tr.insert` at the drop point, which replaces nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const read = (rel: string) => {
  const path = join(__dirname, rel)
  return stripComments(readFileSync(path, 'utf8'), path)
}

describe('#1341 — the insert doors', () => {
  const editor = read('ThemeEditor.tsx')
  const image = read('extensions/image-embed.ts')

  it('read the files it scans', () => {
    expect(editor).toContain('const insertWithPendingSlash = useCallback(')
    expect(image).toContain('handlePaste(view, event)')
  })

  it('ThemeEditor places every embed through placeBlock and inserts none around it', () => {
    const door = editor.match(/const insertWithPendingSlash = useCallback\(([\s\S]*?)\n {2}\)/)?.[1] ?? ''
    expect(door).toContain('placeBlock(tr,')
    expect(editor.match(/placeBlock\(tr,/g)?.length, 'the door and /callout').toBe(2)
    expect(editor, 'an insertContent call leaves a block atom node-selected').not.toMatch(/\.insertContent\(/)
  })

  it('a pasted image is placed the same way', () => {
    const paste = image.match(/handlePaste\(view, event\) \{([\s\S]*?)\n {8}\},/)?.[1] ?? ''
    expect(paste).toContain('placeBlock(view.state.tr, node)')
    expect(paste).not.toContain('replaceSelectionWith')
  })
})
