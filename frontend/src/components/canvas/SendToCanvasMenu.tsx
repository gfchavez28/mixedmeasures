import { useQuery } from '@tanstack/react-query'
import { Plus, Layers } from 'lucide-react'
import {
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { canvasApi } from '@/lib/api'

interface SendToCanvasMenuProps {
  projectId: number
  onSend: (canvasId: number, canvasName: string) => void
  onSendNew: (canvasName: string) => void
}

export default function SendToCanvasMenu({ projectId, onSend, onSendNew }: SendToCanvasMenuProps) {
  const { data: canvases = [] } = useQuery({
    queryKey: ['canvases', projectId],
    queryFn: () => canvasApi.list(projectId),
    staleTime: 30000,
  })

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Layers className="w-3 h-3 mr-2" /> Send to Canvas
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-48">
        {canvases.map(c => (
          <ContextMenuItem key={c.id} onClick={() => onSend(c.id, c.name)}>
            {c.name}
          </ContextMenuItem>
        ))}
        {canvases.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem onClick={() => onSendNew('Untitled canvas')}>
          <Plus className="w-3 h-3 mr-2" /> New canvas...
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
