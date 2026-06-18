import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Search, TrendingUp, BookOpen, Palette } from 'lucide-react'
import { projectsApi } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'

const ACCENT = {
  green: {
    text: 'text-mm-green-text',
    bg: 'bg-[hsl(var(--mm-green)/0.12)]',
    icon: 'text-mm-green',
    border: 'hover:border-[hsl(var(--mm-green)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-green)/0.18)]',
    pillBg: 'bg-[hsl(var(--mm-green)/0.08)]',
    pillBorder: 'border-[hsl(var(--mm-green)/0.15)]',
  },
  orange: {
    text: 'text-mm-orange-text',
    bg: 'bg-[hsl(var(--mm-orange)/0.12)]',
    icon: 'text-mm-orange',
    border: 'hover:border-[hsl(var(--mm-orange)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-orange)/0.18)]',
    pillBg: 'bg-[hsl(var(--mm-orange)/0.08)]',
    pillBorder: 'border-[hsl(var(--mm-orange)/0.15)]',
  },
  purple: {
    text: 'text-mm-purple-text',
    bg: 'bg-[hsl(var(--mm-purple)/0.12)]',
    icon: 'text-mm-purple',
    border: 'hover:border-[hsl(var(--mm-purple)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-purple)/0.18)]',
    pillBg: 'bg-[hsl(var(--mm-purple)/0.08)]',
    pillBorder: 'border-[hsl(var(--mm-purple)/0.15)]',
  },
  canvas: {
    text: 'text-mm-canvas-text',
    bg: 'bg-[hsl(var(--mm-canvas)/0.12)]',
    icon: 'text-mm-canvas',
    border: 'hover:border-[hsl(var(--mm-canvas)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-canvas)/0.18)]',
    pillBg: 'bg-[hsl(var(--mm-canvas)/0.08)]',
    pillBorder: 'border-[hsl(var(--mm-canvas)/0.15)]',
  },
  blue: {
    text: 'text-mm-blue-text',
    bg: 'bg-[hsl(var(--mm-blue)/0.12)]',
    icon: 'text-mm-blue',
    border: 'hover:border-[hsl(var(--mm-blue)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-blue)/0.18)]',
    pillBg: 'bg-[hsl(var(--mm-blue)/0.08)]',
    pillBorder: 'border-[hsl(var(--mm-blue)/0.15)]',
  },
} as const

type AnalysisType = 'qualitative' | 'quantitative' | 'codebook' | 'canvas'

