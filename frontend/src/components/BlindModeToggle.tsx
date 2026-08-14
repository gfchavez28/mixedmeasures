import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'

interface BlindModeToggleProps {
  /** true = colleagues hidden (blind). */
  blind: boolean
  /** Flip blindness. Pass the surface for the reveal-log when revealing. */
  onToggle: (surface?: string) => void
  /** Where the reveal happened ('workbench' | 'document_workbench' | 'text_workbench' | 'analysis'). */
  surface: string
}

/**
 * Blind-mode reveal toggle (Track J · J2-5, DEC-G / D4). Dual-encoded (icon + text,
 * never color-only). Revealing colleagues' coding asks for confirmation and is logged
 * (honesty, not a lock); re-hiding is immediate + silent. Render only when multiCoder.
 */
export default function BlindModeToggle({ blind, onToggle, surface }: BlindModeToggleProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [announce, setAnnounce] = useState('')

  const handleClick = () => {
    if (blind) {
      setConfirmOpen(true)              // revealing — confirm + log
    } else {
      onToggle()                        // re-hiding — silent, no log
      setAnnounce('Colleagues hidden')
    }
  }

  const confirmReveal = () => {
    onToggle(surface)
    setConfirmOpen(false)
    setAnnounce("Colleagues' coding revealed")
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        /*
         * #755 — deliberately NOT a toggle button.
         *
         * It carried `aria-pressed={!blind}` while its NAME also described the
         * state, and NVDA announced the pair as "Colleagues hidden, toggle
         * button, not pressed" — two state claims that read as opposites, since
         * "not pressed" attaches to the named thing ("colleagues hidden is
         * off" ⇒ shown). The ARIA toggle pattern requires the accessible NAME to
         * stay CONSTANT while `aria-pressed` carries the state; this control
         * flips both.
         *
         * ⚠️ A constant name is not available here. The visible text is the
         * dual-encoded state indicator (never colour-only — see the docstring),
         * and WCAG 2.5.3 requires the accessible name to contain the visible
         * text, so freezing the name would mean freezing the visible label and
         * losing the at-a-glance state a multi-coder integrity affordance needs.
         *
         * So the state lives in the NAME alone and the toggle semantics go. The
         * ACTION is still announced — the `title` below is read as the
         * description ("…Click to reveal — this is logged"), confirmed in the
         * 2026-08-12 NVDA transcript.
         */
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
          blind
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 hover:bg-amber-200/70 dark:hover:bg-amber-900/60'
            : 'bg-mm-blue/15 text-mm-blue-text hover:bg-mm-blue/25'
        }`}
        title={blind
          ? "Colleagues' coding is hidden (blind coding). Click to reveal — this is logged."
          : "Colleagues' coding is shown. Click to hide."}
      >
        {blind ? <EyeOff className="w-3 h-3" aria-hidden="true" /> : <Eye className="w-3 h-3" aria-hidden="true" />}
        {blind ? 'Colleagues hidden' : 'Colleagues shown'}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Reveal colleagues' coding?"
        description="Blind coding keeps your independent judgment uninfluenced. Revealing colleagues' work is logged."
        confirmLabel="Reveal"
        destructive={false}
        onConfirm={confirmReveal}
      />
    </>
  )
}
