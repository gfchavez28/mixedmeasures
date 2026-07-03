import {
  Folder, MessageSquare, Tag, Tags, TrendingUp, Database,
  TableProperties, Columns3, Layers,
} from 'lucide-react'

export type FilterType = 'all' | 'project' | 'conversation' | 'code' | 'code_category' | 'analysis' | 'dataset' | 'canvas'

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  project: 'Project',
  conversation: 'Conversation',
  code: 'Code',
  code_category: 'Category',
  analysis: 'Analysis',
  dataset: 'Dataset',
  dataset_row: 'Row',
  dataset_column: 'Column',
  canvas: 'Canvas',
}

export const ENTITY_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  project: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300' },
  code: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  conversation: { bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-700 dark:text-teal-300' },
  document: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-300' },
  // eslint-disable-next-line no-restricted-syntax -- categorical entity-color map hue (DESIGN.md §5 carve-out; siblings raw, not the mm-blue "selected" token)
  code_category: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300' },
  analysis: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300' },
  dataset: { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-300' },
  dataset_row: { bg: 'bg-cyan-100 dark:bg-cyan-900/30', text: 'text-cyan-700 dark:text-cyan-300' },
  dataset_column: { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-300' },
  canvas: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300' },
}

export const ENTITY_TYPE_ICONS: Record<string, React.ElementType> = {
  project: Folder,
  conversation: MessageSquare,
  code: Tag,
  code_category: Tags,
  analysis: TrendingUp,
  dataset: Database,
  dataset_row: TableProperties,
  dataset_column: Columns3,
  canvas: Layers,
}

export const ENTITY_TYPE_HEX: Record<string, string> = {
  project: '#9333ea',
  conversation: '#0d9488',
  code: '#059669',
  code_category: '#2563eb',
  analysis: '#ea580c',
  dataset: '#0284c7',
  dataset_row: '#06b6d4',
  dataset_column: '#0284c7',
  canvas: '#d97706',
}

export function entityTypeHexColor(type: string): string {
  return ENTITY_TYPE_HEX[type] ?? '#6b7280'
}

export const FILTER_CHIPS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'conversation', label: 'Conversations' },
  { value: 'code', label: 'Codes' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'dataset', label: 'Datasets' },
  { value: 'canvas', label: 'Canvas' },
]

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}
