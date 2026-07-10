import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatBytes } from '@/lib/format'
import { useNavigate } from 'react-router-dom'
import { Quote, FileInput, ChevronRight, Layers, MessageSquareText, Package, Pencil, MessageSquare, Table2, FileText, BarChart3, Users, StickyNote } from 'lucide-react'
import { projectsApi, projectPortabilityApi } from '@/lib/api'
import { toast } from 'sonner'
import type { RecentConversation, RecentDataset, RecentDocument } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import InlineEditableText from '@/components/InlineEditableText'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const ACCENT = {
  green: {
    text: 'text-mm-green-text',
    bg: 'bg-[hsl(var(--mm-green)/0.12)]',
    icon: 'text-mm-green',
    border: 'hover:border-[hsl(var(--mm-green)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-green)/0.18)]',
    leftBar: 'border-l-[hsl(var(--mm-green)/0.5)]',
  },
  orange: {
    text: 'text-mm-orange-text',
    bg: 'bg-[hsl(var(--mm-orange)/0.12)]',
    icon: 'text-mm-orange',
    border: 'hover:border-[hsl(var(--mm-orange)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-orange)/0.18)]',
    leftBar: 'border-l-[hsl(var(--mm-orange)/0.5)]',
  },
  purple: {
    text: 'text-mm-purple-text',
    bg: 'bg-[hsl(var(--mm-purple)/0.12)]',
    icon: 'text-mm-purple',
    border: 'hover:border-[hsl(var(--mm-purple)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-purple)/0.18)]',
    leftBar: 'border-l-[hsl(var(--mm-purple)/0.5)]',
  },
  blue: {
    text: 'text-mm-blue-text',
    bg: 'bg-[hsl(var(--mm-blue)/0.12)]',
    icon: 'text-mm-blue',
    border: 'hover:border-[hsl(var(--mm-blue)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-blue)/0.18)]',
    leftBar: 'border-l-[hsl(var(--mm-blue)/0.5)]',
  },
  canvas: {
    text: 'text-mm-canvas-text',
    bg: 'bg-[hsl(var(--mm-canvas)/0.12)]',
    icon: 'text-mm-canvas',
    border: 'hover:border-[hsl(var(--mm-canvas)/0.5)]',
    iconBorder: 'border-[hsl(var(--mm-canvas)/0.18)]',
    leftBar: 'border-l-[hsl(var(--mm-canvas)/0.5)]',
  },
} as const

