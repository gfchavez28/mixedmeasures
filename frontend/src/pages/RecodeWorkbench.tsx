import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Star, WandSparkles, Copy, Plus, Trash2, ArrowUpDown, ChevronDown, ChevronRight, Layers, Link2 } from 'lucide-react'
import {
  datasetsApi,
  recodeApi,
  type DatasetColumn,
  type RecodeDefinition,
  type ValueFrequency,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import { TypeBadge } from '@/components/TypeBadge'
import { CopyToDialog } from '@/components/CopyToDialog'
import { CopyToEquivalentsDialog } from '@/components/CopyToEquivalentsDialog'

const RECODE_DISALLOWED_TYPES = new Set(['open_text'])

/** Determine labels for a draft mapping preview, in priority order */
function getLabels(
  existingDefinitions: RecodeDefinition[],
  selectedColumn: DatasetColumn | undefined,
  frequenciesData: { frequencies: ValueFrequency[] } | undefined,
): string[] {
  // 1. Keys from first existing definition
  if (existingDefinitions.length > 0) {
    return Object.keys(existingDefinitions[0].mapping)
  }
  // 2. scale_labels from the column
  if (selectedColumn?.scale_labels && selectedColumn.scale_labels.length > 0) {
    return selectedColumn.scale_labels
  }
  // 3. Non-NA frequency values
  if (frequenciesData?.frequencies) {
    const vals = frequenciesData.frequencies
      .filter(f => !f.is_na)
      .map(f => f.value_text)
    if (vals.length > 0) return vals
  }
  return []
}

// ── Scale Map Editor ─────────────────────────────────────────────────────────

function ScaleMapEditor({
  mapping,
  excludeValues,
  onChange,
}: {
  mapping: Record<string, number | string>
  excludeValues: string[]
  onChange: (mapping: Record<string, number | string>, excludeValues: string[]) => void
}) {
  const [newLabel, setNewLabel] = useState('')
  const entries = Object.entries(mapping)

  const handleNumericChange = (label: string, value: string) => {
    const num = value === '' ? 0 : parseFloat(value)
    if (!isNaN(num)) {
      onChange({ ...mapping, [label]: num }, excludeValues)
    }
  }

  const handleExcludeToggle = (label: string) => {
    const isExcluded = excludeValues.includes(label)
    if (isExcluded) {
      onChange(mapping, excludeValues.filter(v => v !== label))
    } else {
      onChange(mapping, [...excludeValues, label])
    }
  }

  const handleFlip = () => {
    const numericEntries = entries.filter(([label]) => !excludeValues.includes(label))
    const values = numericEntries.map(([, v]) => Number(v))
    const max = Math.max(...values)
    const min = Math.min(...values)
    const flipped: Record<string, number | string> = {}
    for (const [label, val] of entries) {
      if (excludeValues.includes(label)) {
        flipped[label] = val
      } else {
        flipped[label] = max + min - Number(val)
      }
    }
    onChange(flipped, excludeValues)
  }

  const handleAddLabel = () => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed in mapping) return
    const numericValues = entries.filter(([l]) => !excludeValues.includes(l)).map(([, v]) => Number(v))
    const nextVal = numericValues.length > 0 ? Math.max(...numericValues) + 1 : 1
    onChange({ ...mapping, [trimmed]: nextVal }, excludeValues)
    setNewLabel('')
  }

  const handleRemoveLabel = (label: string) => {
    const { [label]: _, ...rest } = mapping
    onChange(rest, excludeValues.filter(v => v !== label))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mm-text-muted font-medium">Mapping</span>
        <Button variant="outline" size="sm" onClick={handleFlip} className="text-xs h-7">
          <ArrowUpDown className="w-3 h-3 mr-1" />
          Flip Values
        </Button>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-center py-1 px-2 w-20">Value</th>
            <th scope="col" className="text-center py-1 pl-2 w-16">Exclude</th>
            <th scope="col" className="w-8"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, val]) => {
            const isExcluded = excludeValues.includes(label)
            return (
              <tr key={label} className={`border-t ${isExcluded ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2 text-mm-text">{label}</td>
                <td className="py-1.5 px-2">
                  <Input
                    type="number"
                    value={isExcluded ? '' : val}
                    onChange={(e) => handleNumericChange(label, e.target.value)}
                    disabled={isExcluded}
                    className="h-7 text-center text-sm"
                  />
                </td>
                <td className="py-1.5 pl-2 text-center">
                  <Checkbox
                    checked={isExcluded}
                    onCheckedChange={() => handleExcludeToggle(label)}
                  />
                </td>
                <td className="py-1.5 pl-1">
                  <button
                    onClick={() => handleRemoveLabel(label)}
                    className="text-mm-border-medium hover:text-red-500 transition-colors"
                    title="Remove label"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            )
          })}
          <tr className="border-t">
            <td colSpan={4} className="py-1.5">
              <div className="flex items-center gap-1">
                <Input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel() } }}
                  placeholder="Add label (e.g. Not Applicable)..."
                  className="h-7 text-sm flex-grow"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={!newLabel.trim() || newLabel.trim() in mapping}
                  className="h-7 px-2 text-xs shrink-0"
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ── Category Group Editor ────────────────────────────────────────────────────

function CategoryGroupEditor({
  mapping,
  excludeValues,
  onChange,
}: {
  mapping: Record<string, number | string>
  excludeValues: string[]
  onChange: (mapping: Record<string, number | string>, excludeValues: string[]) => void
}) {
  const [newLabel, setNewLabel] = useState('')
  const entries = Object.entries(mapping)

  const handleGroupChange = (label: string, group: string) => {
    onChange({ ...mapping, [label]: group }, excludeValues)
  }

  const handleExcludeToggle = (label: string) => {
    const isExcluded = excludeValues.includes(label)
    if (isExcluded) {
      onChange(mapping, excludeValues.filter(v => v !== label))
    } else {
      onChange(mapping, [...excludeValues, label])
    }
  }

  const handleAddLabel = () => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed in mapping) return
    onChange({ ...mapping, [trimmed]: '' }, excludeValues)
    setNewLabel('')
  }

  const handleRemoveLabel = (label: string) => {
    const { [label]: _, ...rest } = mapping
    onChange(rest, excludeValues.filter(v => v !== label))
  }

  // Collect existing group names for autocomplete
  const existingGroups = [...new Set(entries.map(([, v]) => String(v)).filter(Boolean))]

  return (
    <div>
      <span className="text-xs text-mm-text-muted font-medium block mb-2">Group Mapping</span>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-left py-1 px-2">Group</th>
            <th scope="col" className="text-center py-1 pl-2 w-16">Exclude</th>
            <th scope="col" className="w-8"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, val]) => {
            const isExcluded = excludeValues.includes(label)
            return (
              <tr key={label} className={`border-t ${isExcluded ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2 text-mm-text">{label}</td>
                <td className="py-1.5 px-2">
                  <Input
                    value={isExcluded ? '' : String(val)}
                    onChange={(e) => handleGroupChange(label, e.target.value)}
                    disabled={isExcluded}
                    className="h-7 text-sm"
                    list={`groups-${label}`}
                    placeholder="Group name..."
                  />
                  <datalist id={`groups-${label}`}>
                    {existingGroups.map(g => <option key={g} value={g} />)}
                  </datalist>
                </td>
                <td className="py-1.5 pl-2 text-center">
                  <Checkbox
                    checked={isExcluded}
                    onCheckedChange={() => handleExcludeToggle(label)}
                  />
                </td>
                <td className="py-1.5 pl-1">
                  <button
                    onClick={() => handleRemoveLabel(label)}
                    className="text-mm-border-medium hover:text-red-500 transition-colors"
                    title="Remove label"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            )
          })}
          <tr className="border-t">
            <td colSpan={4} className="py-1.5">
              <div className="flex items-center gap-1">
                <Input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel() } }}
                  placeholder="Add label (e.g. Not Applicable)..."
                  className="h-7 text-sm flex-grow"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={!newLabel.trim() || newLabel.trim() in mapping}
                  className="h-7 px-2 text-xs shrink-0"
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ── Reverse Editor ───────────────────────────────────────────────────────────

