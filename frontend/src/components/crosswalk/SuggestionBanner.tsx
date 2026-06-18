/**
 * SuggestionBanner — top-of-ghost-list summary + bulk actions.
 *
 * Renders above the SuggestionGhostRow stack. Shows N suggestions found
 * with bulk-accept and dismiss-all controls. The bulk-accept submits all
 * non-dismissed suggestions in one bulkCreateDomainsMutation call (atomic
 * — either every domain is created or none are).
 *
 * Note: bulk-accept respects the `unpaired` flag — unpaired suggestions
 * still get accepted (creating an unpaired domain that the user can pair
 * manually post-creation), since the user is explicitly opting in.
 */

import { Button } from '@/components/ui/button'
import { Sparkles, X } from 'lucide-react'

interface SuggestionBannerProps {
  suggestionCount: number
  isAccepting?: boolean
  onAcceptAll: () => void
  onDismissAll: () => void
}

export function SuggestionBanner({
  suggestionCount,
  isAccepting = false,
  onAcceptAll,
  onDismissAll,
}: SuggestionBannerProps) {
  if (suggestionCount === 0) return null
  return (
    <div
      data-testid="suggestion-banner"
      className="mb-4 flex items-center justify-between gap-3 px-4 py-2.5 rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"
      role="region"
      aria-label="Suggested variable groups"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles className="w-4 h-4 flex-none text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-sm text-mm-text">
          <span className="font-medium">{suggestionCount}</span>{' '}
          {suggestionCount === 1 ? 'suggestion' : 'suggestions'} found.
          <span className="text-mm-text-muted ml-1">
            Review each one below or accept all at once.
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2 flex-none">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismissAll}
          disabled={isAccepting}
          aria-label="Dismiss all suggestions"
        >
          <X className="w-3.5 h-3.5 mr-1" aria-hidden />
          Dismiss all
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onAcceptAll}
          disabled={isAccepting}
          aria-label="Accept all suggestions"
        >
          Accept all
        </Button>
      </div>
    </div>
  )
}
