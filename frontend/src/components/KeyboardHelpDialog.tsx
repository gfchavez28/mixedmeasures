import {
  Dialog,
  DialogContent,
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
      { keys: ['j'], label: 'Next uncoded' },
      { keys: ['0', '-', '9'], label: 'Apply code (chord shortcut)' },
      { keys: ['cat', '.', 'code'], label: 'Category chord (requires categories)' },
      { keys: ['F2'], label: 'Edit / rename' },
      { keys: ['\u2191', '\u2193'], label: 'Navigate' },
      { keys: ['Shift', '\u2191\u2193'], label: 'Multi-select' },
      { keys: ['\u2190', '\u2192'], label: 'Switch panel' },
      { keys: ['Esc'], label: 'Clear selection' },
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
        </DialogHeader>
        <div className="grid grid-cols-2 gap-6 mt-2">
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