function ReverseEditor({
  sourceDefinitionId,
  definitions,
  mapping,
}: {
  sourceDefinitionId: number | null
  definitions: RecodeDefinition[]
  mapping: Record<string, number | string>
}) {
  const sourceDef = definitions.find(d => d.id === sourceDefinitionId)

  if (!sourceDef) {
    return (
      <div className="text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded p-3">
        Source definition not found or deleted.
      </div>
    )
  }

  return (
    <div>
      <span className="text-xs text-mm-text-muted font-medium block mb-2">
        Reversed from: {sourceDef.name}
      </span>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-center py-1 px-2 w-20">Value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(mapping).map(([label, val]) => (
            <tr key={label} className="border-t">
              <td className="py-1.5 pr-2 text-mm-text">{label}</td>
              <td className="py-1.5 px-2 text-center text-mm-text-muted">{String(val)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Definition Card ──────────────────────────────────────────────────────────

function DefinitionCard({
  definition,
  allDefinitions,
  isExpanded,
  onToggleExpand,
  onSave,
  onDelete,
  onSetPrimary,
  onCopyTo,
  isSaving,
}: {
  definition: RecodeDefinition
  allDefinitions: RecodeDefinition[]
  isExpanded: boolean
  onToggleExpand: () => void
  onSave: (data: {
    name?: string
    mapping?: Record<string, number | string>
    exclude_values?: string[] | null
  }) => void
  onDelete: () => void
  onSetPrimary: () => void
  onCopyTo: () => void
  isSaving: boolean
}) {
  const [localName, setLocalName] = useState(definition.name)
  const [localMapping, setLocalMapping] = useState<Record<string, number | string>>(definition.mapping)
  const [localExcludes, setLocalExcludes] = useState<string[]>(definition.exclude_values || [])
  const [hasChanges, setHasChanges] = useState(false)

  // Reset local state when definition changes
  /* eslint-disable react-hooks/set-state-in-effect -- reset form fields on definition change */
  useEffect(() => {
    setLocalName(definition.name)
    setLocalMapping(definition.mapping)
    setLocalExcludes(definition.exclude_values || [])
    setHasChanges(false)
  }, [definition.id, definition.updated_at]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally reset only on id/timestamp change, not on every field
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMappingChange = (mapping: Record<string, number | string>, excludes: string[]) => {
    setLocalMapping(mapping)
    setLocalExcludes(excludes)
    setHasChanges(true)
  }

  const handleSave = () => {
    const data: Record<string, unknown> = {}
    if (localName !== definition.name) data.name = localName
    if (JSON.stringify(localMapping) !== JSON.stringify(definition.mapping)) data.mapping = localMapping
    if (JSON.stringify(localExcludes) !== JSON.stringify(definition.exclude_values || [])) {
      data.exclude_values = localExcludes.length > 0 ? localExcludes : null
    }
    if (Object.keys(data).length > 0) {
      onSave(data as { name?: string; mapping?: Record<string, number | string>; exclude_values?: string[] | null })
    }
  }

  const recodeTypeBadge = {
    scale_map: { label: 'Scale Map', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300' },
    category_group: { label: 'Category', cls: 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-300' },
    reverse: { label: 'Reverse', cls: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300' },
  }[definition.recode_type] || { label: definition.recode_type, cls: 'bg-mm-bg text-mm-text-muted' }

  return (
    <div className="border rounded-lg bg-mm-surface">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-mm-surface-hover"
        onClick={onToggleExpand}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4 text-mm-text-faint" /> : <ChevronRight className="w-4 h-4 text-mm-text-faint" />}
        <span className="font-medium text-sm flex-grow">{definition.name}</span>
        <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${recodeTypeBadge.cls}`}>
          {recodeTypeBadge.label}
        </span>
        {definition.is_primary && (
          <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
        )}
        {definition.is_auto_detected && (
          <span title="Auto-detected"><WandSparkles className="w-3.5 h-3.5 text-mm-text-faint" /></span>
        )}
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 border-t">
          {/* Name edit */}
          <div className="mt-2 mb-3">
            <label className="text-xs text-mm-text-muted block mb-1">Name</label>
            <Input
              value={localName}
              onChange={(e) => { setLocalName(e.target.value); setHasChanges(true) }}
              className="h-8 text-sm"
            />
          </div>

          {/* Type-specific editor */}
          {definition.recode_type === 'scale_map' && (
            <ScaleMapEditor
              mapping={localMapping}
              excludeValues={localExcludes}
              onChange={handleMappingChange}
            />
          )}
          {definition.recode_type === 'category_group' && (
            <CategoryGroupEditor
              mapping={localMapping}
              excludeValues={localExcludes}
              onChange={handleMappingChange}
            />
          )}
          {definition.recode_type === 'reverse' && (
            <ReverseEditor
              sourceDefinitionId={definition.source_definition_id}
              definitions={allDefinitions}
              mapping={localMapping}
            />
          )}

          {/* Unmapped values warning */}
          {definition.unmapped_values.length > 0 && (
            <div className="mt-3 p-2 bg-amber-50 dark:bg-amber-950/30 rounded text-xs text-amber-700 dark:text-amber-300">
              <strong>Unmapped values:</strong> {definition.unmapped_values.join(', ')}
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {hasChanges && (
              <Button size="sm" onClick={handleSave} disabled={isSaving} className="h-7 text-xs">
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            )}
            {!definition.is_primary && (
              <Button variant="outline" size="sm" onClick={onSetPrimary} className="h-7 text-xs">
                <Star className="w-3 h-3 mr-1" />
                Set Primary
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onCopyTo} className="h-7 text-xs">
              <Copy className="w-3 h-3 mr-1" />
              Copy to...
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete} className="h-7 text-xs text-red-600 hover:text-red-700">
              <Trash2 className="w-3 h-3 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── New Definition Form ──────────────────────────────────────────────────────

function NewDefinitionForm({
  existingDefinitions,
  onCreate,
  isCreating,
  selectedColumn,
  frequenciesData,
}: {
  existingDefinitions: RecodeDefinition[]
  onCreate: (data: {
    name: string
    recode_type: string
    output_type: string
    mapping: Record<string, number | string>
    exclude_values?: string[]
    source_definition_id?: number
  }) => void
  isCreating: boolean
  selectedColumn: DatasetColumn | undefined
  frequenciesData: { column_id: number; frequencies: ValueFrequency[]; total: number } | undefined
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'scale_map' | 'category_group' | 'reverse'>('scale_map')
  const [sourceDefId, setSourceDefId] = useState<number | null>(null)
  const [draftMapping, setDraftMapping] = useState<Record<string, number | string>>({})
  const [draftExcludeValues, setDraftExcludeValues] = useState<string[]>([])

  const scaleMapDefs = existingDefinitions.filter(d => d.recode_type === 'scale_map')
  const labels = useMemo(
    () => getLabels(existingDefinitions, selectedColumn, frequenciesData),
    [existingDefinitions, selectedColumn, frequenciesData],
  )

  // Rebuild draft mapping when type, source, or label inputs change
  /* eslint-disable react-hooks/set-state-in-effect -- rebuild draft mapping from recode type/source */
  useEffect(() => {
    if (type === 'scale_map') {
      setDraftMapping(Object.fromEntries(labels.map((l, i) => [l, i + 1])))
      setDraftExcludeValues([])
    } else if (type === 'category_group') {
      setDraftMapping(Object.fromEntries(labels.map(l => [l, ''])))
      setDraftExcludeValues([])
    } else if (type === 'reverse') {
      if (sourceDefId) {
        const sourceDef = existingDefinitions.find(d => d.id === sourceDefId)
        if (sourceDef) {
          const excludes = sourceDef.exclude_values || []
          const numericEntries = Object.entries(sourceDef.mapping).filter(([label]) => !excludes.includes(label))
          const values = numericEntries.map(([, v]) => Number(v))
          const max = Math.max(...values)
          const min = Math.min(...values)
          setDraftMapping(
            Object.fromEntries(
              Object.entries(sourceDef.mapping).map(([label, val]) =>
                excludes.includes(label) ? [label, val] : [label, max + min - Number(val)]
              )
            )
          )
          setDraftExcludeValues(excludes)
        } else {
          setDraftMapping({})
          setDraftExcludeValues([])
        }
      } else {
        setDraftMapping({})
        setDraftExcludeValues([])
      }
    }
  }, [type, sourceDefId, existingDefinitions, selectedColumn, frequenciesData, labels])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCreate = () => {
    if (!name.trim()) return

    const outputType = type === 'category_group' ? 'categorical' : 'numeric'

    onCreate({
      name: name.trim(),
      recode_type: type,
      output_type: outputType,
      mapping: draftMapping,
      ...(draftExcludeValues.length > 0 ? { exclude_values: draftExcludeValues } : {}),
      ...(type === 'reverse' && sourceDefId ? { source_definition_id: sourceDefId } : {}),
    })
    setName('')
  }

  return (
    <div className="border rounded-lg p-3 bg-mm-bg">
      <div className="flex items-center gap-2 mb-2">
        <Plus className="w-4 h-4 text-mm-text-faint" />
        <span className="text-sm font-medium text-mm-text">New Definition</span>
      </div>
      <div className="space-y-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Definition name..."
          className="h-8 text-sm"
        />
        <div className="flex gap-2 flex-wrap">
          {(['scale_map', 'category_group', 'reverse'] as const).map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-2 py-1 rounded text-xs font-medium border ${
                type === t ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-300' : 'bg-mm-surface border-mm-border-subtle text-mm-text-muted'
              }`}
            >
              {t === 'scale_map' ? 'Scale Map' : t === 'category_group' ? 'Category Group' : 'Reverse'}
            </button>
          ))}
        </div>
        {type === 'reverse' && scaleMapDefs.length > 0 && (
          <select
            value={sourceDefId || ''}
            onChange={e => setSourceDefId(e.target.value ? Number(e.target.value) : null)}
            className="w-full h-8 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
          >
            <option value="">Select source definition...</option>
            {scaleMapDefs.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}

        {/* Live draft preview */}
        {type === 'reverse' && scaleMapDefs.length === 0 ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            No scale map definitions exist to reverse.
          </div>
        ) : type === 'reverse' && !sourceDefId ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            Select a source definition above to preview.
          </div>
        ) : Object.keys(draftMapping).length > 0 ? (
          <div className="bg-mm-surface rounded border p-2">
            <span className="text-xs text-mm-text-muted font-medium block mb-1">Preview</span>
            {type === 'scale_map' && (
              <ScaleMapEditor
                mapping={draftMapping}
                excludeValues={draftExcludeValues}
                onChange={(mapping, excludes) => {
                  setDraftMapping(mapping)
                  setDraftExcludeValues(excludes)
                }}
              />
            )}
            {type === 'category_group' && (
              <CategoryGroupEditor
                mapping={draftMapping}
                excludeValues={draftExcludeValues}
                onChange={(mapping, excludes) => {
                  setDraftMapping(mapping)
                  setDraftExcludeValues(excludes)
                }}
              />
            )}
            {type === 'reverse' && (
              <ReverseEditor
                sourceDefinitionId={sourceDefId}
                definitions={existingDefinitions}
                mapping={draftMapping}
              />
            )}
          </div>
        ) : labels.length === 0 && (type === 'scale_map' || type === 'category_group') ? (
          <div className="text-xs text-mm-text-muted bg-mm-surface rounded p-3 border border-dashed">
            No response values found. Use the input below to add labels manually.
          </div>
        ) : labels.length === 0 ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            No labels available for preview. The mapping will be created empty.
          </div>
        ) : null}

        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!name.trim() || isCreating || (type === 'reverse' && !sourceDefId)}
          className="h-7 text-xs"
        >
          {isCreating ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function RecodeWorkbench() {
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const pid = parseInt(projectId || '0')
  const did = parseInt(datasetId || '0')
  const { setBreadcrumbLabel } = useProjectLayout()

  const queryClient = useQueryClient()

  // Ref to stabilize setSearchParams (not referentially stable from useSearchParams)
  const setSearchParamsRef = useRef(setSearchParams)
  setSearchParamsRef.current = setSearchParams

  // Selected column
  const selectedColumnId = searchParams.get('column') ? parseInt(searchParams.get('column')!) : null
  const setSelectedColumn = useCallback((id: number | null) => {
    if (id) setSearchParamsRef.current({ column: String(id) })
    else setSearchParamsRef.current({})
  }, [])

  // UI state
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [expandedDefs, setExpandedDefs] = useState<Set<number>>(new Set())
  const [copyDialogDef, setCopyDialogDef] = useState<RecodeDefinition | null>(null)
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set())
  const [bulkType, setBulkType] = useState<string>('ordinal')
  const [showEquivalentsAfterCreate, setShowEquivalentsAfterCreate] = useState<RecodeDefinition | null>(null)
  const [showEquivalentsSync, setShowEquivalentsSync] = useState(false)

  // Inline header editing
  const [headerEditing, setHeaderEditing] = useState<'name' | 'text' | null>(null)
  const [headerEditValue, setHeaderEditValue] = useState('')
  const headerInputRef = useRef<HTMLInputElement>(null)

  // Enter-to-advance refs
  const pendingEditField = useRef<'name' | 'text' | null>(null)
  const pendingTypeSelect = useRef(false)
  const typeSelectRef = useRef<HTMLSelectElement>(null)
  const isAdvancing = useRef(false)

  // Fetch columns
  const { data: columnsData } = useQuery({
    queryKey: ['dataset-columns', pid, did],
    queryFn: () => datasetsApi.listColumns(pid, did),
    enabled: !!pid && !!did,
  })
  const allColumns: DatasetColumn[] = useMemo(() => columnsData ?? [], [columnsData])

  // Fetch dataset
  const { data: dataset } = useQuery({
    queryKey: ['dataset', pid, did],
    queryFn: () => datasetsApi.get(pid, did),
    enabled: !!pid && !!did,
  })

  useEffect(() => {
    if (dataset?.name) setBreadcrumbLabel(dataset.name)
  }, [dataset?.name, setBreadcrumbLabel])

  // Fetch definitions for selected column
  const { data: definitions = [], isLoading: defsLoading } = useQuery({
    queryKey: ['recode-definitions', pid, did, selectedColumnId],
    queryFn: () => recodeApi.list(pid, did, selectedColumnId!),
    enabled: !!pid && !!did && !!selectedColumnId,
  })

  // Fetch frequencies for selected column
  const { data: frequenciesData } = useQuery({
    queryKey: ['column-frequencies', pid, did, selectedColumnId],
    queryFn: () => recodeApi.getFrequencies(pid, did, selectedColumnId!),
    enabled: !!pid && !!did && !!selectedColumnId,
  })

  // Header edit mutation
  const updateHeaderMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: { column_name?: string | null; column_text?: string | null } }) =>
      datasetsApi.updateColumnHeader(pid, did, columnId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
    },
  })

  const startHeaderEdit = useCallback((field: 'name' | 'text', currentValue: string) => {
    setHeaderEditing(field)
    setHeaderEditValue(currentValue)
  }, [])

  const commitHeaderEdit = useCallback(() => {
    if (!headerEditing || !selectedColumnId) return
    const trimmed = headerEditValue.trim()
    if (headerEditing === 'name') {
      const col = allColumns.find(q => q.id === selectedColumnId)
      const oldName = col?.column_name || ''
      if (trimmed !== oldName) {
        updateHeaderMutation.mutate({ columnId: selectedColumnId, data: { column_name: trimmed || null } })
      }
    } else {
      const col = allColumns.find(q => q.id === selectedColumnId)
      if (trimmed && trimmed !== col?.column_text) {
        updateHeaderMutation.mutate({ columnId: selectedColumnId, data: { column_text: trimmed } })
      }
    }
    setHeaderEditing(null)
  }, [headerEditing, headerEditValue, selectedColumnId, allColumns, updateHeaderMutation])

  const cancelHeaderEdit = useCallback(() => {
    setHeaderEditing(null)
  }, [])

  // Filtered columns by type filter (all types shown, including open-ended)
  const filteredColumns = useMemo(() => {
    if (typeFilter === 'all') return allColumns
    return allColumns.filter(q => q.column_type === typeFilter)
  }, [allColumns, typeFilter])

  const selectedColumn = allColumns.find(q => q.id === selectedColumnId)

  // Advance to the same header field on the next/previous column
  const advanceColumn = useCallback((direction: 1 | -1, editField: 'name' | 'text' | 'type') => {
    const currentIdx = filteredColumns.findIndex(q => q.id === selectedColumnId)
    if (currentIdx < 0) return
    const nextIdx = currentIdx + direction
    if (nextIdx < 0 || nextIdx >= filteredColumns.length) return

    if (editField === 'name' || editField === 'text') {
      pendingEditField.current = editField
    } else {
      pendingTypeSelect.current = true
    }
    setSelectedColumn(filteredColumns[nextIdx].id)

    // Scroll the new column into view in the left panel
    const nextId = filteredColumns[nextIdx].id
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-column-id="${nextId}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [filteredColumns, selectedColumnId, setSelectedColumn])

  // Reset editing state when switching columns (or auto-enter edit if advancing)
  useEffect(() => {
    const field = pendingEditField.current
    pendingEditField.current = null

    if (field && selectedColumn) {
      const val = field === 'name'
        ? (selectedColumn.column_name || '')
        : selectedColumn.column_text

      setHeaderEditing(field)

      setHeaderEditValue(val)
    } else {

      setHeaderEditing(null)
    }

    if (pendingTypeSelect.current) {
      pendingTypeSelect.current = false
      requestAnimationFrame(() => {
        typeSelectRef.current?.focus()
      })
    }
  }, [selectedColumnId]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally only on column change

  // Focus input when editing starts — no setState, just DOM focus
  useEffect(() => {
    if (headerEditing && headerInputRef.current) {
      headerInputRef.current.focus()
      headerInputRef.current.select()
    }
  }, [headerEditing])

  // Auto-select first column
  useEffect(() => {
    if (!selectedColumnId && allColumns.length > 0) {
      setSelectedColumn(allColumns[0].id)
    }
  }, [allColumns, selectedColumnId, setSelectedColumn])

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof recodeApi.create>[3]) =>
      recodeApi.create(pid, did, selectedColumnId!, data),
    onSuccess: (newDef) => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      // Crosswalk's ⟲ badge derives from ['reverse-columns', pid]; introducing
      // or modifying a recode def can change reverse-column membership.
      // setPrimaryMutation is intentionally NOT invalidated here — toggling
      // is_primary can't introduce or remove reverse defs.
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
      // Prompt to copy to equivalents if column is in an equivalence group
      if (selectedColumn?.equivalence_group_id && newDef.recode_type !== 'reverse') {
        setShowEquivalentsAfterCreate(newDef)
      }
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ defId, data }: { defId: number; data: Parameters<typeof recodeApi.update>[4] }) =>
      recodeApi.update(pid, did, selectedColumnId!, defId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (defId: number) =>
      recodeApi.delete(pid, did, selectedColumnId!, defId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  const setPrimaryMutation = useMutation({
    mutationFn: (defId: number) =>
      recodeApi.setPrimary(pid, did, selectedColumnId!, defId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
    },
  })

  const copyToMutation = useMutation({
    mutationFn: ({ defId, targetIds }: { defId: number; targetIds: number[] }) =>
      recodeApi.copyTo(pid, did, selectedColumnId!, defId, targetIds),
    onSuccess: () => {
      setCopyDialogDef(null)
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  const bulkTypeMutation = useMutation({
    mutationFn: () =>
      recodeApi.bulkTypeUpdate(pid, did, [...bulkSelected], bulkType),
    onSuccess: () => {
      setBulkSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
    },
  })

  const toggleExpanded = (defId: number) => {
    setExpandedDefs(prev => {
      const next = new Set(prev)
      if (next.has(defId)) next.delete(defId)
      else next.add(defId)
      return next
    })
  }

  const handleColumnClick = (qId: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Multi-select toggle
      setBulkSelected(prev => {
        const next = new Set(prev)
        if (next.has(qId)) next.delete(qId)
        else next.add(qId)
        return next
      })
    } else if (e.shiftKey && selectedColumnId) {
      // Range select
      const startIdx = filteredColumns.findIndex(q => q.id === selectedColumnId)
      const endIdx = filteredColumns.findIndex(q => q.id === qId)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)]
        const range = filteredColumns.slice(lo, hi + 1).map(q => q.id)
        setBulkSelected(new Set(range))
      }
    } else {
      setBulkSelected(new Set())
      setSelectedColumn(qId)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b bg-mm-surface flex-shrink-0">
        {dataset && <span className="text-sm text-mm-text-secondary">{dataset.name}</span>}
        <div className="flex-grow" />
        <Link to={`/projects/${pid}/datasets/variable-groups`}>
          <Button variant="outline" size="sm" className="text-sm">
            <Layers className="w-4 h-4 mr-1" />
            Variable Groups
          </Button>
        </Link>
      </div>

      {/* Body */}
      <div className="flex flex-grow overflow-hidden">
        {/* Left Panel: Question List */}
        <div className="w-[300px] border-r bg-mm-surface flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b">
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="w-full h-8 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
            >
              <option value="all">All types</option>
              {COLUMN_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Bulk toolbar */}
          {bulkSelected.size > 0 && (
            <div className="px-3 py-2 border-b bg-blue-50 dark:bg-blue-950/30 flex items-center gap-2">
              <span className="text-xs text-blue-700 dark:text-blue-300">{bulkSelected.size} selected</span>
              <select
                value={bulkType}
                onChange={e => setBulkType(e.target.value)}
                className="h-7 text-xs border rounded px-1 flex-grow bg-mm-surface text-mm-text border-mm-border-subtle"
              >
                {COLUMN_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={() => bulkTypeMutation.mutate()}
                disabled={bulkTypeMutation.isPending}
                className="h-7 text-xs"
              >
                Change
              </Button>
            </div>
          )}

          <div className="flex-grow overflow-y-auto">
            {filteredColumns.map(q => {
              const isSelected = q.id === selectedColumnId
              const isBulk = bulkSelected.has(q.id)
              const defCount = q.recode_definitions?.length || 0
              return (
                <div
                  key={q.id}
                  data-column-id={q.id}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={(e) => handleColumnClick(q.id, e)}
                  className={`px-3 py-2 border-b cursor-pointer text-sm ${
                    isSelected ? 'bg-blue-50 dark:bg-blue-950/30 border-l-2 border-l-blue-500' :
                    isBulk ? 'bg-blue-50/50 dark:bg-blue-950/20' :
                    'hover:bg-mm-surface-hover'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="truncate flex-grow font-medium text-mm-text">
                      {q.column_name || q.column_code || q.column_text.slice(0, 40)}
                    </span>
                    <TypeBadge type={q.column_type} />
                  </div>
                  {(q.column_name || q.column_code) && (
                    <div className="text-xs text-mm-text-muted truncate mt-0.5">
                      {q.column_text.slice(0, 50)}{q.column_text.length > 50 ? '...' : ''}
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {defCount > 0 && (
                      <span className="text-[11px] bg-muted text-mm-text-secondary px-1 rounded">
                        {defCount} def{defCount > 1 ? 's' : ''}
                      </span>
                    )}
                    {q.recode_definitions?.some(d => d.is_auto_detected) && (
                      <WandSparkles className="w-3 h-3 text-mm-text-faint" />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Panel: Definition Editor */}
        <div className="flex-grow overflow-y-auto p-4">
          {!selectedColumn ? (
            <div className="text-center text-mm-text-muted mt-12">
              Select a column from the left panel
            </div>
          ) : (
            <div className="max-w-2xl">
              {/* Question header */}
              <div className="mb-6">
                {headerEditing === 'name' ? (
                  <input
                    ref={headerInputRef}
                    value={headerEditValue}
                    onChange={(e) => setHeaderEditValue(e.target.value)}
                    onBlur={() => { if (!isAdvancing.current) commitHeaderEdit() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        isAdvancing.current = true
                        commitHeaderEdit()
                        advanceColumn(e.shiftKey ? -1 : 1, 'name')
                        queueMicrotask(() => { isAdvancing.current = false })
                      }
                      if (e.key === 'Escape') { e.preventDefault(); cancelHeaderEdit() }
                    }}
                    className="text-sm font-semibold text-mm-text-secondary mb-0.5 w-full border border-blue-300 dark:border-blue-700 rounded px-1.5 py-0.5 bg-mm-surface outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Short label (optional)"
                    maxLength={255}
                  />
                ) : (
                  <p
                    onClick={() => startHeaderEdit('name', selectedColumn.column_name || '')}
                    className="text-sm font-semibold text-mm-text-secondary mb-0.5 cursor-text hover:bg-mm-surface-hover rounded px-1.5 py-0.5 -mx-1.5 inline-block"
                    title={selectedColumn.column_name ? `${selectedColumn.column_name} (click to edit)` : 'Click to add a short label for this variable'}
                  >
                    {selectedColumn.column_name || <span className="text-mm-text-faint font-normal italic">Short label (optional)</span>}
                  </p>
                )}
                {headerEditing === 'text' ? (
                  <input
                    ref={headerInputRef}
                    value={headerEditValue}
                    onChange={(e) => setHeaderEditValue(e.target.value)}
                    onBlur={() => { if (!isAdvancing.current) commitHeaderEdit() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        isAdvancing.current = true
                        commitHeaderEdit()
                        advanceColumn(e.shiftKey ? -1 : 1, 'text')
                        queueMicrotask(() => { isAdvancing.current = false })
                      }
                      if (e.key === 'Escape') { e.preventDefault(); cancelHeaderEdit() }
                    }}
                    className="text-lg font-semibold text-mm-text w-full border border-blue-300 dark:border-blue-700 rounded px-1.5 py-0.5 bg-mm-surface outline-none focus:ring-1 focus:ring-ring"
                    maxLength={500}
                  />
                ) : (
                  <h2
                    onClick={() => startHeaderEdit('text', selectedColumn.column_text)}
                    className="text-lg font-semibold text-mm-text cursor-text hover:bg-mm-surface-hover rounded px-1.5 py-0.5 -mx-1.5"
                    title={`${selectedColumn.column_text} (click to edit)`}
                  >
                    {selectedColumn.column_text}
                  </h2>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {selectedColumn.column_code && (
                    <span className="text-sm text-mm-text-muted">{selectedColumn.column_code}</span>
                  )}
                  <select
                    ref={typeSelectRef}
                    value={selectedColumn.column_type}
                    onChange={(e) => {
                      const newType = e.target.value
                      if (newType !== selectedColumn.column_type) {
                        recodeApi.bulkTypeUpdate(pid, did, [selectedColumn.id], newType).then(() => {
                          queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
                          queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
                        })
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        advanceColumn(e.shiftKey ? -1 : 1, 'type')
                      }
                    }}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium border-none cursor-pointer focus:ring-1 focus:ring-ring focus:outline-none ${
                      TYPE_BADGE_CLASSES[selectedColumn.column_type] || 'bg-mm-bg text-mm-text-muted'
                    }`}
                  >
                    {COLUMN_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {selectedColumn.scale_labels && (
                    <span className="text-xs text-mm-text-faint">
                      {selectedColumn.scale_points}-point
                    </span>
                  )}
                </div>
                {selectedColumn.equivalence_group_id && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/30 dark:text-indigo-300 text-xs">
                      <Link2 className="w-3 h-3" />
                      {selectedColumn.equivalence_group_label}
                    </span>
                    {definitions.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowEquivalentsSync(true)}
                        className="h-6 text-xs gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        Copy to Equivalents
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Frequency summary */}
              {frequenciesData && frequenciesData.frequencies.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-xs font-medium text-mm-text-muted uppercase mb-2">Value Frequencies</h3>
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-mm-bg text-xs text-mm-text-muted">
                          <th scope="col" className="text-left py-1.5 px-3">Value</th>
                          <th scope="col" className="text-right py-1.5 px-3 w-16">Count</th>
                          <th scope="col" className="text-right py-1.5 px-3 w-16">%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {frequenciesData.frequencies.map((f: ValueFrequency) => (
                          <tr key={f.value_text} className={`border-t ${f.is_na ? 'text-mm-text-faint italic' : ''}`}>
                            <td className="py-1 px-3">{f.value_text}{f.is_na ? ' (N/A)' : ''}</td>
                            <td className="py-1 px-3 text-right">{f.count}</td>
                            <td className="py-1 px-3 text-right">
                              {frequenciesData.total > 0 ? Math.round(f.count / frequenciesData.total * 100) : 0}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Definitions — disabled for open-ended types */}
              {RECODE_DISALLOWED_TYPES.has(selectedColumn.column_type) ? (
                <div className="mb-4 p-4 rounded-lg border border-dashed border-mm-border-medium text-center">
                  <p className="text-sm text-mm-text-faint">
                    Recode definitions are not available for {selectedColumn.column_type} columns.
                  </p>
                  <p className="text-xs text-mm-text-faint mt-1">
                    Change the column type above if this was misdetected.
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <h3 className="text-xs font-medium text-mm-text-muted uppercase mb-2">
                      Recode Definitions ({definitions.length})
                    </h3>
                    <div className="space-y-2">
                      {defsLoading ? (
                        <div className="text-sm text-mm-text-faint">Loading definitions...</div>
                      ) : (
                        definitions.map(def => (
                          <DefinitionCard
                            key={def.id}
                            definition={def}
                            allDefinitions={definitions}
                            isExpanded={expandedDefs.has(def.id)}
                            onToggleExpand={() => toggleExpanded(def.id)}
                            onSave={(data) => updateMutation.mutate({ defId: def.id, data })}
                            onDelete={() => deleteMutation.mutate(def.id)}
                            onSetPrimary={() => setPrimaryMutation.mutate(def.id)}
                            onCopyTo={() => setCopyDialogDef(def)}
                            isSaving={updateMutation.isPending}
                          />
                        ))
                      )}
                    </div>
                  </div>

                  {/* New definition form */}
                  <NewDefinitionForm
                    existingDefinitions={definitions}
                    onCreate={(data) => createMutation.mutate(data)}
                    isCreating={createMutation.isPending}
                    selectedColumn={selectedColumn}
                    frequenciesData={frequenciesData}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Copy-to dialog (within same dataset) */}
      {copyDialogDef && (
        <CopyToDialog
          open={!!copyDialogDef}
          onClose={() => setCopyDialogDef(null)}
          columns={allColumns}
          currentColumnId={selectedColumnId!}
          definitionName={copyDialogDef.name}
          onCopy={(ids) => copyToMutation.mutate({ defId: copyDialogDef.id, targetIds: ids })}
          isCopying={copyToMutation.isPending}
        />
      )}

      {/* Copy to Equivalents — after creating a new definition */}
      {showEquivalentsAfterCreate && selectedColumn?.equivalence_group_id && (
        <CopyToEquivalentsDialog
          open={!!showEquivalentsAfterCreate}
          onClose={() => setShowEquivalentsAfterCreate(null)}
          sourceColumn={selectedColumn}
          definitions={[showEquivalentsAfterCreate]}
          equivalenceGroupId={selectedColumn.equivalence_group_id}
          projectId={pid}
          onCopyComplete={() => setShowEquivalentsAfterCreate(null)}
        />
      )}

      {/* Copy to Equivalents — sync all definitions */}
      {showEquivalentsSync && selectedColumn?.equivalence_group_id && (
        <CopyToEquivalentsDialog
          open={showEquivalentsSync}
          onClose={() => setShowEquivalentsSync(false)}
          sourceColumn={selectedColumn}
          definitions={definitions}
          equivalenceGroupId={selectedColumn.equivalence_group_id}
          projectId={pid}
          onCopyComplete={() => setShowEquivalentsSync(false)}
        />
      )}
    </div>
  )
}