export default function OverviewPage() {
  const { project, projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [exportingProject, setExportingProject] = useState(false)
  const [editingField, setEditingField] = useState<'name' | 'description' | null>(null)

  const updateProjectMutation = useMutation({
    mutationFn: (data: Partial<{ name: string; description: string | null }>) =>
      projectsApi.update(Number(projectId), data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const handleExportProject = useCallback(async () => {
    setExportingProject(true)
    try {
      await projectPortabilityApi.exportProject(projectId)
      toast.success('Project exported')
    } catch {
      toast.error('Export failed')
    } finally {
      setExportingProject(false)
    }
  }, [projectId])

  // Slab 5 storage visibility: on-disk footprint (media incl. video +
  // documents). Same key as the export dialog → shared cache.
  const { data: storage } = useQuery({
    queryKey: ['project-storage', projectId],
    queryFn: () => projectsApi.storage(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
  })

  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => projectsApi.summary(projectId),
    staleTime: 30_000,
    enabled: !isNaN(projectId),
  })

  const s = summary
  const isEmpty = s && s.conversations === 0 && s.datasets === 0 && s.documents === 0

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        {/* Header skeleton */}
        <div className="mb-3.5 flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-6 w-48 rounded bg-mm-surface animate-pulse" />
            <div className="h-4 w-72 rounded bg-mm-surface animate-pulse" />
          </div>
          <div className="h-9 w-32 rounded-md bg-mm-surface animate-pulse shrink-0" />
        </div>
        {/* Stats bar skeleton */}
        <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card mb-3.5">
          <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-mm-border-subtle">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="px-1.5 py-2 flex flex-col items-center gap-1">
                <div className="h-5 w-8 rounded bg-mm-bg animate-pulse" />
                <div className="h-3 w-14 rounded bg-mm-bg animate-pulse" />
              </div>
            ))}
          </div>
        </div>
        {/* Workspace cards skeleton */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-3">
              <div className="flex items-start gap-3">
                <div className="w-[34px] h-[34px] rounded-md bg-mm-bg animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-28 rounded bg-mm-bg animate-pulse" />
                  <div className="h-3 w-20 rounded bg-mm-bg animate-pulse" />
                  <div className="h-3 w-full rounded bg-mm-bg animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        <div role="alert" className="p-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-lg text-sm">
          Failed to load project summary. Please try refreshing the page.
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      {/* Project header */}
      <div className="mb-3.5 flex items-start justify-between">
        <div className="min-w-0 flex-1 mr-3">
          <div className="flex items-center gap-1.5">
            <InlineEditableText
              value={project?.name ?? 'Project'}
              onSave={(name) => updateProjectMutation.mutate({ name })}
              className="text-lg font-bold text-mm-text"
              inputClassName="text-lg font-bold"
              tag="h3"
              startEditing={editingField === 'name'}
              onEditEnd={() => setEditingField(null)}
            />
            <button
              onClick={() => setEditingField('name')}
              className="p-1 rounded text-mm-text-faint hover:text-mm-text-secondary hover:bg-mm-surface-hover transition-colors shrink-0"
              aria-label="Rename project"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <InlineEditableText
              value={project?.description || ''}
              placeholder="No description"
              onSave={(description) => updateProjectMutation.mutate({ description: description || null })}
              className="text-sm text-mm-text-secondary"
              inputClassName="text-sm"
              tag="p"
              allowEmpty
              startEditing={editingField === 'description'}
              onEditEnd={() => setEditingField(null)}
            />
            <button
              onClick={() => setEditingField('description')}
              className="p-1 rounded text-mm-text-faint hover:text-mm-text-secondary hover:bg-mm-surface-hover transition-colors shrink-0"
              aria-label="Edit description"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        </div>
        <button
          onClick={handleExportProject}
          disabled={exportingProject}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-mm-border text-mm-text-secondary bg-mm-surface hover:bg-mm-surface-hover transition-colors disabled:opacity-50 shrink-0"
        >
          <Package className="w-4 h-4" />
          {exportingProject ? 'Exporting...' : 'Export Project'}
        </button>
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div className="rounded-lg border border-mm-surface-border bg-mm-surface p-8 mb-3.5 text-center">
          <h2 className="text-lg font-semibold text-mm-text mb-2">Get started</h2>
          <p className="text-sm text-mm-text-muted mb-3.5">
            Import conversations, documents, or datasets to begin your analysis.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => navigate(`/projects/${projectId}/conversations/import`)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-green))] hover:opacity-90 transition-opacity"
            >
              <FileInput className="w-4 h-4" />
              Import Conversations
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/documents/import`)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors dark:bg-purple-700 dark:hover:bg-purple-600"
            >
              <FileInput className="w-4 h-4" />
              Import Documents
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/datasets/import`)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-orange))] hover:opacity-90 transition-opacity"
            >
              <FileInput className="w-4 h-4" />
              Import Datasets
            </button>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {s && !isEmpty && (
        <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card mb-3.5">
          <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-mm-border-subtle">
            <StatCell label={plural(s.conversations, 'Conversation', 'Conversations')} value={s.conversations} accent="green" />
            <StatCell label={plural(s.datasets, 'Dataset', 'Datasets')} value={s.datasets} accent="orange" sub={s.total_records > 0 ? `${s.total_records} ${plural(s.total_records, 'record', 'records')}` : undefined} />
            <StatCell label={plural(s.documents, 'Document', 'Documents')} value={s.documents} accent="purple" sub={s.document_segments > 0 ? `${s.document_segments} ${plural(s.document_segments, 'segment', 'segments')}` : undefined} />
            <StatCell label={plural(s.participants, 'Participant', 'Participants')} value={s.participants} />
            <StatCell label={plural(s.codes, 'Code', 'Codes')} value={s.codes} accent="purple" sub={s.categories > 0 ? `${s.categories} ${plural(s.categories, 'category', 'categories')}` : undefined} />
            {/* #351/#352: stat tile now reflects participant-only count
              * (facilitator turns + universal-only-coded segments excluded).
              * Sub-label clarifies the new scope so users don't read the
              * post-fix drop as data loss. */}
            <StatCell
              label={plural(s.coded_segments, 'Coded Segment', 'Coded Segments')}
              value={s.coded_segments}
              sub="excludes facilitator"
              title="Non-facilitator segments with at least one substantive code. Facilitator turns and universal-only codes are excluded — this is separate from the Participants count above."
            />
            <StatCell
              label={plural(s.materials, 'Analysis', 'Analyses')}
              value={s.materials}
              accent="blue"
              sub={s.statistical_tests > 0 ? `${s.statistical_tests} stat ${plural(s.statistical_tests, 'test', 'tests')}` : 'saved'}
              title="Saved analyses — charts and tables you added to Materials."
            />
            <StatCell
              label={plural(s.canvas_count, 'Canvas', 'Canvases')}
              value={s.canvas_count}
              accent="purple"
              sub="saved"
              title="Saved canvases."
            />
          </div>
          {/* Slab 5: on-disk footprint — multi-GB recordings made disk usage
            * worth surfacing. Auto-backups exclude video (see Settings). */}
          {storage && (storage.media_bytes > 0 || storage.documents_bytes > 0) && (
            <p className="border-t border-mm-border-subtle px-3 py-1.5 text-[11px] text-mm-text-muted">
              On disk: {formatBytes(storage.media_bytes)} recordings
              {storage.video_bytes > 0 && (
                <> ({formatBytes(storage.video_bytes)} video — excluded from automatic backups)</>
              )}
              {' · '}{formatBytes(storage.documents_bytes)} documents
            </p>
          )}
        </div>
      )}

      {/* Workspace cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3.5">
        {/* Conversations */}
        <WorkspaceCard
          icon={<MessageSquare className="w-4 h-4" aria-hidden="true" />}
          title="Conversations"
          summary={s ? `${s.conversations} conversations` : undefined}
          description="Import, view, and code conversation transcripts."
          accent="green"
          onClick={() => navigate(`/projects/${projectId}/conversations`)}
          headerAction={{
            icon: <FileInput className="w-3 h-3" />,
            label: 'Import',
            onClick: () => navigate(`/projects/${projectId}/conversations/import`),
          }}
        >
          {s && s.recent_conversations.length > 0 && (
            <CardItems>
              {s.recent_conversations.map((c: RecentConversation) => (
                <ItemRow
                  key={c.id}
                  label={c.name}
                  /* "#/# coded" matches the documents card convention. The count
                   * + denominator still exclude facilitator turns (#351/#352);
                   * "participant coded" read awkwardly in the tight card space. */
                  detail={`${c.coded_segment_count}/${c.segment_count} coded`}
                  onClick={() => navigate(`/projects/${projectId}/conversations/${c.id}`)}
                  accent="green"
                />
              ))}
            </CardItems>
          )}
          {s && s.conversations === 0 && (
            <p className="text-[12px] text-mm-text-faint mt-3 italic">No conversations yet</p>
          )}
        </WorkspaceCard>

        {/* Datasets */}
        <WorkspaceCard
          icon={<Table2 className="w-4 h-4" aria-hidden="true" />}
          title="Datasets"
          summary={s ? `${s.datasets} datasets${s.total_variables > 0 ? ` \u00b7 ${s.total_variables} variables` : ''}` : undefined}
          description="Import data, recode scales, and manage variable groups."
          accent="orange"
          onClick={() => navigate(`/projects/${projectId}/datasets`)}
          headerAction={{
            icon: <FileInput className="w-3 h-3" />,
            label: 'Import',
            onClick: () => navigate(`/projects/${projectId}/datasets/import`),
          }}
        >
          {s && s.datasets > 0 && (
            <CardItems>
              {s.recent_datasets.map((d: RecentDataset) => (
                <ItemRow
                  key={d.id}
                  label={d.name}
                  detail={`${d.row_count} records`}
                  onClick={() => navigate(`/projects/${projectId}/datasets/${d.id}`)}
                  accent="orange"
                />
              ))}
              <div className="border-t border-mm-border-subtle pt-1.5 mt-0.5 space-y-1.5">
                <NavRow
                  icon={<Layers className="w-3.5 h-3.5 text-mm-text-muted" />}
                  label="Variable Groups"
                  onClick={() => navigate(`/projects/${projectId}/datasets/variable-groups`)}
                  accent="orange"
                />
                {s.open_ended_columns > 0 && (
                  <NavRow
                    icon={<MessageSquareText className="w-3.5 h-3.5 text-mm-text-muted" />}
                    label="Code Text"
                    onClick={() => navigate(`/projects/${projectId}/datasets/text-coding`)}
                    accent="orange"
                  />
                )}
              </div>
            </CardItems>
          )}
          {s && s.datasets === 0 && (
            <p className="text-[12px] text-mm-text-faint mt-3 italic">No datasets yet</p>
          )}
        </WorkspaceCard>

        {/* Documents */}
        <WorkspaceCard
          icon={<FileText className="w-4 h-4" aria-hidden="true" />}
          title="Documents"
          summary={s ? `${s.documents} documents` : undefined}
          description="Upload and annotate field notes, reports, and other documents."
          accent="purple"
          onClick={() => navigate(`/projects/${projectId}/documents`)}
          headerAction={{
            icon: <FileInput className="w-3 h-3" />,
            label: 'Import',
            onClick: () => navigate(`/projects/${projectId}/documents/import`),
          }}
        >
          {s && s.recent_documents && s.recent_documents.length > 0 && (
            <CardItems>
              {s.recent_documents.map((d: RecentDocument) => (
                <ItemRow
                  key={d.id}
                  label={d.name}
                  detail={`${d.coded_segment_count}/${d.segment_count} coded`}
                  onClick={() => navigate(`/projects/${projectId}/documents/${d.id}`)}
                  accent="purple"
                />
              ))}
            </CardItems>
          )}
          {s && s.documents === 0 && (
            <p className="text-[12px] text-mm-text-faint mt-3 italic">No documents yet</p>
          )}
        </WorkspaceCard>

        {/* Analysis */}
        <WorkspaceCard
          icon={<BarChart3 className="w-4 h-4" aria-hidden="true" />}
          title="Analysis"
          summary={s ? `${s.materials} saved analyses` : undefined}
          description="Visualize quantitative results, explore qualitative patterns, and run statistical tests."
          accent="blue"
          onClick={() => navigate(`/projects/${projectId}/analysis`)}
        >
          <div
            className="mt-3 space-y-1.5"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
          >
            <button
              onClick={() => navigate(`/projects/${projectId}/analysis/qualitative`)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs font-medium text-mm-green-text bg-[hsl(var(--mm-green)/0.06)] border border-[hsl(var(--mm-green)/0.18)] hover:border-[hsl(var(--mm-green)/0.4)] transition-colors cursor-pointer"
            >
              Qualitative
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/analysis/quantitative`)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs font-medium text-mm-orange-text bg-[hsl(var(--mm-orange)/0.06)] border border-[hsl(var(--mm-orange)/0.18)] hover:border-[hsl(var(--mm-orange)/0.4)] transition-colors cursor-pointer"
            >
              Quantitative
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/analysis/codebook`)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs font-medium text-mm-blue-text bg-[hsl(var(--mm-blue)/0.06)] border border-[hsl(var(--mm-blue)/0.18)] hover:border-[hsl(var(--mm-blue)/0.4)] transition-colors cursor-pointer"
            >
              Codebook
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/analysis/canvas`)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs font-medium text-mm-canvas-text bg-[hsl(var(--mm-canvas)/0.06)] border border-[hsl(var(--mm-canvas)/0.18)] hover:border-[hsl(var(--mm-canvas)/0.4)] transition-colors cursor-pointer"
            >
              Canvas
            </button>
          </div>
        </WorkspaceCard>
      </div>

      {/* Secondary links */}
      {s && !isEmpty && (
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => navigate(`/projects/${projectId}/participants`)}
            className="inline-flex items-center gap-1.5 bg-mm-surface border border-mm-surface-border rounded-[5px] px-3 py-1.5 text-mm-text-secondary hover:text-mm-text hover:border-mm-text-faint hover:shadow-xs transition-all"
          >
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-semibold text-mm-text">{s.participants}</span> participants
          </button>
          <button
            onClick={() => navigate(`/projects/${projectId}/memos-notes`)}
            className="inline-flex items-center gap-1.5 bg-mm-surface border border-mm-surface-border rounded-[5px] px-3 py-1.5 text-mm-text-secondary hover:text-mm-text hover:border-mm-text-faint hover:shadow-xs transition-all"
          >
            <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-semibold text-mm-text">{s.memos}</span> memos
            {s.notes_count > 0 && (
              <span className="text-mm-text-muted">· {s.notes_count} notes</span>
            )}
          </button>
          <button
            onClick={() => navigate(`/projects/${projectId}/analysis/qualitative?tab=quoteboard`)}
            className="inline-flex items-center gap-1.5 bg-mm-surface border border-mm-surface-border rounded-[5px] px-3 py-1.5 text-mm-text-secondary hover:text-mm-text hover:border-mm-text-faint hover:shadow-xs transition-all"
          >
            <Quote className="w-4 h-4 fill-amber-400 text-amber-400" />
            Quotes
          </button>
        </div>
      )}
    </div>
  )
}

function StatCell({
  label,
  value,
  accent,
  sub,
  title,
}: {
  label: string
  value: number
  accent?: keyof typeof ACCENT
  sub?: string
  /** Optional hover/explanation text — clarifies how a stat is scoped (#468). */
  title?: string
}) {
  return (
    <div className="px-1.5 py-2 text-center" title={title}>
      <div className={`text-lg font-bold font-mono tabular-nums leading-tight ${accent ? ACCENT[accent].text : 'text-mm-text'}`}>
        {value}
      </div>
      <div className="text-[10px] font-medium text-mm-text-muted mt-0.5">{label}</div>
      {sub && <div className="text-[9px] text-mm-text-faint">{sub}</div>}
    </div>
  )
}

function WorkspaceCard({
  icon,
  title,
  summary,
  description,
  accent,
  disabled,
  onClick,
  children,
  headerAction,
}: {
  icon: React.ReactNode
  title: string
  summary?: string
  description: string
  accent: keyof typeof ACCENT
  disabled?: boolean
  onClick: () => void
  children?: React.ReactNode
  headerAction?: { icon: React.ReactNode; label: string; onClick: () => void }
}) {
  const a = ACCENT[accent]
  return (
    <div
      role="group"
      aria-label={title}
      onClick={disabled ? undefined : onClick}
      onKeyDown={disabled ? undefined : (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onClick() }}
      tabIndex={disabled ? undefined : 0}
      aria-disabled={disabled || undefined}
      className={`text-left rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-3 transition-colors h-full ${a.border} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-[34px] h-[34px] rounded-md ${a.bg} border ${a.iconBorder} flex items-center justify-center shrink-0`}>
          <span className={a.icon}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-mm-text">{title}</div>
            {headerAction && (
              <button
                onClick={(e) => { e.stopPropagation(); headerAction.onClick() }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium text-mm-text-muted hover:text-mm-text hover:bg-mm-bg border border-mm-border-subtle transition-colors cursor-pointer shrink-0"
              >
                {headerAction.icon}
                {headerAction.label}
              </button>
            )}
          </div>
          <div className={`text-xs ${a.text} ${summary ? '' : 'invisible'}`}>{summary || '\u00A0'}</div>
          <p className="text-xs text-mm-text-muted mt-1 leading-relaxed">{description}</p>
          {children}
        </div>
      </div>
    </div>
  )
}

function CardItems({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-3 space-y-1.5"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
    >
      {children}
    </div>
  )
}

function ItemRow({
  label,
  detail,
  onClick,
  accent,
}: {
  label: string
  detail: string
  onClick: () => void
  accent: keyof typeof ACCENT
}) {
  const a = ACCENT[accent]
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs text-mm-text bg-mm-bg border border-mm-border-subtle border-l-2 ${a.leftBar} hover:border-mm-text-faint transition-colors cursor-pointer group`}
    >
      <span className="truncate font-medium">{label}</span>
      <span className="ml-auto shrink-0 text-[11px] text-mm-text-muted font-mono tabular-nums">{detail}</span>
      <ChevronRight className="w-3 h-3 text-mm-text-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  )
}

function NavRow({
  icon,
  label,
  onClick,
  accent,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  accent: keyof typeof ACCENT
}) {
  const a = ACCENT[accent]
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-xs font-medium text-mm-text border border-mm-border-subtle border-l-2 ${a.leftBar} hover:border-mm-text-faint transition-colors cursor-pointer`}
    >
      {icon}
      {label}
    </button>
  )
}
