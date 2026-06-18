/**
 * useSuggestGroups — Phase 4 Suggest Groups state + handlers (#297, #295).
 *
 * Behavior preserved verbatim:
 *   - The suggestion query (`['domain-suggestions', pid]`) is gated behind
 *     `suggestActive` so it only fires when the researcher explicitly
 *     clicks Suggest. Button-driven activation lets us show analyzing
 *     state on the button without blocking the rest of the page.
 *   - `visibleSuggestions` filters out dismissed suggestions, those that
 *     dropped below 2 members, AND any suggestion whose members are no
 *     longer "unassigned" (matches computeUnassignedColumns: null EG +
 *     not a synthetic single-cell row in a bracket — see #334-class fix).
 *   - Accept handlers mutate via `mutationsRef.current.bulkCreateDomainsMutation`
 *     so the parent's Bracket / Cell memos don't lose stable identity
 *     (#332 perf). After success, focus moves to the first new bracket's
 *     heading via requestAnimationFrame + querySelector.
 *
 * `isAccepting` is threaded in from outside (rather than read off the
 * mutationsRef) because it must be reactive — refs don't trigger
 * re-renders, but the suggestion banner needs to disable accept buttons
 * while the bulk-create call is in flight.
 *
 * Audit Batch C, P4 step 7 (bonus extraction).
 */

import { useCallback, useMemo, useState } from 'react'
import type { MutableRefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  domainsApi,
  type DomainSuggestion,
  type ProjectColumnInfo,
} from '@/lib/api'
import type { useCrosswalkMutations } from './useCrosswalkMutations'

type CrosswalkMutations = ReturnType<typeof useCrosswalkMutations>

export interface SuggestGroups {
  suggestActive: boolean
  suggestLoading: boolean
  visibleSuggestions: ReadonlyArray<{ s: DomainSuggestion; originalIndex: number }>
  handleSuggestClick: () => void
  handleDismissSuggestion: (originalIndex: number) => void
  handleDismissAllSuggestions: () => void
  handleAcceptSuggestion: (suggestion: DomainSuggestion) => void
  handleAcceptAllSuggestions: () => void
}

interface UseSuggestGroupsOptions {
  projectId: number
  allColumns: ProjectColumnInfo[]
  domainMemberColumnIds: Set<number>
  mutationsRef: MutableRefObject<CrosswalkMutations>
}

export function useSuggestGroups({
  projectId,
  allColumns,
  domainMemberColumnIds,
  mutationsRef,
}: UseSuggestGroupsOptions): SuggestGroups {
  const [suggestActive, setSuggestActive] = useState(false)
  const [dismissedSuggestionIndices, setDismissedSuggestionIndices] = useState<Set<number>>(
    () => new Set(),
  )

  const { data: suggestData, isFetching: suggestLoading } = useQuery({
    queryKey: ['domain-suggestions', projectId],
    queryFn: () => domainsApi.suggest(projectId),
    enabled: suggestActive && !!projectId,
    staleTime: 60_000,
  })

  const visibleSuggestions = useMemo(() => {
    const all = suggestData?.suggestions ?? []
    if (all.length === 0) return []
    // Match the Unassigned panel's exclusion: a column with null EG can
    // still be a domain member as a synthetic single-cell row, in which
    // case suggesting it would 409 on accept (#334-class filter gap).
    const unassignedIds = new Set(
      allColumns
        .filter((c) => c.equivalence_group_id == null && !domainMemberColumnIds.has(c.id))
        .map((c) => c.id),
    )
    return all
      .map((s, originalIndex) => ({ s, originalIndex }))
      .filter(({ s, originalIndex }) => {
        if (dismissedSuggestionIndices.has(originalIndex)) return false
        if (s.members.length < 2) return false
        return s.members.every((m) => unassignedIds.has(m.member_id))
      })
  }, [suggestData?.suggestions, allColumns, domainMemberColumnIds, dismissedSuggestionIndices])

  const handleSuggestClick = useCallback(() => {
    setDismissedSuggestionIndices(new Set())
    setSuggestActive(true)
  }, [])

  const handleDismissSuggestion = useCallback((originalIndex: number) => {
    setDismissedSuggestionIndices((prev) => {
      const next = new Set(prev)
      next.add(originalIndex)
      return next
    })
  }, [])

  const handleDismissAllSuggestions = useCallback(() => {
    setSuggestActive(false)
    setDismissedSuggestionIndices(new Set())
  }, [])

  // Build the bulkCreate payload for one or more accepted suggestions.
  // Inline `equivalence_groups` are populated only for confident cross-
  // dataset pairings — the backend creates them in the same transaction.
  // Single-dataset and unpaired suggestions submit with empty arrays.
  const buildAcceptPayload = useCallback(
    (suggestionsToAccept: ReadonlyArray<{ s: DomainSuggestion; originalIndex: number }>) => {
      return suggestionsToAccept.map(({ s }) => ({
        name: s.name,
        members: s.members.map((m) => ({
          member_type: 'column' as const,
          member_id: m.member_id,
        })),
        equivalence_groups: s.unpaired
          ? []
          : s.members_paired.map((slot) => ({ column_ids: slot })),
      }))
    },
    [],
  )

  const handleAcceptSuggestion = useCallback(
    (suggestion: DomainSuggestion) => {
      const wrapper = visibleSuggestions.find((v) => v.s === suggestion)
      if (!wrapper) return
      const payload = buildAcceptPayload([wrapper])
      mutationsRef.current.bulkCreateDomainsMutation.mutate(
        { items: payload },
        {
          onSuccess: (result) => {
            handleDismissSuggestion(wrapper.originalIndex)
            // a11y: post-accept focus moves to the new bracket's heading.
            const firstId = result.domains[0]?.id
            if (firstId != null) {
              requestAnimationFrame(() => {
                const el = document.querySelector<HTMLElement>(
                  `[data-testid="crosswalk-bracket-${firstId}"]`,
                )
                el?.focus?.()
              })
            }
          },
        },
      )
    },
    [visibleSuggestions, buildAcceptPayload, handleDismissSuggestion, mutationsRef],
  )

  const handleAcceptAllSuggestions = useCallback(() => {
    if (visibleSuggestions.length === 0) return
    const payload = buildAcceptPayload(visibleSuggestions)
    const acceptedIndices = visibleSuggestions.map((v) => v.originalIndex)
    mutationsRef.current.bulkCreateDomainsMutation.mutate(
      { items: payload },
      {
        onSuccess: (result) => {
          setDismissedSuggestionIndices((prev) => {
            const next = new Set(prev)
            for (const idx of acceptedIndices) next.add(idx)
            return next
          })
          const firstId = result.domains[0]?.id
          if (firstId != null) {
            requestAnimationFrame(() => {
              const el = document.querySelector<HTMLElement>(
                `[data-testid="crosswalk-bracket-${firstId}"]`,
              )
              el?.focus?.()
            })
          }
        },
      },
    )
  }, [visibleSuggestions, buildAcceptPayload, mutationsRef])

  return {
    suggestActive,
    suggestLoading,
    visibleSuggestions,
    handleSuggestClick,
    handleDismissSuggestion,
    handleDismissAllSuggestions,
    handleAcceptSuggestion,
    handleAcceptAllSuggestions,
  }
}
