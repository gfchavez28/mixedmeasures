import MachineAgreementTable from './MachineAgreementTable'
import BlindScopeNotice from './BlindScopeNotice'
import { MACHINE_AGREEMENT_BLIND_SCOPE } from '@/lib/machine-agreement-copy'

/**
 * The Model comparison tab (#1030) — how closely each imported model layer
 * reproduces each person's coding, on a tab of its own.
 *
 * 🔴 **Why a tab and not a section of Reliability.** The table sat under the
 * Reliability tab's figures, and that tab needs two PEOPLE (`isIrrTabVisible`).
 * One person plus an imported model layer — the default install, and the
 * researcher this comparison exists for — never saw it, although the server
 * computes it with one human. Its own tab also says structurally what its copy
 * already says in words: these figures are not reliability.
 *
 * 🔴 **Blind mode NARROWS, it does not hide.** A model is not a colleague, and its
 * chips are already on a blind coder's screen, so comparing your OWN coding with
 * it breaks no blindness — but a colleague's row names them and describes their
 * coding. `withholding` (the fail-closed lens, #964) therefore asks the server for
 * the viewer alone, and `blind` (the claim, once the roster is known) says so.
 */
export default function ModelComparisonTab({
  projectId, selfId, withholding, blind, onReveal,
}: {
  projectId: number
  /** The viewer. Null only before auth answers, when nothing is fetched. */
  selfId: number | null
  /** #964's ACT: narrow to the viewer (also while the roster is unanswered). */
  withholding: boolean
  /** #964's CLAIM: say the narrowing, once it is known to be blind mode. */
  blind: boolean
  onReveal?: () => void
}) {
  // Withholding with no known viewer: there is nobody to narrow to, and asking for
  // everyone would leak. Say nothing until the viewer is known.
  if (withholding && selfId == null) return null
  return (
    <div className="flex flex-col gap-3">
      <BlindScopeNotice blind={blind} onReveal={onReveal} className="max-w-3xl">
        {MACHINE_AGREEMENT_BLIND_SCOPE}
      </BlindScopeNotice>
      <MachineAgreementTable projectId={projectId} humanId={withholding ? selfId : null} />
    </div>
  )
}