export default function AnalysisHubPage() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()

  const { data: summary } = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => projectsApi.summary(projectId),
    staleTime: 30_000,
    enabled: !isNaN(projectId),
  })

  const [lastUsed, setLastUsed] = useState<AnalysisType | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem(`mm-last-analysis-${projectId}`)
    if (stored === 'qualitative' || stored === 'quantitative' || stored === 'codebook' || stored === 'canvas') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read localStorage on mount/project change
      setLastUsed(stored)
    }
  }, [projectId])

  const s = summary

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      <div className="mb-3.5">
        <h1 className="text-lg font-bold text-mm-text">Analysis</h1>
        <p className="text-sm text-mm-text-secondary mt-1">
          Explore qualitative patterns, visualize quantitative results, and run statistical tests.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Qualitative */}
        <button
          onClick={() => navigate(`/projects/${projectId}/analysis/qualitative`)}
          className={`text-left rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 transition-colors cursor-pointer h-full flex flex-col ${ACCENT.green.border}`}
        >
          <div className={`w-9 h-9 rounded-lg ${ACCENT.green.bg} border ${ACCENT.green.iconBorder} flex items-center justify-center mb-3`}>
            <Search className={`w-[18px] h-[18px] ${ACCENT.green.icon}`} aria-hidden="true" />
          </div>
          <div className="font-semibold text-mm-text mb-1">Qualitative</div>
          <p className="text-[13px] text-mm-text-muted leading-relaxed mb-3">
            Code frequency dashboards, segment viewer, co-occurrence analysis.
          </p>
          <div className="mt-auto">
            {s && (
              <span
                className={`inline-block text-[12px] font-medium ${ACCENT.green.text} ${ACCENT.green.pillBg} border ${ACCENT.green.pillBorder} px-2.5 py-1 rounded-md`}
                /* #351/#352: pill now shows participant-only coded count.
                 * title clarifies for hover; the visible label stays terse. */
                title="Coded segments shown here exclude facilitator turns."
              >
                {s.coded_segments} participant coded segments · {s.codes} codes
              </span>
            )}
            {lastUsed === 'qualitative' && (
              <span className="inline-block ml-2 text-[11px] font-medium text-mm-text-muted bg-mm-bg px-2 py-0.5 rounded">
                Last viewed
              </span>
            )}
          </div>
        </button>

        {/* Quantitative */}
        <button
          onClick={() => navigate(`/projects/${projectId}/analysis/quantitative`)}
          className={`text-left rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 transition-colors cursor-pointer h-full flex flex-col ${ACCENT.orange.border}`}
        >
          <div className={`w-9 h-9 rounded-lg ${ACCENT.orange.bg} border ${ACCENT.orange.iconBorder} flex items-center justify-center mb-3`}>
            <TrendingUp className={`w-[18px] h-[18px] ${ACCENT.orange.icon}`} aria-hidden="true" />
          </div>
          <div className="font-semibold text-mm-text mb-1">Quantitative</div>
          <p className="text-[13px] text-mm-text-muted leading-relaxed mb-3">
            Charts, metrics, variable groups, and statistical testing.
          </p>
          <div className="mt-auto">
            {s && (
              <span className={`inline-block text-[12px] font-medium ${ACCENT.orange.text} ${ACCENT.orange.pillBg} border ${ACCENT.orange.pillBorder} px-2.5 py-1 rounded-md`}>
                {s.materials} saved · {s.statistical_tests} stat tests
              </span>
            )}
            {lastUsed === 'quantitative' && (
              <span className="inline-block ml-2 text-[11px] font-medium text-mm-text-muted bg-mm-bg px-2 py-0.5 rounded">
                Last viewed
              </span>
            )}
          </div>
        </button>

        {/* Codebook */}
        <button
          onClick={() => navigate(`/projects/${projectId}/analysis/codebook`)}
          className={`text-left rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 transition-colors cursor-pointer h-full flex flex-col ${ACCENT.blue.border}`}
        >
          <div className={`w-9 h-9 rounded-lg ${ACCENT.blue.bg} border ${ACCENT.blue.iconBorder} flex items-center justify-center mb-3`}>
            <BookOpen className={`w-[18px] h-[18px] ${ACCENT.blue.icon}`} aria-hidden="true" />
          </div>
          <div className="font-semibold text-mm-text mb-1">Codebook</div>
          <p className="text-[13px] text-mm-text-muted leading-relaxed mb-3">
            Visualize and organize your coding system. Tree hierarchy, co-occurrence network, source filtering.
          </p>
          <div className="mt-auto">
            {s && (
              <span className={`inline-block text-[12px] font-medium ${ACCENT.blue.text} ${ACCENT.blue.pillBg} border ${ACCENT.blue.pillBorder} px-2.5 py-1 rounded-md`}>
                {s.codes} codes · {s.categories} categories
              </span>
            )}
            {lastUsed === 'codebook' && (
              <span className="inline-block ml-2 text-[11px] font-medium text-mm-text-muted bg-mm-bg px-2 py-0.5 rounded">
                Last viewed
              </span>
            )}
          </div>
        </button>

        {/* Canvas (Integrated) */}
        <button
          onClick={() => navigate(`/projects/${projectId}/analysis/canvas`)}
          className={`text-left rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 transition-colors cursor-pointer h-full flex flex-col ${ACCENT.canvas.border}`}
        >
          <div className={`w-9 h-9 rounded-lg ${ACCENT.canvas.bg} border ${ACCENT.canvas.iconBorder} flex items-center justify-center mb-3`}>
            <Palette className={`w-[18px] h-[18px] ${ACCENT.canvas.icon}`} aria-hidden="true" />
          </div>
          <div className="font-semibold text-mm-text mb-1">Canvas</div>
          <p className="text-[13px] text-mm-text-muted leading-relaxed mb-3">
            Compose findings into an integrated analytical narrative.
          </p>
          <div className="mt-auto">
            {s && (
              <span className={`inline-block text-[12px] font-medium ${ACCENT.canvas.text} ${ACCENT.canvas.pillBg} border ${ACCENT.canvas.pillBorder} px-2.5 py-1 rounded-md`}>
                {s.canvas_count} {s.canvas_count === 1 ? 'canvas' : 'canvases'}
              </span>
            )}
            {lastUsed === 'canvas' && (
              <span className="inline-block ml-2 text-[11px] font-medium text-mm-text-muted bg-mm-bg px-2 py-0.5 rounded">
                Last viewed
              </span>
            )}
          </div>
        </button>
      </div>
    </div>
  )
}
