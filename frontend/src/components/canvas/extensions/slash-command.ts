/**
 * Tiptap slash command suggestion extension.
 *
 * Triggered by "/" at the start of a line or after whitespace. The suggestion
 * config (command handler, items, render) is passed at configure-time by
 * ThemeEditor, keeping this extension generic.
 */
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

export const slashCommandPluginKey = new PluginKey('slashCommand')

export interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions, 'editor'>
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        pluginKey: slashCommandPluginKey,
        startOfLine: false,
        allow: ({ state, range }) => {
          // Allow "/" at start of line or after whitespace
          const $from = state.doc.resolve(range.from)
          const textBefore = $from.parent.textBetween(
            0,
            $from.parentOffset,
            undefined,
            '\ufffc',
          )
          const lastChar = textBefore[textBefore.length - 1]
          return range.from === $from.start() || lastChar === ' ' || lastChar === '\n'
        },
        command: () => { /* overridden by ThemeEditor */ },
        items: () => [],
        render: () => ({ onStart() {}, onUpdate() {}, onExit() {}, onKeyDown() { return false } }),
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})
