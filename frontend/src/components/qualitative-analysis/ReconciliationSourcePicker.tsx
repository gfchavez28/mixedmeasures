import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { conversationsApi, documentsApi, observationsApi } from '@/lib/api'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  selectableObservations, type ReconciliationSource,
} from '@/lib/reconciliation-source'

export type { ReconciliationSource }

const ALL = '__all__'

interface Props {
  projectId: number
  value: ReconciliationSource | null
  onChange: (source: ReconciliationSource | null) => void
}

/**
 * The reconciliation grid's source narrowing.
 *
 * Deliberately NOT `SourceSelector`: that is a four-kind multi-select checkbox
 * tree with six other consumers, and this needs a single optional source
 * ("All sources" plus one). Bending it into single-select would mean either
 * faking one selection across four Sets or adding a mode flag to a shared
 * component — more coupling than a small dedicated control.
 *
 * Text columns are omitted on purpose: dataset-value units have no workbench to
 * jump to, so narrowing to one is of little use here. Add them if that changes.
 */
export default function ReconciliationSourcePicker({ projectId, value, onChange }: Props) {
  // `conversationsApi.list` returns a paged envelope, not a bare array.
  const { data: conversationData } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => conversationsApi.list(projectId),
    enabled: !!projectId,
  })
  const conversations = conversationData?.conversations ?? []
  const { data: documents = [] } = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => documentsApi.list(projectId),
    enabled: !!projectId,
  })
  const { data: observations = [] } = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
    enabled: !!projectId,
  })

  const frozenObservations = useMemo(() => selectableObservations(observations), [observations])

  const selected = value ? `${value.type}:${value.id}` : ALL

  return (
    <Select
      value={selected}
      onValueChange={(v) => {
        if (v === ALL) return onChange(null)
        const [type, id] = v.split(':')
        onChange({ type: type as ReconciliationSource['type'], id: Number(id) })
      }}
    >
      <SelectTrigger className="w-[220px] h-8 text-xs" aria-label="Narrow reconciliation to one source">
        <SelectValue placeholder="All sources" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All sources</SelectItem>
        {conversations.length > 0 && (
          <SelectGroup>
            <SelectLabel>Conversations</SelectLabel>
            {conversations.map(c => (
              <SelectItem key={`conversation:${c.id}`} value={`conversation:${c.id}`}>{c.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
        {documents.length > 0 && (
          <SelectGroup>
            <SelectLabel>Documents</SelectLabel>
            {documents.map(d => (
              <SelectItem key={`document:${d.id}`} value={`document:${d.id}`}>{d.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
        {frozenObservations.length > 0 && (
          <SelectGroup>
            <SelectLabel>Observations (frozen clips)</SelectLabel>
            {frozenObservations.map(o => (
              <SelectItem key={`observation:${o.id}`} value={`observation:${o.id}`}>{o.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}
