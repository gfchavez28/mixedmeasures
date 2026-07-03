import { useState, useEffect, useRef, useMemo, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  X,
  Search,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Check,
  Plus,
  ArrowUp,
  ArrowDown,
  Power,
  PowerOff,
  GripVertical,
  ExternalLink,
} from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { toast } from 'sonner'
import { type Code, type CodeCategory, codesApi, categoriesApi, projectsApi } from '@/lib/api'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import FreezeCodebookButton from '@/components/codebook/FreezeCodebookButton'
import CodebookFrozenWarningDialog from '@/components/codebook/CodebookFrozenWarningDialog'
import { useFreezeGuard } from '@/hooks/useFreezeGuard'
import { getCodeColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { CATEGORY_COLORS, ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { ColorDotButton } from '@/components/ColorDotButton'

// ---- DnD helper components ----

/** Droppable zone for empty categories so they can receive dragged codes */
function EmptyCategoryDropZone({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`px-3 py-2 text-xs text-mm-text-muted italic transition-colors ${
        isOver ? 'bg-mm-blue/12 text-mm-blue-text' : ''
      }`}
    >
      {isOver ? 'Drop here' : 'Drop codes here or use arrows'}
    </div>
  )
}

/** Sortable code row — handles drag transform, insertion indicator, and drag handle */
function SortableCodeRow({
  code,
  disabled,
  activeId,
  overId,
  children,
}: {
  code: Code
  disabled: boolean
  activeId: UniqueIdentifier | null
  overId: UniqueIdentifier | null
  children: (dragHandleProps: Record<string, unknown>) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: code.id, disabled })

  // Show insertion line when this item is the drop target
  const showInsertLine = !isDragging && overId === code.id && activeId !== code.id

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
        transition,
        opacity: isDragging ? 0 : 1,
        position: 'relative',
      }}
    >
      {showInsertLine && (
        <div className="absolute top-0 left-3 right-3 h-0.5 bg-mm-blue rounded-full z-10 -translate-y-1/2" />
      )}
      {children({
        ref: setActivatorNodeRef,
        ...attributes,
        ...listeners,
        style: { touchAction: 'none' },
      })}
    </div>
  )
}

interface CodebookSlideOutProps {
  projectId: number
  onClose: () => void
  zIndex?: number
}

const CB_MIN_WIDTH = 280
const CB_MAX_WIDTH = 600
const CB_DEFAULT_WIDTH = 380
const CB_STORAGE_KEY = 'mm-codebook-width'

function loadCbWidth(): number {
  try {
    const v = localStorage.getItem(CB_STORAGE_KEY)
    if (v) {
      const n = Number(v)
      if (n >= CB_MIN_WIDTH && n <= CB_MAX_WIDTH) return n
    }
  } catch { /* ignore */ }
  return CB_DEFAULT_WIDTH
}

