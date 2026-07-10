import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileInput, ChevronRight, SlidersHorizontal, Pencil, Trash2, Palette, Package, MessageSquareText, Table2 } from 'lucide-react'
import { datasetsApi, domainsApi, textCodingApi, extractApiError } from '@/lib/api'
import { toast } from 'sonner'
import { setPendingImportFiles } from '@/lib/pending-import-files'
import { isSupportedDatasetFile } from '@/lib/dataset-import-formats'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import InlineEditableText from '@/components/InlineEditableText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { getDatasetAccent } from '@/components/crosswalk/dataset-color'

export default function DatasetsListPage() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: datasetsData, isLoading } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => datasetsApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const { data: domainsData } = useQuery({
    queryKey: ['analysis-domains', projectId],
    queryFn: () => domainsApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const { data: textColumnsData } = useQuery({
    queryKey: ['text-columns', projectId],
    queryFn: () => textCodingApi.columns(projectId),
    enabled: !isNaN(projectId),
  })

  const datasets = datasetsData?.datasets ?? []
  const domainCount = domainsData?.domains?.length ?? 0
  const hasTextColumns = (textColumnsData?.columns?.length ?? 0) > 0

  const deleteMutation = useMutation({
    mutationFn: (datasetId: number) => datasetsApi.delete(projectId, datasetId),
    onSuccess: () => {
      setDeleteDataset(null)
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to delete dataset')),
  })

  const [deleteDataset, setDeleteDataset] = useState<{ id: number; name: string } | null>(null)
  const [editingDatasetId, setEditingDatasetId] = useState<number | null>(null)
  const [colorPickerDatasetId, setColorPickerDatasetId] = useState<number | null>(null)

  const updateDatasetMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; color?: string | null }) =>
      datasetsApi.update(projectId, id, data),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['datasets', projectId] })
      queryClient.invalidateQueries({ queryKey: ['dataset', projectId, variables.id] })
      // The crosswalk's all-columns query carries the denormalized
      // dataset_color — invalidate so the dot picks up the new color
      // without a hard refresh.
      queryClient.invalidateQueries({ queryKey: ['project-columns', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    },
    onError: (err: Error) => toast.error(extractApiError(err, 'Failed to update dataset')),
  })

  // Drag-and-drop
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const dragHandlers = useCallback(() => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current++
      setIsDragOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        setIsDragOver(false)
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)
      const droppedFiles = Array.from(e.dataTransfer.files)
      // #540: route through the single-source format gate — this filter was the
      // one consumer the dataset-import-formats sweep missed, silently dropping
      // .xlsx/.sav files that every other surface accepts.
      const supportedFiles = droppedFiles.filter(f => isSupportedDatasetFile(f.name))
      if (supportedFiles.length === 0) return
      setPendingImportFiles(supportedFiles, 'dataset')
      navigate(`/projects/${projectId}/datasets/import`)
    },
  }), [projectId, navigate])

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-3.5 py-3.5">
        <div className="text-center py-12 text-mm-text-muted">Loading datasets...</div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-3.5 py-3.5">
      {/* Sub-nav row */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1">
          <button
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-[hsl(var(--mm-orange)/0.08)] text-mm-orange-text border border-[hsl(var(--mm-orange)/0.25)]"
          >
            All Datasets
            {datasets.length > 0 && (
              <span className="ml-1.5 opacity-60">{datasets.length}</span>
            )}
          </button>
          <button
            onClick={() => navigate(`/projects/${projectId}/datasets/variable-groups`)}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-mm-text-muted hover:text-mm-text transition-colors inline-flex items-center gap-1.5 border border-mm-surface-border hover:border-mm-text-muted"
          >
            <Package className="w-3.5 h-3.5" aria-hidden="true" />
            Variable Groups{domainCount > 0 ? ` (${domainCount})` : ''}
            <ChevronRight className="w-3 h-3" />
          </button>
          {hasTextColumns && (
            <button
              onClick={() => navigate(`/projects/${projectId}/datasets/text-coding`)}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-mm-text-muted hover:text-mm-text transition-colors inline-flex items-center gap-1.5 border border-mm-surface-border hover:border-mm-text-muted"
            >
              <MessageSquareText className="w-3.5 h-3.5" aria-hidden="true" />
              Code Text
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
        <button
          onClick={() => navigate(`/projects/${projectId}/datasets/import`)}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-orange))] hover:opacity-90 transition-opacity"
        >
          <FileInput className="w-3.5 h-3.5" />
          Import
        </button>
      </div>

      {/* Content */}
      {datasets.length === 0 ? (
        /* Empty state with drag-and-drop */
        <div
          className={`rounded-lg border bg-mm-surface p-12 text-center transition-colors ${
            isDragOver
              ? 'border-[hsl(var(--mm-orange))] border-2'
              : 'border-mm-surface-border'
          }`}
          {...dragHandlers()}
        >
          <Table2 className="w-8 h-8 mx-auto mb-4 text-mm-text-faint" aria-hidden="true" />
          {isDragOver ? (
            <>
              <h2 className="text-lg font-semibold text-[hsl(var(--mm-orange))] mb-2">Drop CSV files to import</h2>
              <p className="text-sm text-mm-text-muted">Release to start importing dataset</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mm-text mb-2">No datasets yet</h2>
              <p className="text-sm text-mm-text-muted mb-6">
                Import a dataset CSV to add quantitative data, or drag and drop CSV files here.
              </p>
              <button
                onClick={() => navigate(`/projects/${projectId}/datasets/import`)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-orange))] hover:opacity-90 transition-opacity"
              >
                <FileInput className="w-4 h-4" />
                Import Dataset
              </button>
            </>
          )}
        </div>
      ) : (
        /* Dataset table */
        <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-mm-surface-border">
                <th className="px-4 py-3 text-left text-[13px] font-medium text-mm-text-muted">Name</th>
                <th className="px-4 py-3 text-left text-[13px] font-medium text-mm-text-muted">Source</th>
                <th className="px-4 py-3 text-right text-[13px] font-medium text-mm-text-muted">Records</th>
                <th className="px-4 py-3 text-right text-[13px] font-medium text-mm-text-muted">Variables</th>
                <th className="px-4 py-3 text-right text-[13px] font-medium text-mm-text-muted">Open-Ended</th>
                <th className="px-4 py-3 text-right text-[13px] font-medium text-mm-text-muted">Imported</th>
                <th className="px-4 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mm-border-subtle">
              {datasets.map((ds) => {
                const allDatasetIds = datasets.map(d => d.id)
                const accentColor = getDatasetAccent(ds.id, allDatasetIds, ds.color)
                return (
                <ContextMenu key={ds.id}>
                  <ContextMenuTrigger asChild>
                    <tr
                      className="hover:bg-mm-bg cursor-pointer transition-colors"
                      onClick={() => navigate(`/projects/${projectId}/datasets/${ds.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-mm-text">
                        <div className="flex items-center gap-2">
                          <Popover
                            open={colorPickerDatasetId === ds.id}
                            onOpenChange={(open) => setColorPickerDatasetId(open ? ds.id : null)}
                          >
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                aria-label={`Change color for ${ds.name}`}
                                title={ds.color
                                  ? `${ds.name}: ${ds.color} — click to change`
                                  : `${ds.name}: auto-assigned color — click to customize`}
                                className="flex-none w-3 h-3 rounded-full border border-mm-border-subtle hover:scale-110 transition-transform focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
                                style={{ backgroundColor: accentColor }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                }}
                              />
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              className="w-auto p-3"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="text-xs text-mm-text-muted mb-2">
                                Color for <span className="font-medium text-mm-text">{ds.name}</span>
                              </div>
                              <ColorSwatchPicker
                                value={ds.color || accentColor}
                                onChange={(color) => {
                                  updateDatasetMutation.mutate({ id: ds.id, color })
                                  setColorPickerDatasetId(null)
                                }}
                              />
                              {ds.color && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="mt-2 w-full text-xs"
                                  onClick={() => {
                                    updateDatasetMutation.mutate({ id: ds.id, color: null })
                                    setColorPickerDatasetId(null)
                                  }}
                                >
                                  Reset to auto color
                                </Button>
                              )}
                            </PopoverContent>
                          </Popover>
                          <InlineEditableText
                            value={ds.name}
                            onSave={(name) => updateDatasetMutation.mutate({ id: ds.id, name })}
                            className="text-sm font-medium text-mm-text"
                            inputClassName="text-sm font-medium"
                            startEditing={editingDatasetId === ds.id}
                            onEditEnd={() => setEditingDatasetId(null)}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-mm-text-muted">{ds.source || '\u2014'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono tabular-nums text-mm-text">{ds.row_count}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono tabular-nums text-mm-orange-text">{ds.column_count}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono tabular-nums text-mm-purple-text">
                        {ds.open_ended_count > 0 ? ds.open_ended_count : '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-mm-text-muted">
                        {new Date(ds.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            className="px-2 py-0.5 rounded text-[11px] font-medium bg-[hsl(var(--mm-orange)/0.08)] border border-[hsl(var(--mm-orange)/0.18)] text-mm-orange-text hover:opacity-80 transition-opacity"
                            aria-label={`Recode variables in ${ds.name}`}
                            onClick={e => {
                              e.stopPropagation()
                              navigate(`/projects/${projectId}/datasets/${ds.id}/recode`)
                            }}
                          >
                            Recode
                          </button>
                          <ChevronRight className="w-4 h-4 text-mm-text-faint" />
                        </div>
                      </td>
                    </tr>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => setEditingDatasetId(ds.id)}>
                      <Pencil className="w-4 h-4 mr-2" />
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setColorPickerDatasetId(ds.id)}>
                      <Palette className="w-4 h-4 mr-2" />
                      Change color…
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => navigate(`/projects/${projectId}/datasets/${ds.id}/recode`)}
                    >
                      <SlidersHorizontal className="w-4 h-4 mr-2" />
                      Recode Variables
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => setDeleteDataset({ id: ds.id, name: ds.name })}
                      className="text-red-600"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete Dataset
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteDataset !== null}
        onOpenChange={(open) => { if (!open) setDeleteDataset(null) }}
        title="Delete Dataset"
        description={`Delete "${deleteDataset?.name}"? All columns, rows, recodes, and associated data will be permanently removed.`}
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
        loadingLabel="Deleting..."
        onConfirm={() => {
          if (deleteDataset !== null) {
            deleteMutation.mutate(deleteDataset.id)
          }
        }}
        destructive
      />
    </div>
  )
}
