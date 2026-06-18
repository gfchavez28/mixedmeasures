import { useState, useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export type SectionName = 'data' | 'appearance' | 'annotations'

interface OptionsAccordionProps {
  children: ReactNode
}

/** Wrapper div with divide-y styling for accordion sections. */
export function OptionsAccordion({ children }: OptionsAccordionProps) {
  return <div className="divide-y text-xs">{children}</div>
}

interface AccordionSectionProps {
  name: SectionName
  label: string
  expanded: SectionName | null
  onToggle: (name: SectionName) => void
  children: ReactNode
  /** Optional id prefix for aria-controls (defaults to "chart-options") */
  idPrefix?: string
}

/** A single collapsible section with chevron toggle and uppercase header. */
export function AccordionSection({
  name,
  label,
  expanded,
  onToggle,
  children,
  idPrefix = 'chart-options',
}: AccordionSectionProps) {
  const isExpanded = expanded === name
  const panelId = `${idPrefix}-${name}`

  return (
    <div>
      <button
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-mm-text-muted hover:text-mm-text"
        onClick={() => onToggle(name)}
        aria-expanded={isExpanded}
        aria-controls={panelId}
      >
        <ChevronDown
          className={`w-3 h-3 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
        {label}
      </button>
      {isExpanded && (
        <div id={panelId} className="px-3 pb-2 space-y-2">
          {children}
        </div>
      )}
    </div>
  )
}

/** Hook to manage accordion state with at-most-one-open behavior and external force-open trigger. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAccordionState(
  initialSection: SectionName | null = 'data',
  forceOpenTrigger: number = 0,
  forceOpenSection: SectionName = 'data',
) {
  const [expanded, setExpanded] = useState<SectionName | null>(initialSection)

  const toggle = (s: SectionName) => setExpanded(prev => (prev === s ? null : s))

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- force-open section from external trigger
    if (forceOpenTrigger > 0) setExpanded(forceOpenSection)
  }, [forceOpenTrigger, forceOpenSection])

  return { expanded, toggle }
}
