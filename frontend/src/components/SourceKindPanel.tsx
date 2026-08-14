import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'

import {
  SOURCE_KIND_ONE_LINER,
  SOURCE_KIND_TABLE,
  OBSERVATION_TRADEOFFS,
  CONVERSATION_TRADEOFFS,
  DOUBLE_IMPORT_NOTE,
  ESCAPE_HATCH_NOTE,
} from '@/lib/source-kind-copy'

/**
 * "Is this the right place for my recording?" — step 1 of BOTH import wizards.
 *
 * This is deliberately NOT an interstitial gate, and that is the whole design.
 * Conversation import is reachable from seven places today (TopRail dropdown,
 * list header, list empty state, a drag onto the list, two Overview cards, the
 * qual-analysis empty state) and Observations will grow the same set. A gate
 * would have to be wired into every one of them AND every future one — and the
 * entry point somebody forgets to wire is invisible, because it just silently
 * skips the gate. That is exactly the drift class this codebase already fails the
 * suite over (#552).
 *
 * But every one of those entry points lands in a WIZARD. So the explainer lives
 * here, inside step 1, where it is reached from all of them with nothing to wire.
 *
 * It is not a nag: static content above the drop zone, one sentence always
 * visible and the consequences behind a disclosure. No modal, no click-through,
 * and no dismissal state (a dismissible nag needs storage, per-project-vs-per-user
 * semantics and an un-dismiss path — all cost, no benefit). The expert never
 * opens it; the novice reads two sentences.
 *
 * It informs rather than forces, which is only acceptable BECAUSE of D17: you can
 * re-use the recording in the other place without re-uploading, so a wrong turn
 * costs the coding, not the upload. That sentence is the most de-risking thing on
 * the panel, and it is why the soft pattern is defensible.
 */
export default function SourceKindPanel({
  current,
  projectId,
}: {
  current: 'conversation' | 'observation'
  projectId: number
}) {
  const [open, setOpen] = useState(false)
  const other = current === 'conversation'
    ? { label: 'Import it as an Observation', to: `/projects/${projectId}/observations/import` }
    : { label: 'Import it as a Conversation', to: `/projects/${projectId}/conversations/import` }

  const otherPrompt = current === 'conversation'
    ? 'Coding what happened on the recording — nonverbal moments, whole episodes — rather than what was said?'
    : 'Coding what was said, and you have a transcript?'

  return (
    <section
      aria-labelledby="source-kind-heading"
      className="mb-6 rounded-lg border border-mm-border bg-mm-bg p-4"
    >
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 text-mm-text-muted shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <h2 id="source-kind-heading" className="sr-only">
            Is this the right place for your recording?
          </h2>
          <p className="text-sm text-mm-text">{SOURCE_KIND_ONE_LINER}</p>

          <p className="text-sm text-mm-text-muted mt-2">
            {otherPrompt}{' '}
            <Link to={other.to} className="text-mm-blue-text underline underline-offset-2">
              {other.label}
            </Link>
          </p>

          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-mm-text-muted hover:text-mm-text transition-colors"
          >
            {open
              ? <ChevronDown className="w-3.5 h-3.5" aria-hidden />
              : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
            Which should I choose?
          </button>

          {open && (
            <div className="mt-3 space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <caption className="sr-only">Where a recording can live: coding a transcript in a Conversation versus coding the timeline in an Observation.</caption>
                  <thead>
                    <tr className="text-left text-mm-text-muted">
                      <th scope="col" className="py-1 pr-4 font-medium">Source</th>
                      <th scope="col" className="py-1 pr-4 font-medium">You code…</th>
                      <th scope="col" className="py-1 font-medium">The recording is…</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SOURCE_KIND_TABLE.map(row => (
                      <tr key={row.source} className="border-t border-mm-border-subtle">
                        <th scope="row" className="py-1.5 pr-4 font-medium text-mm-text text-left">
                          {row.source}
                        </th>
                        <td className="py-1.5 pr-4 text-mm-text-muted">{row.youCode}</td>
                        <td className="py-1.5 text-mm-text-muted">{row.theRecordingIs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="text-xs font-medium text-mm-text">
                  What {current === 'observation' ? 'an Observation' : 'a Conversation'} can’t do
                </h3>
                <ul className="mt-1 space-y-1">
                  {(current === 'observation' ? OBSERVATION_TRADEOFFS : CONVERSATION_TRADEOFFS)
                    .map(t => (
                      <li key={t} className="text-xs text-mm-text-muted flex gap-2">
                        <span aria-hidden>·</span>
                        <span>{t}</span>
                      </li>
                    ))}
                </ul>
              </div>

              <p className="text-xs text-mm-text-muted">{DOUBLE_IMPORT_NOTE}</p>

              {/* The sentence that turns a scary fork into a manageable one. */}
              <p className="text-xs text-mm-text bg-mm-surface rounded-md p-2.5">
                {ESCAPE_HATCH_NOTE}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
