/**
 * Slash command definitions shared by ThemeEditor, SlashCommandList, and WritingCanvas.
 */
import type { ReactNode } from 'react'
import {
  Type,
  Hash,
  MessageSquare,
  BarChart3,
  FileText,
  Minus,
  AlertCircle,
  PilcrowLeft,
  ImageIcon,
} from 'lucide-react'

export type SlashCommand = {
  type: 'text' | 'heading' | 'section' | 'excerpt' | 'chart' | 'memo' | 'divider' | 'callout' | 'image'
  label: string
  description: string
  icon: ReactNode
}

export const COMMANDS: SlashCommand[] = [
  { type: 'text',    label: 'Text',        description: 'Plain paragraph',       icon: <Type className="w-4 h-4" /> },
  { type: 'heading', label: 'New theme',   description: 'Theme with materials',   icon: <Hash className="w-4 h-4" /> },
  { type: 'section', label: 'New section', description: 'Prose section',         icon: <PilcrowLeft className="w-4 h-4" /> },
  { type: 'excerpt', label: 'Excerpt',     description: 'Quote from data',       icon: <MessageSquare className="w-4 h-4" /> },
  { type: 'chart',   label: 'Chart',       description: 'Data visualization',    icon: <BarChart3 className="w-4 h-4" /> },
  { type: 'memo',    label: 'Memo',        description: 'Analytical reflection',  icon: <FileText className="w-4 h-4" /> },
  { type: 'divider', label: 'Divider',     description: 'Horizontal rule',       icon: <Minus className="w-4 h-4" /> },
  { type: 'callout', label: 'Callout stat', description: 'Highlight number',     icon: <AlertCircle className="w-4 h-4" /> },
  { type: 'image',   label: 'Image',        description: 'Upload an image',       icon: <ImageIcon className="w-4 h-4" /> },
]
