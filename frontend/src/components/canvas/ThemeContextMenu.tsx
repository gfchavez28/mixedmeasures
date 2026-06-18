import {
  Pencil,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ArrowRightLeft,
  Focus,
  Trash2,
  Palette,
} from 'lucide-react'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import type { CanvasTheme } from '@/lib/api'

interface ThemeContextMenuProps {
  theme: CanvasTheme
  isFirst: boolean
  isLast: boolean
  isCollapsed?: boolean
  isTheme: boolean
  isFocused?: boolean
  showColorBars?: boolean
  onRename?: () => void
  onColorChange?: (color: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onConvert: () => void
  onToggleCollapse?: () => void
  onFocus?: () => void
  onDelete: () => void
}

export default function ThemeContextMenu({
  theme,
  isFirst,
  isLast,
  isCollapsed,
  isTheme,
  isFocused,
  showColorBars,
  onRename,
  onColorChange,
  onMoveUp,
  onMoveDown,
  onConvert,
  onToggleCollapse,
  onFocus,
  onDelete,
}: ThemeContextMenuProps) {
  return (
    <ContextMenuContent>
      {onRename && (
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="w-4 h-4 mr-2" />
          Rename
        </ContextMenuItem>
      )}

      {onColorChange && isTheme && showColorBars && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Palette className="w-4 h-4 mr-2" />
            Change Color
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="p-2">
            <ColorSwatchPicker
              value={theme.color ?? '#6366f1'}
              onChange={onColorChange}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onMoveUp} disabled={isFirst}>
        <ChevronUp className="w-4 h-4 mr-2" />
        Move Up
      </ContextMenuItem>
      <ContextMenuItem onSelect={onMoveDown} disabled={isLast}>
        <ChevronDown className="w-4 h-4 mr-2" />
        Move Down
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onConvert}>
        <ArrowRightLeft className="w-4 h-4 mr-2" />
        {isTheme ? 'Convert to Section' : 'Convert to Theme'}
      </ContextMenuItem>

      {onToggleCollapse && (
        <ContextMenuItem onSelect={onToggleCollapse}>
          <ChevronRight className="w-4 h-4 mr-2" />
          {isCollapsed ? 'Expand' : 'Collapse'}
        </ContextMenuItem>
      )}

      {onFocus && isTheme && !isFocused && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onFocus}>
            <Focus className="w-4 h-4 mr-2" />
            Focus on This Theme
          </ContextMenuItem>
        </>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onDelete} className="text-red-600 dark:text-red-400">
        <Trash2 className="w-4 h-4 mr-2" />
        Delete {isTheme ? 'Theme' : 'Section'}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
