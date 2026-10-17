import { listNames } from '@/lib/format'

/**
 * #1168 R7 — what `StaleScaleScoresNotice` says, from the ids the SERVER named
 * (`stale_domain_ids`) and the variable-group list the page holds.
 *
 * A group the list does not (yet) name is counted rather than guessed: "2 scale
 * scores" is true, and a name still loading is no reason to say less.
 *
 * #1262 — a group's name is QUOTED after the noun, never set before it: group names
 * ending in "scale" are common, and "the Wellbeing scale scale score" is what the
 * adjective form printed. The quotation marks also keep a name that is a phrase of
 * its own ("Trust in local government") from running into the sentence.
 */
export function staleScaleScoresSentence(
  staleDomainIds: readonly number[],
  domains: readonly { id: number; name: string }[] | undefined,
): string {
  const one = staleDomainIds.length === 1
  const byId = new Map((domains ?? []).map(d => [d.id, d.name]))
  const names = staleDomainIds.map(id => byId.get(id))
  const what = names.every((n): n is string => n !== undefined)
    ? `the scale ${one ? 'score' : 'scores'} for ${listNames(names.map(n => `“${n}”`))}`
    : `${staleDomainIds.length} scale ${one ? 'score' : 'scores'}`
  return `Out of date: ${what} ${one ? 'was' : 'were'} computed before ${one ? 'its' : 'their'} data changed.`
}
