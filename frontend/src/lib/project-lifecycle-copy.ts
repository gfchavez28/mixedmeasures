import { isRequestTimeout, serverDetailMessage, type Project } from '@/lib/api'
import { listNames, plural } from '@/lib/format'

/**
 * What the project list says about a delete or an overwrite import (#1035 review
 * §4 #3, #8, #10).
 *
 * Both used to answer a large project with the app-wide "Something went wrong" (the
 * delete) or "Project import failed" (the import) — while the server, which a client
 * giving up does not stop, finished the work. The server's own sentence when it
 * gave one; when NO answer came, what is known: nothing, and the refreshed list is
 * the way to tell.
 */

function answered(err: unknown): boolean {
  return !isRequestTimeout(err) && typeof (err as { status?: unknown } | null)?.status === 'number'
}

export function deleteFailureSentence(err: unknown, projectName: string): string {
  const server = serverDetailMessage(err)
  if (server) return server
  if (!answered(err)) {
    return `Mixed Measures did not answer, so whether “${projectName}” was deleted is not known. `
      + 'The list has been refreshed: if the project is still there, it was not deleted.'
  }
  return `“${projectName}” could not be deleted.`
}

export function importFailureSentence(err: unknown): string {
  const server = serverDetailMessage(err)
  if (server) return server
  if (!answered(err)) {
    return 'Mixed Measures did not answer, so whether the import finished is not known. '
      + 'The list has been refreshed: look there before importing the file again.'
  }
  return 'The project could not be imported.'
}

/**
 * #1232 — what the Merge page says when the MERGE itself fails (a divergence 409 has
 * its own screen and never reaches this). It said "Merge failed. Your project was not
 * changed." for everything: #977's refusals ("…too large to snapshot first…") reached
 * no screen, and after a timeout — the server keeps working once the client stops
 * waiting — the merge may well have finished.
 *
 * `unknown` is the page's cue that nothing about the project can be assumed: a merge
 * repeated from the same decisions adds every coder chosen as NEW a second time, with
 * all of their codings (#1246, EXECUTED: "Bob (2)" then "Bob (3)"), so the page ends
 * on its own step rather than going back to Review. ⚠️ No "try again" (#820).
 * ⚠️ "Your project was not changed" for an answered failure rests on the server
 * rolling back the database AND the files (#1225 stages the files before the first
 * database write and places them only on commit).
 */
export function mergeFailure(err: unknown): { sentence: string; unknown: boolean } {
  const server = serverDetailMessage(err)
  if (server) return { sentence: server, unknown: false }
  if (!answered(err)) {
    return {
      sentence: 'Mixed Measures did not answer, so whether the merge finished is not known. '
        + 'Before merging this file again, open the project and check whether its coders and codings '
        + 'are already there — merging it a second time adds any coder you chose to add as new again.',
      unknown: true,
    }
  }
  return { sentence: 'The merge could not be completed. Your project was not changed.', unknown: false }
}

/**
 * #1203 — why a picked project file did not reach the import preview. It toasted
 * "Invalid project file" over every reason, including the one a researcher most
 * needs: a file from a NEWER version of Mixed Measures, whose server sentence says
 * to update. The server's words when it gave them; the check reads the file and
 * changes nothing, so a non-answer can say that nothing was imported. ⚠️ No "try
 * again": after a timeout a retry gets the same budget and stops in the same
 * place (#820).
 */
export function validateFailureSentence(err: unknown, fileName: string): string {
  const server = serverDetailMessage(err)
  if (server) return server
  if (!answered(err)) {
    return `Mixed Measures did not answer while checking “${fileName}”, so nothing was imported.`
  }
  return `“${fileName}” could not be read as a project file.`
}

/**
 * "It holds 3 conversations, 1 dataset and 12 participants." — what a delete takes
 * with it, from the card's own counts; null for an empty project.
 */
export function projectContentsSentence(p: Pick<Project,
  'conversation_count' | 'document_count' | 'dataset_count' | 'observation_count' | 'participant_count'>): string | null {
  const parts = [
    [p.conversation_count, 'conversation', 'conversations'],
    [p.document_count, 'document', 'documents'],
    [p.dataset_count, 'dataset', 'datasets'],
    [p.observation_count, 'observation', 'observations'],
    [p.participant_count, 'participant', 'participants'],
  ] as const
  // Thousands separated: a card can hold 122,382 participants.
  const named = parts.filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n.toLocaleString()} ${plural(n, one, many)}`)
  if (named.length === 0) return null
  return `It holds ${listNames(named, named.length)}, with all of their coding, notes and memos.`
}
