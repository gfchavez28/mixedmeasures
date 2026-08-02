import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface KeyboardHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SHORTCUT_GROUPS = [
  {
    title: 'Global',
    shortcuts: [
      { keys: ['Ctrl', 'K'], label: 'Search' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
      { keys: ['Ctrl', 'Z'], label: 'Undo' },
      { keys: ['Ctrl', 'Y'], label: 'Redo' },
    ],
  },
  {
    title: 'Coding (all views)',
    shortcuts: [
      { keys: ['c'], label: 'Create code' },
      { keys: ['n'], label: 'Create note' },
      { keys: ['s'], label: 'Toggle quote' },
      // #644: `j` is claimed by useCodeChordShortcuts ONLY when the surface
      // passes onJumpUncoded. The observation workbench deliberately omits it
      // so `J` can shuttle backward (D4) — so "all views" was false here, and
      // this dialog was telling the researcher the wrong thing about a key that
      // does something else on that page.
      { keys: ['j'], label: 'Next uncoded (not in Observations)' },
      { keys: ['0', '-', '9'], label: 'Apply code (chord shortcut)' },
      { keys: ['cat', '.', 'code'], label: 'Category chord (requires categories)' },
      { keys: ['F2'], label: 'Edit / rename' },
      { keys: ['\u2191', '\u2193'], label: 'Navigate' },
      { keys: ['Shift', '\u2191\u2193'], label: 'Multi-select' },
      // Same correction as `j`: the observation workbench supplies
      // onArrowHorizontal, so \u2190/\u2192 nudge the selected clip's boundary there and
      // never move panel focus. The audit named only `j`; this one was found by
      // reading the hook's contract against the workbench's options.
      { keys: ['\u2190', '\u2192'], label: 'Switch panel (not in Observations)' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    // #644: v1.3.0's headline surface had the densest keyboard layer in the app
    // and no entry here at all. Verified against ObservationWorkbench's
    // `extraKeys` + `onArrowHorizontal`, not from the issue text.
    title: 'Observations',
    shortcuts: [
      { keys: ['Space'], label: 'Play / pause (clip list focused)' },
      { keys: ['i', 'o'], label: 'Mark clip in / out' },
      { keys: ['p'], label: 'Point event' },
      // Audited against the live hook options 2026-08-02. `s` is ONE verb over
      // two states, and naming only the armed one implied a mark was required.
      { keys: ['s'], label: 'Quote clip — or the marked range, while marking' },
      { keys: ['u'], label: 'Next gap or uncoded clip' },
      // `c`/`n` are listed under "Coding (all views)" and that claim was FALSE
      // here until #660: the workbench never passed onCreateCode, and the hook
      // preventDefaults `c` before calling it, so the key was swallowed.
      { keys: ['c'], label: 'Create a code and apply it to the selected clips' },
      { keys: ['n'], label: 'Add note (opens the rail’s note box)' },
      { keys: ['j', 'k', 'l'], label: 'Shuttle back / play-pause / faster' },
      { keys: [',', '.'], label: 'Step frame (Shift: 1s)' },
      { keys: ['\u2190', '\u2192'], label: 'Nudge boundary (Shift: 1s)' },
      { keys: ['Esc'], label: 'Cancel mark, then exit Follow' },
    ],
  },
  {
    title: 'Conversations only',
    shortcuts: [
      { keys: ['g'], label: 'Group / ungroup' },
    ],
  },
  {
    title: 'Text columns only',
    shortcuts: [
      { keys: ['['], label: 'Previous column' },
      { keys: [']'], label: 'Next column' },
    ],
  },
  {
    title: 'Canvas',
    shortcuts: [
      { keys: ['Esc'], label: 'Exit focus mode' },
      { keys: ['Ctrl', 'E'], label: 'Toggle materials panel' },
      { keys: ['/'], label: 'Slash command (in theme editor)' },
      { keys: ['@'], label: 'Mention theme' },
      { keys: ['Ctrl', 'Z'], label: 'Undo (prose in editor, themes outside)' },
      { keys: ['Ctrl', 'Y'], label: 'Redo' },
      { keys: ['Ctrl', 'B'], label: 'Bold (in editor)' },
      { keys: ['Ctrl', 'I'], label: 'Italic (in editor)' },
    ],
  },
  {
    title: 'Dataset',
    shortcuts: [
      { keys: ['Click header'], label: 'Open column editor' },
      { keys: ['Tab'], label: 'Next column (in editor)' },
      { keys: ['Shift', 'Tab'], label: 'Previous column' },
      { keys: ['Enter'], label: 'Next field / commit' },
      { keys: ['\u2190', '\u2192'], label: 'Prev / next column' },
      { keys: ['Esc'], label: 'Close editor / cancel edit' },
    ],
  },
  {
    title: 'Recode',
    shortcuts: [
      { keys: ['Enter'], label: 'Commit + next question (same field)' },
      { keys: ['Shift', 'Enter'], label: 'Commit + previous question' },
      { keys: ['Tab'], label: 'Next field (within question)' },
      { keys: ['Esc'], label: 'Cancel edit' },
    ],
  },
]

export default function KeyboardHelpDialog({ open, onOpenChange }: KeyboardHelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          {/* #648: without this Radix logs "Missing Description or
              aria-describedby" on every open and a screen reader announces the
              title with nothing after it. */}
          <DialogDescription>
            Shortcuts by area. Coding keys work in every coding view unless an
            entry says otherwise.
          </DialogDescription>
        </DialogHeader>
        {/* DialogContent is `top-1/2 -translate-y-1/2` with NO max-height and no
            overflow, so a tall dialog centres and runs off BOTH edges of the
            viewport with nothing to scroll. Adding the Observations section made
            that reachable at 1280x720 (the tool's stated minimum), so the
            content area is height-bounded here rather than growing forever. */}
        <div className="grid grid-cols-2 gap-6 mt-2 max-h-[65vh] overflow-y-auto pr-1">
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold text-mm-text-secondary uppercase tracking-wider mb-2">
                {group.title}
              </h3>
              <div className="space-y-1.5">
                {group.shortcuts.map(shortcut => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-mm-text">{shortcut.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {shortcut.keys.map((key, i) => (
                        <kbd
                          key={i}
                          className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 bg-mm-bg border border-mm-border-medium rounded text-xs font-mono text-mm-text-secondary"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