export default function CodebookSlideOut({ projectId, onClose, zIndex }: CodebookSlideOutProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Slide-in animation state
  const [isVisible, setIsVisible] = useState(false)

  // Resizable width
  const [cbWidth, setCbWidth] = useState(loadCbWidth)
  const cbDragging = useRef(false)
  const cbStartX = useRef(0)
  const cbStartWidth = useRef(0)

  // Search/filter
  const [searchQuery, setSearchQuery] = useState('')

  // Collapsed categories
  const [collapsedCategories, setCollapsedCategories] = useState<Set<number>>(new Set())

  // Inline editing states
  const [editingCodeDesc, setEditingCodeDesc] = useState<number | null>(null)
  const [editingCodeDescValue, setEditingCodeDescValue] = useState('')
  const [editingCategoryName, setEditingCategoryName] = useState<number | null>(null)
  const [editingCategoryNameValue, setEditingCategoryNameValue] = useState('')

  // Create category form
  const [showCreateCategory, setShowCreateCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryColor, setNewCategoryColor] = useState(CATEGORY_COLORS[0])

  // Create code input
  const [newCodeName, setNewCodeName] = useState('')
  const [newCodeCategoryId, setNewCodeCategoryId] = useState<number | null>(null)

  // Color picker popover state (tracks which code or category has it open)
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null) // "code-{id}" or "cat-{id}"

  // Delete category confirmation
  const [deletingCategory, setDeletingCategory] = useState<CodeCategory | null>(null)

  // ---- Queries ----
  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId, 'all'],
    queryFn: () => codesApi.list(projectId, true),
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories', projectId],
    queryFn: () => categoriesApi.list(projectId),
  })

  // Track J · J3-1: warn before adding to a frozen codebook (soft lock). Shares the
  // ['project'] cache with ProjectLayout + the FreezeCodebookButton.
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
  })
  const { guard: guardCodebook, warnOpen, onProceed: onFreezeProceed, onCancel: onFreezeCancel } =
    useFreezeGuard(!!project?.codebook_frozen_at)

  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const categories = useMemo(() => categoriesData?.categories ?? [], [categoriesData?.categories])

  // ---- aria-live announcements for reorder actions ----
  const [liveAnnouncement, setLiveAnnouncement] = useState('')

  // ---- Mutations ----
  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
    invalidateDerivedCounts(queryClient, projectId, { metrics: true })  // #450: cross-surface counts
  }, [queryClient, projectId])

  const updateCodeMut = useMutation({
    mutationFn: ({ codeId, data }: { codeId: number; data: Partial<Code> }) =>
      codesApi.update(projectId, codeId, data),
    onSuccess: invalidateAll,
  })

  const createCodeMut = useMutation({
    mutationFn: (data: { name: string; description?: string; color?: string; category_id?: number }) =>
      codesApi.create(projectId, data),
    onSuccess: invalidateAll,
  })

  const reorderCodesMut = useMutation({
    mutationFn: ({ categoryId, orderedCodeIds }: { categoryId: number | null; orderedCodeIds: number[] }) =>
      codesApi.reorderInCategory(projectId, categoryId, orderedCodeIds),
    onSuccess: invalidateAll,
  })

  const createCategoryMut = useMutation({
    mutationFn: (data: { name: string; color?: string }) =>
      categoriesApi.create(projectId, data),
    onSuccess: invalidateAll,
  })

  const updateCategoryMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; color?: string } }) =>
      categoriesApi.update(projectId, id, data),
    onSuccess: invalidateAll,
  })

  const deleteCategoryMut = useMutation({
    mutationFn: (id: number) => categoriesApi.delete(projectId, id),
    onSuccess: invalidateAll,
  })

  const reorderCategoriesMut = useMutation({
    mutationFn: (orderedIds: number[]) => categoriesApi.reorder(projectId, orderedIds),
    onSuccess: invalidateAll,
  })

  // ---- Slide-in animation ----
  useEffect(() => {
    // Trigger slide animation on next frame
    const frame = requestAnimationFrame(() => setIsVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // Focus trap: Tab wraps within panel, Escape closes, restore focus on unmount
  useFocusTrap(panelRef, onClose)

  // Auto-focus close button on mount
  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  // ---- Resize drag ----
  const handleResizeMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    cbDragging.current = true
    cbStartX.current = e.clientX
    cbStartWidth.current = cbWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [cbWidth])

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!cbDragging.current) return
      const delta = cbStartX.current - e.clientX
      const newWidth = Math.min(CB_MAX_WIDTH, Math.max(CB_MIN_WIDTH, cbStartWidth.current + delta))
      setCbWidth(newWidth)
    }
    function handleMouseUp() {
      if (!cbDragging.current) return
      cbDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      try { localStorage.setItem(CB_STORAGE_KEY, String(cbWidth)) } catch { /* ignore */ }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [cbWidth])

  // ---- Organize codes into sections ----
  const { universalCodes, categorizedGroups, uncategorizedCodes, codeCount, categoryCount } = useMemo(() => {
    const lowerQuery = searchQuery.trim().toLowerCase()
    let filtered = codes
    if (lowerQuery) {
      filtered = codes.filter(
        c =>
          c.name.toLowerCase().includes(lowerQuery) ||
          (c.description && c.description.toLowerCase().includes(lowerQuery)) ||
          (c.category_name && c.category_name.toLowerCase().includes(lowerQuery))
      )
    }

    const universal: Code[] = []
    const catGroups: { category: CodeCategory; codes: Code[] }[] = []
    const uncategorized: Code[] = []

    // Build category map from categories query (ordered by display_order)
    const catMap = new Map<number, CodeCategory>()
    for (const cat of categories) {
      catMap.set(cat.id, cat)
    }

    for (const code of filtered) {
      if (code.is_universal) {
        universal.push(code)
      } else if (code.category_id != null) {
        let group = catGroups.find(g => g.category.id === code.category_id)
        if (!group) {
          const cat = catMap.get(code.category_id!)
          if (cat) {
            group = { category: cat, codes: [] }
            catGroups.push(group)
          } else {
            uncategorized.push(code)
            continue
          }
        }
        group!.codes.push(code)
      } else {
        uncategorized.push(code)
      }
    }

    // Sort category groups by display_order
    catGroups.sort((a, b) => a.category.display_order - b.category.display_order)

    // Include empty categories (not matching search) so they are visible for management
    if (!lowerQuery) {
      for (const cat of categories) {
        if (!catGroups.find(g => g.category.id === cat.id)) {
          catGroups.push({ category: cat, codes: [] })
        }
      }
      catGroups.sort((a, b) => a.category.display_order - b.category.display_order)
    }

    return {
      universalCodes: universal,
      categorizedGroups: catGroups,
      uncategorizedCodes: uncategorized,
      codeCount: codes.length,
      categoryCount: categories.length,
    }
  }, [codes, categories, searchQuery])

  // ---- Toggle category collapse ----
  const toggleCategory = useCallback((catId: number) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }, [])

  // ---- Derive nested structure for rendering ----
  const { rootGroups, childGroupsByParent } = useMemo(() => {
    const roots: typeof categorizedGroups = []
    const childMap = new Map<number, typeof categorizedGroups>()
    for (const group of categorizedGroups) {
      const parentId = group.category.parent_id
      if (parentId != null) {
        const list = childMap.get(parentId) || []
        list.push(group)
        childMap.set(parentId, list)
      } else {
        roots.push(group)
      }
    }
    return { rootGroups: roots, childGroupsByParent: childMap }
  }, [categorizedGroups])

  // ---- Parent name lookup for breadcrumb ----
  const parentNameMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const cat of categories) {
      if (cat.parent_id != null) {
        const parent = categories.find(c => c.id === cat.parent_id)
        if (parent) map.set(cat.id, parent.name)
      }
    }
    return map
  }, [categories])

  // ---- Build flat section list for cross-category navigation ----
  // Each section: { categoryId, codes } — ordered top to bottom as rendered
  const allSections = useMemo(() => {
    const sections: { categoryId: number | null; codes: Code[] }[] = []
    for (const group of categorizedGroups) {
      sections.push({ categoryId: group.category.id, codes: group.codes })
    }
    if (uncategorizedCodes.length > 0) {
      sections.push({ categoryId: null, codes: uncategorizedCodes })
    }
    return sections
  }, [categorizedGroups, uncategorizedCodes])

  // ---- Helper: find category name by ID ----
  const getCategoryName = useCallback((categoryId: number | null): string => {
    if (categoryId == null) return 'Uncategorized'
    const cat = categories.find(c => c.id === categoryId)
    return cat?.name ?? 'Unknown'
  }, [categories])

  // ---- Move code up/down, crossing category boundaries ----
  const moveCode = useCallback(
    (code: Code, direction: 'up' | 'down') => {
      // Find which section the code is in
      const sectionIdx = allSections.findIndex(s => s.codes.some(c => c.id === code.id))
      if (sectionIdx < 0) return
      const section = allSections[sectionIdx]
      const codeIdx = section.codes.findIndex(c => c.id === code.id)

      if (direction === 'up') {
        if (codeIdx > 0) {
          // Swap within same section
          const reordered = [...section.codes]
          const temp = reordered[codeIdx - 1]
          reordered[codeIdx - 1] = reordered[codeIdx]
          reordered[codeIdx] = temp
          reorderCodesMut.mutate({
            categoryId: section.categoryId,
            orderedCodeIds: reordered.map(c => c.id),
          })
          setLiveAnnouncement(`Moved ${code.name} up`)
        } else if (sectionIdx > 0) {
          // Move to the end of the previous section
          const prevSection = allSections[sectionIdx - 1]
          const targetCategoryId = prevSection.categoryId
          const targetName = getCategoryName(targetCategoryId)
          codesApi.update(projectId, code.id, { category_id: targetCategoryId }).then(() => {
            const newOrder = [...prevSection.codes.map(c => c.id), code.id]
            return codesApi.reorderInCategory(projectId, targetCategoryId, newOrder)
          }).then(() => {
            invalidateAll()
            toast.success(`Moved "${code.name}" to ${targetName}`)
            setLiveAnnouncement(`Moved ${code.name} to ${targetName}`)
          }).catch(() => {
            toast.error(`Failed to move "${code.name}"`)
            invalidateAll()
          })
        }
      } else {
        if (codeIdx < section.codes.length - 1) {
          // Swap within same section
          const reordered = [...section.codes]
          const temp = reordered[codeIdx + 1]
          reordered[codeIdx + 1] = reordered[codeIdx]
          reordered[codeIdx] = temp
          reorderCodesMut.mutate({
            categoryId: section.categoryId,
            orderedCodeIds: reordered.map(c => c.id),
          })
          setLiveAnnouncement(`Moved ${code.name} down`)
        } else if (sectionIdx < allSections.length - 1) {
          // Move to the start of the next section
          const nextSection = allSections[sectionIdx + 1]
          const targetCategoryId = nextSection.categoryId
          const targetName = getCategoryName(targetCategoryId)
          codesApi.update(projectId, code.id, { category_id: targetCategoryId }).then(() => {
            const newOrder = [code.id, ...nextSection.codes.map(c => c.id)]
            return codesApi.reorderInCategory(projectId, targetCategoryId, newOrder)
          }).then(() => {
            invalidateAll()
            toast.success(`Moved "${code.name}" to ${targetName}`)
            setLiveAnnouncement(`Moved ${code.name} to ${targetName}`)
          }).catch(() => {
            toast.error(`Failed to move "${code.name}"`)
            invalidateAll()
          })
        }
      }
    },
    [allSections, projectId, reorderCodesMut, invalidateAll, getCategoryName]
  )

  // ---- Move category up/down ----
  const moveCategory = useCallback(
    (catId: number, direction: 'up' | 'down') => {
      const ordered = categorizedGroups.map(g => g.category.id)
      const idx = ordered.indexOf(catId)
      if (idx < 0) return
      if (direction === 'up' && idx === 0) return
      if (direction === 'down' && idx === ordered.length - 1) return

      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      const temp = ordered[swapIdx]
      ordered[swapIdx] = ordered[idx]
      ordered[idx] = temp

      reorderCategoriesMut.mutate(ordered)
    },
    [categorizedGroups, reorderCategoriesMut]
  )

  // ---- Save code description inline ----
  const saveCodeDescription = useCallback(
    (codeId: number) => {
      updateCodeMut.mutate({ codeId, data: { description: editingCodeDescValue || null } })
      setEditingCodeDesc(null)
    },
    [editingCodeDescValue, updateCodeMut]
  )

  // ---- Save category name inline ----
  const saveCategoryName = useCallback(
    (catId: number) => {
      const trimmed = editingCategoryNameValue.trim()
      if (trimmed) {
        updateCategoryMut.mutate({ id: catId, data: { name: trimmed } })
      }
      setEditingCategoryName(null)
    },
    [editingCategoryNameValue, updateCategoryMut]
  )

  // ---- DnD: sortable codes within and between categories ----
  const [dragActiveCode, setDragActiveCode] = useState<Code | null>(null)
  const [dndOverId, setDndOverId] = useState<UniqueIdentifier | null>(null)
  const dndOverIdRef = useRef<UniqueIdentifier | null>(null)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Track which container (category) each code belongs to during drag
  // Container IDs: "cat-{id}" for categories, "uncategorized" for uncategorized
  const findContainerForCode = useCallback((codeId: UniqueIdentifier): string | null => {
    for (const group of categorizedGroups) {
      if (group.codes.some(c => c.id === codeId)) return `cat-${group.category.id}`
    }
    if (uncategorizedCodes.some(c => c.id === codeId)) return 'uncategorized'
    return null
  }, [categorizedGroups, uncategorizedCodes])

  const parseContainerId = (id: string): number | null => {
    if (id === 'uncategorized') return null
    if (id.startsWith('cat-')) return parseInt(id.replace('cat-', ''), 10)
    return null // shouldn't happen
  }

  const getContainerCodes = useCallback((containerId: string): Code[] => {
    if (containerId === 'uncategorized') return uncategorizedCodes
    const catId = parseInt(containerId.replace('cat-', ''), 10)
    const group = categorizedGroups.find(g => g.category.id === catId)
    return group?.codes ?? []
  }, [categorizedGroups, uncategorizedCodes])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const code = codes.find(c => c.id === event.active.id)
    if (code) setDragActiveCode(code)
  }, [codes])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const newId = event.over?.id ?? null
    if (dndOverIdRef.current !== newId) {
      dndOverIdRef.current = newId
      setDndOverId(newId)
    }
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDragActiveCode(null)
    setDndOverId(null)
    dndOverIdRef.current = null
    const { active, over } = event
    if (!over) return

    const activeCode = codes.find(c => c.id === active.id)
    if (!activeCode || activeCode.is_universal) return

    const activeContainer = findContainerForCode(active.id)
    if (!activeContainer) return

    // Determine target: could be a code ID (number) or a container ID (string, for empty zones)
    let overContainer: string | null = null
    let overCodeId: number | null = null

    if (typeof over.id === 'string' && (over.id.startsWith('cat-') || over.id === 'uncategorized')) {
      // Dropped on an empty container zone
      overContainer = over.id
    } else {
      // Dropped on another code — find its container
      overContainer = findContainerForCode(over.id)
      overCodeId = over.id as number
    }

    if (!overContainer) return

    const targetCategoryId = parseContainerId(overContainer)
    const sourceCategoryId = parseContainerId(activeContainer)

    if (activeContainer === overContainer) {
      // Reorder within the same container
      const containerCodes = getContainerCodes(activeContainer)
      const oldIndex = containerCodes.findIndex(c => c.id === active.id)
      const newIndex = overCodeId != null
        ? containerCodes.findIndex(c => c.id === overCodeId)
        : containerCodes.length - 1

      if (oldIndex !== newIndex && oldIndex >= 0 && newIndex >= 0) {
        const reordered = arrayMove(containerCodes.map(c => c.id), oldIndex, newIndex)
        reorderCodesMut.mutate({ categoryId: sourceCategoryId, orderedCodeIds: reordered })
        setLiveAnnouncement(`Reordered ${activeCode.name} in ${getCategoryName(sourceCategoryId)}`)
      }
    } else {
      // Move to a different container at a specific position
      const targetCodes = getContainerCodes(overContainer)
      const insertIndex = overCodeId != null
        ? targetCodes.findIndex(c => c.id === overCodeId)
        : targetCodes.length

      // Build the new order for the target container
      const newOrder = [...targetCodes.map(c => c.id)]
      if (insertIndex >= 0 && insertIndex < newOrder.length) {
        newOrder.splice(insertIndex, 0, activeCode.id)
      } else {
        newOrder.push(activeCode.id)
      }

      const targetName = getCategoryName(targetCategoryId)
      codesApi.update(projectId, activeCode.id, { category_id: targetCategoryId }).then(() => {
        return codesApi.reorderInCategory(projectId, targetCategoryId, newOrder)
      }).then(() => {
        invalidateAll()
        toast.success(`Moved "${activeCode.name}" to ${targetName}`)
        setLiveAnnouncement(`Moved ${activeCode.name} to ${targetName}`)
      }).catch(() => {
        toast.error(`Failed to move "${activeCode.name}"`)
        invalidateAll()
      })
    }
  }, [codes, findContainerForCode, getContainerCodes, getCategoryName, projectId, reorderCodesMut, invalidateAll])

  // ---- Toggle code active ----
  const toggleCodeActive = useCallback(
    (code: Code) => {
      updateCodeMut.mutate({ codeId: code.id, data: { is_active: !code.is_active } })
    },
    [updateCodeMut]
  )

  // ---- Create code ----
  const handleCreateCode = useCallback(() => {
    const trimmed = newCodeName.trim()
    if (!trimmed) return
    guardCodebook(() => {
      createCodeMut.mutate({
        name: trimmed,
        ...(newCodeCategoryId != null ? { category_id: newCodeCategoryId } : {}),
      })
      setNewCodeName('')
      setNewCodeCategoryId(null)
    })
  }, [newCodeName, newCodeCategoryId, createCodeMut, guardCodebook])

  // ---- Create category ----
  const handleCreateCategory = useCallback(() => {
    const trimmed = newCategoryName.trim()
    if (!trimmed) return
    guardCodebook(() => {
      createCategoryMut.mutate({ name: trimmed, color: newCategoryColor })
      setNewCategoryName('')
      setNewCategoryColor(CATEGORY_COLORS[0])
      setShowCreateCategory(false)
    })
  }, [newCategoryName, newCategoryColor, createCategoryMut, guardCodebook])

  // ---- Delete category ----
  const handleDeleteCategory = useCallback(() => {
    if (!deletingCategory) return
    deleteCategoryMut.mutate(deletingCategory.id)
    setDeletingCategory(null)
  }, [deletingCategory, deleteCategoryMut])

  // ---- Pre-compute global first/last code IDs ----
  const { globalFirstId, globalLastId } = useMemo(() => {
    let firstId: number | null = null
    let lastId: number | null = null
    for (const section of allSections) {
      if (section.codes.length > 0) {
        if (firstId === null) firstId = section.codes[0].id
        lastId = section.codes[section.codes.length - 1].id
      }
    }
    return { globalFirstId: firstId, globalLastId: lastId }
  }, [allSections])

  // ---- Render a code row ----
  function renderCodeRow(code: Code, isUniversal: boolean) {
    const isEditingDesc = editingCodeDesc === code.id

    return (
      <SortableCodeRow
        key={code.id}
        code={code}
        disabled={isUniversal}
        activeId={dragActiveCode?.id ?? null}
        overId={dndOverId}
      >
        {(dragHandleProps) => (
      <div
        className={`flex items-start gap-2 px-3 py-2 border-b border-mm-border-subtle last:border-b-0 ${
          !code.is_active ? 'opacity-50' : ''
        }`}
      >
        {/* Drag handle */}
        {!isUniversal && (
          <button
            {...dragHandleProps}
            className="mt-0.5 flex-shrink-0 cursor-grab text-mm-text-faint hover:text-mm-text-muted active:cursor-grabbing p-0.5 -m-0.5 rounded"
            aria-label={`Drag ${code.name} to reorder`}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        )}
        {/* Color dot (clickable → color picker popover) */}
        <Popover
          open={colorPickerOpen === `code-${code.id}`}
          onOpenChange={(open) => setColorPickerOpen(open ? `code-${code.id}` : null)}
        >
          <PopoverTrigger asChild>
            <ColorDotButton
              className="mt-0.5"
              color={getCodeColor(code)}
              aria-label={`Change color for ${code.name}`}
              title="Change code color"
            />
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3 z-[200]" align="start" side="left" collisionPadding={16}>
            <div className="space-y-2">
              <p className="text-xs font-medium text-mm-text-secondary">Code Color</p>
              <ColorSwatchPicker
                value={code.color || ''}
                onChange={(color) => {
                  updateCodeMut.mutate({ codeId: code.id, data: { color } })
                  setColorPickerOpen(null)
                }}
              />
              {code.color && (
                <button
                  className="text-xs text-mm-text-muted hover:text-mm-text mt-1"
                  onClick={() => {
                    updateCodeMut.mutate({ codeId: code.id, data: { color: null } })
                    setColorPickerOpen(null)
                  }}
                >
                  {code.category_id != null ? 'Clear (inherit from category)' : 'Clear custom color'}
                </button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Code info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-mm-text truncate">{code.name}</span>
            <span className="text-xs text-mm-text-muted tabular-nums flex-shrink-0">
              ({code.usage_count})
            </span>
          </div>

          {/* Description: inline editable */}
          {isEditingDesc ? (
            <div className="flex items-center gap-1 mt-1">
              <Input
                value={editingCodeDescValue}
                onChange={e => setEditingCodeDescValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveCodeDescription(code.id)
                  if (e.key === 'Escape') setEditingCodeDesc(null)
                }}
                className="h-6 text-xs"
                placeholder="Add description..."
                autoFocus
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={() => saveCodeDescription(code.id)}
                aria-label="Save description"
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={() => setEditingCodeDesc(null)}
                aria-label="Cancel editing"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <button
              className="text-xs text-mm-text-muted hover:text-mm-text mt-0.5 text-left w-full truncate"
              onClick={() => {
                setEditingCodeDesc(code.id)
                setEditingCodeDescValue(code.description || '')
              }}
              title={code.description || 'Click to add description'}
            >
              {code.description || 'No description'}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0 mt-0.5">
          {/* Active/Inactive toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => toggleCodeActive(code)}
            aria-label={code.is_active ? 'Deactivate code' : 'Activate code'}
            title={code.is_active ? 'Deactivate' : 'Activate'}
          >
            {code.is_active ? (
              <Power className="h-3 w-3 text-green-600" />
            ) : (
              <PowerOff className="h-3 w-3 text-mm-text-muted" />
            )}
          </Button>

          {/* Reorder (not for universal codes) */}
          {!isUniversal && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => moveCode(code, 'up')}
                disabled={code.id === globalFirstId}
                aria-label="Move up"
                title="Move up"
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => moveCode(code, 'down')}
                disabled={code.id === globalLastId}
                aria-label="Move down"
                title="Move down"
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>
        )}
      </SortableCodeRow>
    )
  }

  // ---- Render a category section ----
  function renderCategorySection(group: { category: CodeCategory; codes: Code[] }, catIdx: number, isChild = false) {
    const cat = group.category
    const isCollapsed = collapsedCategories.has(cat.id)
    const isEditingName = editingCategoryName === cat.id
    const isFirstCat = catIdx === 0
    const isLastCat = catIdx === (isChild ? -1 : rootGroups.length - 1) // disable move for children

    return (
      <div key={cat.id} className={`border-b border-mm-border-subtle ${isChild ? 'ml-4' : ''}`}>
        {/* Category header */}
        <div className="flex items-center gap-1.5 px-3 py-2 bg-mm-bg">
          {/* Collapse toggle */}
          <button
            className="flex-shrink-0 p-0.5 rounded hover:bg-mm-surface-hover"
            onClick={() => toggleCategory(cat.id)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} category ${cat.name}`}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-mm-text-muted" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-mm-text-muted" />
            )}
          </button>

          {/* Color swatch (clickable → color picker popover) */}
          <Popover
            open={colorPickerOpen === `cat-${cat.id}`}
            onOpenChange={(open) => setColorPickerOpen(open ? `cat-${cat.id}` : null)}
          >
            <PopoverTrigger asChild>
              <button
                className="w-5 h-5 rounded flex-shrink-0 ring-offset-1 hover:ring-2 hover:ring-mm-border-medium transition-shadow flex items-center justify-center"
                aria-label={`Change color for category ${cat.name}`}
                title="Change category color"
              >
                <span
                  className="w-3 h-3 rounded"
                  style={{ backgroundColor: cat.color || '#9ca3af' }}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3 z-[200]" align="start" side="left" collisionPadding={16}>
              <div className="space-y-2">
                <p className="text-xs font-medium text-mm-text-secondary">Category Color</p>
                <ColorSwatchPicker
                  value={cat.color || ''}
                  onChange={(color) => {
                    updateCategoryMut.mutate({ id: cat.id, data: { color } })
                    setColorPickerOpen(null)
                  }}
                />
              </div>
            </PopoverContent>
          </Popover>

          {/* Category name (inline editable) */}
          {isEditingName ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <Input
                value={editingCategoryNameValue}
                onChange={e => setEditingCategoryNameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveCategoryName(cat.id)
                  if (e.key === 'Escape') setEditingCategoryName(null)
                }}
                className="h-6 text-xs flex-1"
                autoFocus
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={() => saveCategoryName(cat.id)}
                aria-label="Save category name"
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={() => setEditingCategoryName(null)}
                aria-label="Cancel editing"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              {parentNameMap.has(cat.id) && (
                <span className="block text-[10px] text-mm-text-faint truncate">{parentNameMap.get(cat.id)} ›</span>
              )}
              <span className="text-xs font-semibold text-mm-text-secondary truncate block">
                {cat.name}
              </span>
            </div>
          )}

          {/* Code count */}
          <span className="text-xs text-mm-text-muted tabular-nums flex-shrink-0">
            {group.codes.length}
          </span>

          {/* Category actions */}
          {!isEditingName && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  setEditingCategoryName(cat.id)
                  setEditingCategoryNameValue(cat.name)
                }}
                aria-label={`Edit category ${cat.name}`}
                title="Rename category"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setDeletingCategory(cat)}
                aria-label={`Delete category ${cat.name}`}
                title="Delete category"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              {!isChild && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => moveCategory(cat.id, 'up')}
                    disabled={isFirstCat}
                    aria-label="Move category up"
                    title="Move category up"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => moveCategory(cat.id, 'down')}
                    disabled={isLastCat}
                    aria-label="Move category down"
                    title="Move category down"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Category codes (sortable zone) */}
        {!isCollapsed && (
          group.codes.length > 0 ? (
            <SortableContext items={group.codes.map(c => c.id)} strategy={verticalListSortingStrategy}>
              {group.codes.map(code => renderCodeRow(code, false))}
            </SortableContext>
          ) : (
            <EmptyCategoryDropZone id={`cat-${cat.id}`} />
          )
        )}
      </div>
    )
  }

  return (
    <>
      {/* Slide-out panel */}
      <div
        ref={panelRef}
        role="complementary"
        aria-label="Codebook"
        className="fixed top-0 right-0 h-screen flex flex-col bg-mm-surface border-l border-mm-border-subtle shadow-xl"
        style={{
          width: cbWidth,
          zIndex: zIndex ?? 50,
          transform: isVisible ? 'translateX(0)' : 'translateX(100%)',
          transitionProperty: 'transform',
          transitionDuration: '250ms',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Resize handle */}
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-mm-blue/30 active:bg-mm-blue/50 transition-colors z-10"
          onMouseDown={handleResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize codebook panel"
        />
        {/* ---- Header ---- */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mm-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-mm-text">Codebook</h2>
            <span className="text-xs text-mm-text-muted">
              {codeCount} code{codeCount !== 1 ? 's' : ''}
              {categoryCount > 0 && (
                <> &middot; {categoryCount} categor{categoryCount !== 1 ? 'ies' : 'y'}</>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <FreezeCodebookButton projectId={projectId} />
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
              aria-label="Close codebook"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <CodebookFrozenWarningDialog
          open={warnOpen}
          onProceed={onFreezeProceed}
          onCancel={onFreezeCancel}
        />

        {/* ---- Search ---- */}
        <div className="px-3 py-2 border-b border-mm-border-subtle flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-mm-text-muted" />
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filter codes..."
              className="h-8 pl-8 text-sm"
              aria-label="Filter codes"
            />
          </div>
        </div>

        {/* ---- Scrollable content ---- */}
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-y-auto">
          {/* Universal codes (pinned top, not reorderable) */}
          {universalCodes.length > 0 && (
            <div className="border-b border-mm-border-subtle">
              <div className="px-3 py-1.5 bg-emerald-50 dark:bg-emerald-950/30 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Universal Codes
              </div>
              <SortableContext items={universalCodes.map(c => c.id)} strategy={verticalListSortingStrategy}>
                {universalCodes.map(code => renderCodeRow(code, true))}
              </SortableContext>
            </div>
          )}

          {/* Categorized groups (nested) */}
          {rootGroups.map((group, idx) => (
            <div key={group.category.id}>
              {renderCategorySection(group, idx)}
              {childGroupsByParent.get(group.category.id)?.map((childGroup, childIdx) =>
                renderCategorySection(childGroup, childIdx, true)
              )}
            </div>
          ))}

          {/* Uncategorized codes (sortable zone) */}
          {uncategorizedCodes.length > 0 && (
            <div className="border-b border-mm-border-subtle">
              <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                {categorizedGroups.length > 0 ? 'Uncategorized' : 'Project Codes'}
              </div>
              <SortableContext items={uncategorizedCodes.map(c => c.id)} strategy={verticalListSortingStrategy}>
                {uncategorizedCodes.map(code => renderCodeRow(code, false))}
              </SortableContext>
            </div>
          )}

          {/* Uncategorized drop zone: shown when dragging and uncategorized section is empty */}
          {uncategorizedCodes.length === 0 && categorizedGroups.length > 0 && dragActiveCode && (
            <div className="border-b border-mm-border-subtle">
              <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                Uncategorized
              </div>
              <EmptyCategoryDropZone id="uncategorized" />
            </div>
          )}

          {/* Empty state */}
          {codes.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-mm-text-muted">
              No codes yet. Add your first code below.
            </div>
          )}

          {/* Filtered empty state */}
          {codes.length > 0 &&
            universalCodes.length === 0 &&
            categorizedGroups.every(g => g.codes.length === 0) &&
            uncategorizedCodes.length === 0 &&
            searchQuery.trim() && (
              <div className="px-4 py-8 text-center text-sm text-mm-text-muted">
                No codes matching "{searchQuery}"
              </div>
            )}
        </div>

        {/* Drag overlay — portaled to body to escape the codebook panel's transform containing block */}
        {createPortal(
          <DragOverlay dropAnimation={null} zIndex={9999}>
            {dragActiveCode && (
              <div className="flex items-center gap-2 bg-mm-surface border border-mm-border-subtle rounded-lg shadow-lg px-3 py-2">
                <GripVertical className="w-3 h-3 text-mm-text-faint" />
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getCodeColor(dragActiveCode) }}
                />
                <span className="text-sm font-medium text-mm-text">{dragActiveCode.name}</span>
              </div>
            )}
          </DragOverlay>,
          document.body
        )}
        </DndContext>

        {/* Screen reader announcements for reorder actions */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>

        {/* ---- Footer: New Code + New Category ---- */}
        <div className="border-t border-mm-border-subtle flex-shrink-0">
          {/* New code input */}
          <div className="px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <Plus className="h-3.5 w-3.5 text-mm-text-muted flex-shrink-0" />
              <Input
                value={newCodeName}
                onChange={e => setNewCodeName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateCode()
                }}
                placeholder="New code name..."
                className="h-7 text-sm flex-1"
                aria-label="New code name"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleCreateCode}
                disabled={!newCodeName.trim() || createCodeMut.isPending}
              >
                Add
              </Button>
            </div>
            {categories.length > 0 && (
              <div className="flex items-center gap-1.5 pl-[1.375rem]">
                <span className="text-xs text-mm-text-muted flex-shrink-0">in</span>
                <select
                  value={newCodeCategoryId ?? ''}
                  onChange={e => {
                    const val = e.target.value
                    setNewCodeCategoryId(val ? Number(val) : null)
                  }}
                  className="h-6 text-xs rounded border border-mm-border-subtle bg-mm-surface text-mm-text px-1.5 flex-1 min-w-0"
                  aria-label="Category for new code"
                >
                  <option value="">Uncategorized</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* New category */}
          {showCreateCategory ? (
            <div className="px-3 py-2 border-t border-mm-border-subtle space-y-2">
              <Input
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateCategory()
                  if (e.key === 'Escape') {
                    setShowCreateCategory(false)
                    setNewCategoryName('')
                  }
                }}
                placeholder="Category name..."
                className="h-7 text-sm"
                autoFocus
                aria-label="New category name"
              />
              <ColorSwatchPicker value={newCategoryColor} onChange={setNewCategoryColor} />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setShowCreateCategory(false)
                    setNewCategoryName('')
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleCreateCategory}
                  disabled={!newCategoryName.trim() || createCategoryMut.isPending}
                >
                  Create Category
                </Button>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 border-t border-mm-border-subtle">
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => setShowCreateCategory(true)}
              >
                <Plus className="h-3 w-3 mr-1" />
                New Category
              </Button>
            </div>
          )}
        </div>

        {/* Footer: Open full view link */}
        <div className="px-3 py-2 border-t border-mm-border-subtle flex-shrink-0 text-center">
          <button
            className="text-xs text-mm-text-muted hover:text-mm-text underline inline-flex items-center gap-1"
            onClick={() => { onClose(); navigate(`/projects/${projectId}/analysis/codebook`) }}
          >
            <ExternalLink className="w-3 h-3" />
            Open full view
          </button>
        </div>
      </div>

      {/* ---- Delete category confirmation dialog ---- */}
      <Dialog open={!!deletingCategory} onOpenChange={open => { if (!open) setDeletingCategory(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Category</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the category "{deletingCategory?.name}"?
              Codes in this category will become uncategorized. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingCategory(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteCategory}
              disabled={deleteCategoryMut.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
