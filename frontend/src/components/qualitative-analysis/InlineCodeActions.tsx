import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Plus, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import CodeChip from './CodeChip'
import { codingApi, textCodingApi, codesApi, type Code } from '@/lib/api'
import { getCodeColor } from '@/lib/utils'

interface InlineCodeActionsProps {
  projectId: number
  itemType: 'segment' | 'text'
  itemId: number
  appliedCodeIds: number[]
  codeMap: Map<number, Code>
  allCodes: Code[]
  onCodeChange: () => void
  excludeCodeId?: number
  onFocusCode?: (codeId: number) => void
}

export default function InlineCodeActions({
  projectId,
  itemType,
  itemId,
  appliedCodeIds,
  codeMap,
  allCodes,
  onCodeChange,
  excludeCodeId,
  onFocusCode,
}: InlineCodeActionsProps) {
  const queryClient = useQueryClient()
  const [addCodeOpen, setAddCodeOpen] = useState(false)
  const [codeSearch, setCodeSearch] = useState('')

  const removeCodeMutation = useMutation({
    mutationFn: (codeId: number) => {
      if (itemType === 'segment') {
        return codingApi.removeCode(itemId, codeId)
      }
      return textCodingApi.removeCode(projectId, { dataset_value_id: itemId, code_id: codeId })
    },
    onSuccess: (_data, codeId) => {
      onCodeChange()
      toast('Code removed', {
        action: {
          label: 'Undo',
          onClick: () => {
            if (itemType === 'segment') {
              codingApi.applyCode(itemId, codeId).then(() => onCodeChange())
            } else {
              textCodingApi.applyCode(projectId, { dataset_value_id: itemId, code_id: codeId }).then(() => onCodeChange())
            }
          },
        },
      })
    },
    onError: () => { toast.error('Failed to remove code') },
  })

  const addCodeMutation = useMutation({
    mutationFn: (codeId: number) => {
      if (itemType === 'segment') {
        return codingApi.applyCode(itemId, codeId)
      }
      return textCodingApi.applyCode(projectId, { dataset_value_id: itemId, code_id: codeId })
    },
    onSuccess: () => {
      setAddCodeOpen(false)
      setCodeSearch('')
      onCodeChange()
      toast('Code applied')
    },
    onError: () => { toast.error('Failed to apply code') },
  })

  const createAndApplyMutation = useMutation({
    mutationFn: async (name: string) => {
      const newCode = await codesApi.create(projectId, { name })
      if (itemType === 'segment') {
        await codingApi.applyCode(itemId, newCode.id)
      } else {
        await textCodingApi.applyCode(projectId, { dataset_value_id: itemId, code_id: newCode.id })
      }
      return newCode
    },
    onSuccess: (newCode) => {
      setAddCodeOpen(false)
      setCodeSearch('')
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      onCodeChange()
      toast(`Created and applied "${newCode.name}"`)
    },
    onError: () => { toast.error('Failed to create and apply code') },
  })

  const appliedSet = new Set(appliedCodeIds)
  const searchTrimmed = codeSearch.trim()
  const searchLower = searchTrimmed.toLowerCase()
  const filteredCodes = allCodes.filter(c =>
    c.is_active && c.name.toLowerCase().includes(searchLower)
  )
  const exactMatch = searchTrimmed.length > 0 && allCodes.some(c =>
    c.is_active && c.name.toLowerCase() === searchLower
  )

  const visibleCodeIds = excludeCodeId
    ? appliedCodeIds.filter(cid => cid !== excludeCodeId)
    : appliedCodeIds

  return (
    <div className="group/actions flex flex-wrap items-center gap-1">
      {visibleCodeIds.map(cid => {
        const c = codeMap.get(cid)
        if (!c) return null
        return (
          <span key={cid} className="group/chip relative inline-flex">
            <CodeChip code={c} size="xs" onClick={onFocusCode} />
            <button
              className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-mm-surface border border-mm-border-subtle flex items-center justify-center opacity-0 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity hover:bg-red-100 dark:hover:bg-red-900/30"
              onClick={e => { e.stopPropagation(); removeCodeMutation.mutate(cid) }}
              title={`Remove ${c.name}`}
              aria-label={`Remove code ${c.name}`}
            >
              <X className="w-2.5 h-2.5 text-mm-text-muted" />
            </button>
          </span>
        )
      })}
      <Popover open={addCodeOpen} onOpenChange={v => { setAddCodeOpen(v); if (!v) setCodeSearch('') }}>
        <PopoverTrigger asChild>
          <button
            className="w-5 h-5 rounded-full border border-dashed border-mm-border-subtle flex items-center justify-center opacity-0 group-hover/actions:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity hover:border-mm-accent hover:text-mm-accent"
            title="Add code"
            aria-label="Add code"
          >
            <Plus className="w-3 h-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <Input
            value={codeSearch}
            onChange={e => setCodeSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && searchTrimmed && !exactMatch) {
                e.preventDefault()
                createAndApplyMutation.mutate(searchTrimmed)
              }
            }}
            placeholder="Search or create code…"
            className="h-7 text-xs mb-1"
            autoFocus
          />
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {filteredCodes.map(c => {
              const applied = appliedSet.has(c.id)
              return (
                <button
                  key={c.id}
                  className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left hover:bg-mm-surface-hover ${applied ? 'opacity-50 cursor-default' : ''}`}
                  onClick={() => { if (!applied) addCodeMutation.mutate(c.id) }}
                  disabled={applied}
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getCodeColor(c) }} />
                  <span className="truncate flex-1">{c.name}</span>
                  {applied && <Check className="w-3 h-3 text-mm-text-muted flex-shrink-0" />}
                </button>
              )
            })}
            {searchTrimmed && !exactMatch && (
              <button
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left hover:bg-mm-surface-hover text-mm-accent font-medium"
                onClick={() => createAndApplyMutation.mutate(searchTrimmed)}
                disabled={createAndApplyMutation.isPending}
              >
                <Plus className="w-3 h-3 flex-shrink-0" />
                <span className="truncate flex-1">Create &ldquo;{searchTrimmed}&rdquo;</span>
              </button>
            )}
            {filteredCodes.length === 0 && !searchTrimmed && (
              <p className="text-xs text-mm-text-muted py-2 text-center">No codes found</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
