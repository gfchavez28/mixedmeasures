import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { Plus, FolderOpen, Archive, Trash2, Pencil, Moon, Sun, Settings, FileInput, Package, ChevronDown, Copy, UserPlus } from 'lucide-react'
import { projectsApi, projectPortabilityApi, type Project, retryUnanswered} from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'
import type { ImportValidationResult, ProjectImportMode } from '@/lib/api'
import { setPendingMerge } from '@/lib/pending-merge'
import {
  canKeepIdentity, codingCopyCandidates, codingCopyMapping, shouldAskWhoYouAre, whoIsYouBlocker,
  type WhoIsYou,
} from '@/lib/coding-copy'
import { staleResultsNote } from '@/lib/stale-results'
import type { ProjectImportResult } from '@/lib/api'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useTheme } from '@/lib/theme-context'
import { useCoders, resetCoderRoster } from '@/hooks/useCoders'
import { useCoderSwitch } from '@/hooks/useCoderSwitch'
import { useCreateCoder } from '@/hooks/useCreateCoder'
import { coderColor } from '@/lib/coder-color'
import { plural, countLabel } from '@/lib/format'
import { ConfirmDialog, DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import MMLogo from '@/components/MMLogo'
import InlineEditableText from '@/components/InlineEditableText'
import ProjectFileOrigin from '@/components/ProjectFileOrigin'
import { formatRelativeTime } from '@/lib/format'
import { MMPROJECT_ACCEPT } from '@/lib/mm-formats'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toastProjectExportError } from '@/lib/project-export-error'
import LongWaitStatus from '@/components/LongWaitStatus'
import { useKeepInViewWhen } from '@/hooks/useKeepInViewWhen'
import { importFailureSentence, validateFailureSentence } from '@/lib/project-lifecycle-copy'
import ProjectDeleteDialog from '@/components/ProjectDeleteDialog'
import { SAFETY_COPIES_QUERY_KEY } from '@/lib/safety-copies'
import { projectFileRefusal } from '@/lib/mm-file-refusal'
import { forgetCachedProjectPages } from '@/lib/project-cache'

/**
 * #459 — Dashboard coder switcher. The TopRail only lives inside a project, so the
 * projects list needs its own way to switch identity. Compact dropdown. #530: it
 * renders on single-coder installs too (menu = just "New coder") — the old plain-name
 * span left a fresh install with no way to become multi-coder from this screen.
 * Reuses the shared switch-with-confirm flow (#460) + shared create flow (#530).
 */
function DashboardCoderSwitcher() {
  const { user } = useAuth()
  const { selectableCoders } = useCoders()
  const { requestSwitch, dialog, switching } = useCoderSwitch()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setCreating(false)
    setNewName('')
  }, [])

  // #530 — shared create flow; creating switches to the new coder without a
  // second confirm (an explicit choice already).
  const createMutation = useCreateCoder({
    onCreated: (coder) => {
      closeMenu()
      requestSwitch({ id: coder.id, username: coder.username }, { skipConfirm: true })
    },
  })

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) closeMenu() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open, closeMenu])

  if (!user) return null
  // #989 — `selectableCoders`, never `coders`: the roster includes MACHINE coders
  // (their codings must be attributable) and `switch-coder` refuses them, so a
  // list built from the full roster offers an act the server 404s.
  const others = selectableCoders.filter(c => c.id !== user.id)
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-sm text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/10 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user.username} — coder menu`}
      >
        <span
          className="w-2 h-2 rounded-full flex-none"
          style={{ backgroundColor: coderColor({ id: user.id, display_color: user.display_color }) }}
          aria-hidden="true"
        />
        <span className="max-w-[120px] truncate">{user.username}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 w-52 rounded-md border border-white/[0.1] bg-[hsl(var(--mm-chrome))] shadow-lg z-50 py-1">
          {others.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[hsl(var(--mm-chrome-text-muted))]/70">
                Switch coder
              </div>
              {others.map(c => (
                <button
                  key={c.id}
                  role="menuitem"
                  onClick={() => { closeMenu(); requestSwitch({ id: c.id, username: c.username }) }}
                  disabled={switching}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.06] transition-colors"
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ backgroundColor: coderColor(c) }} aria-hidden="true" />
                  <span className="truncate">{c.username}</span>
                </button>
              ))}
              <div role="separator" className="my-1 border-t border-white/[0.07]" />
            </>
          )}
          {creating ? (
            <form
              onSubmit={e => {
                e.preventDefault()
                const n = newName.trim()
                if (n) createMutation.mutate(n)
              }}
              className="px-3 py-1.5"
            >
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="New coder name…"
                maxLength={50}
                aria-label="New coder name"
                className="w-full rounded bg-white/[0.06] px-2 py-1 text-xs text-[hsl(var(--mm-chrome-text))] placeholder:text-[hsl(var(--mm-chrome-text-muted))]/60 outline-none"
              />
            </form>
          ) : (
            <button
              role="menuitem"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.06] transition-colors"
            >
              <UserPlus className="w-3 h-3" />
              New coder
            </button>
          )}
        </div>
      )}
      {dialog}
    </div>
  )
}

/**
 * #958 §6 — the toast options for an import or a duplicate, or `undefined`.
 *
 * **Why a duplicate says this at all:** duplicating a project is an export followed by an
 * import, so the copy's saved results are declared out of date exactly as an imported
 * colleague's are — their per-record scores are DERIVED and are rebuilt here, not carried.
 *
 * ⚠️ **The explanation lives HERE rather than at the two call sites, and not only for
 * tidiness.** `project-export-error.test.ts` reads the 600 characters following each
 * `projectPortabilityApi.duplicateProject(` call and requires `toastProjectExportError`
 * inside them — and `stripComments` replaces a comment with SPACES to preserve offsets, so
 * a comment inside that handler consumes the window just as code does. Two lines of prose
 * in `onSuccess` pushed `onError` ten characters past it (measured 2026-09-21).
 */
function staleToast(result: ProjectImportResult): { description: string } | undefined {
  const note = staleResultsNote(result.metrics_marked_stale, result.tests_marked_stale)
  return note ? { description: note } : undefined
}

/**
 * #1258 — the import wait's words, from the mode the researcher PRESSED. Only an
 * overwrite replaces anything; a new copy beside an existing one says so, because
 * the dialog has just offered to replace that project and the researcher chose not to.
 */
function importWaitLabel(mode: ProjectImportMode | null): string {
  return mode === 'overwrite' ? 'Replacing your copy…' : 'Importing…'
}

function importWaitSentence(mode: ProjectImportMode | null, copyExistsHere: boolean): string {
  if (mode === 'overwrite') {
    return 'A safety copy of your project is saved first, then it is replaced. A large project takes a few minutes.'
  }
  return copyExistsHere
    ? 'It is imported as a separate project; your copy here is not changed. A large project takes a few minutes.'
    : 'A large project takes a few minutes.'
}

export default function Dashboard() {
  const { isDark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [deleteProjectId, setDeleteProjectId] = useState<number | null>(null)
  // #482: confirm before duplicating — a duplicate is an INDEPENDENT copy (fresh
  // identity) and can't be merged back into the original; the confirm says so.
  const [duplicateProjectId, setDuplicateProjectId] = useState<number | null>(null)
  const [editingProject, setEditingProject] = useState<{ id: number; field: 'name' | 'description' } | null>(null)

  // Import project state
  const importFileRef = useRef<HTMLInputElement>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPreview, setImportPreview] = useState<ImportValidationResult | null>(null)
  const [importValidating, setImportValidating] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  // #1321 — no project here shares the file's identity, so the import can KEEP it.
  const { user } = useAuth()
  const keepIdentity = importPreview !== null && canKeepIdentity(importPreview)
  // 🔴 D2 — a copy that keeps the identity asks which of the file's people is YOU. With no
  // answer the server makes each of them a coder of their own (never by name, in a coding
  // copy), so a researcher moving their own project here would become two coders, and
  // reliability would compare them with themselves. The answer is REQUIRED before *Import*;
  // *Import as an independent project* keeps today's rules and is not gated (D6).
  const [whoIsYou, setWhoIsYou] = useState<WhoIsYou | null>(null)
  const askWhoYouAre = keepIdentity && shouldAskWhoYouAre(importPreview?.file_coders, user?.id)
  const whoCandidates = askWhoYouAre ? codingCopyCandidates(importPreview?.file_coders) : []
  const whoBlocker = whoIsYouBlocker(askWhoYouAre, whoIsYou)
  // #1258 — the mode PRESSED, which the wait's words and the busy button key on.
  // They keyed on `existing_project` (the file's project exists here), so *Import
  // as new copy* said "Replacing your copy… then it is replaced" while it made a
  // copy and left the project untouched.
  const [importMode, setImportMode] = useState<ProjectImportMode | null>(null)
  // #1258 — the pressed button, kept in view when the wait panel opens above the
  // footer (#1139's recipe: the capped dialog keeps its scroll position, so the
  // focused busy button slid below its bottom edge at 640×360).
  const busyButtonRef = useRef<HTMLButtonElement>(null)
  useKeepInViewWhen(importLoading, busyButtonRef)
  const busyRef = (mode: ProjectImportMode) => (importMode === mode ? busyButtonRef : undefined)
  // #1203 — why the last picked file did not reach the preview, said under the
  // header row (Settings' Restore from a file is the model). `key` remounts the
  // alert, so the same refusal twice is announced twice.
  const [importRefusal, setImportRefusal] = useState<{ text: string; key: number } | null>(null)
  const refusalSeq = useRef(0)
  // The handler's own refusal while a check runs. A REF, not `importValidating`:
  // this callback's deps are `[]`, so it would read the state it was created with.
  const validatingRef = useRef(false)

  const handleImportFileSelect = useCallback(async (file: File) => {
    if (validatingRef.current) return
    const refuse = (text: string) => setImportRefusal({ text, key: ++refusalSeq.current })
    // 🔴 Refused HERE, before the upload starts (#1203): a `notes.txt` was POSTed
    // whole and a 520 MB file sent whole before the server's 413. Cleared on the
    // next pick that passes.
    const refusal = projectFileRefusal(file)
    if (refusal) { refuse(refusal); return }
    setImportRefusal(null)
    validatingRef.current = true
    // An answer is about ONE file's people: the next file is asked again.
    setWhoIsYou(null)
    setImportFile(file)
    setImportValidating(true)
    try {
      const result = await projectPortabilityApi.validateImport(file)
      setImportPreview(result)
    } catch (err) {
      // The server's sentence — "created by a newer version … Please update to
      // import it" was toasted as "Invalid project file".
      refuse(validateFailureSentence(err, file.name))
      setImportFile(null)
    } finally {
      validatingRef.current = false
      setImportValidating(false)
    }
  }, [])

  const handleImportConfirm = useCallback(async (mode: ProjectImportMode = 'new') => {
    // #1035 review §4 #8: the buttons stay focusable while it runs (aria-disabled,
    // #965), so the guard is what refuses a second press.
    if (!importFile || importLoading) return
    // 🔴 D2 — *Import* is `aria-disabled` until "which of these people is you?" is
    // answered, which changes what it announces and nothing about what it does (#754):
    // this guard is the refusal, for Enter and Space too.
    if (mode === 'copy_for_coding' && whoBlocker) return
    // At most ONE entry (the person chosen as you, onto the active coder); none for
    // "None of them". Only a coding copy asks, so only a coding copy sends one.
    const coderMapping = mode === 'copy_for_coding'
      ? codingCopyMapping(importPreview?.file_coders, user?.id, whoIsYou)
      : undefined
    setImportMode(mode)
    setImportLoading(true)
    try {
      const targetProjectId = importPreview?.existing_project?.id
      const result = await projectPortabilityApi.importProject(importFile, {
        mode,
        targetProjectId: mode === 'overwrite' ? targetProjectId : undefined,
        ...(coderMapping ? { coderMapping } : {}),
      })
      // #1206: before the navigate below — an overwrite comes back under the SAME
      // ids, and a new copy can take a deleted project's, so a cached page of the
      // old copy would be shown as this one.
      forgetCachedProjectPages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // #964: an import creates the file's coders on this install, and a stale
      // one-coder roster turns blind mode off in the project just imported.
      void resetCoderRoster(queryClient)
      if (result.safety_backup_filename) {
        queryClient.invalidateQueries({ queryKey: SAFETY_COPIES_QUERY_KEY })
      }
      // The overwrite deleted a populated project. A snapshot of it was taken first
      // and was never named to anyone — so the description carries the filename, and
      // the audit log carries it durably (a toast is gone in seconds, and the person
      // who needs this file is looking hours later).
      // TWO facts can be true of one import, and the second has a consequence the
      // researcher meets days later — so it must not be dropped when the first fires.
      const notes: string[] = []
      if (result.safety_backup_filename) {
        // #919: say WHERE — the backup folder is not reachable from the app,
        // so the copy is listed, with a Download, in Settings.
        notes.push(
          `Your previous copy was saved as ${result.safety_backup_filename}. ` +
          `To go back to it, download it from Settings › Backup & Data and import it.`,
        )
      }
      const stale = staleResultsNote(result.metrics_marked_stale, result.tests_marked_stale)
      if (stale) notes.push(stale)
      toast.success(
        mode === 'overwrite'
          ? `Updated "${result.project_name}" from the imported file`
          : `Imported "${result.project_name}"`,
        notes.length ? { description: notes.join(' ') } : undefined,
      )
      setImportFile(null)
      setImportPreview(null)
      navigate(`/projects/${result.project_id}/overview`)
    } catch (err) {
      // The server's reason (a refused file says why), or — when no answer came —
      // that nobody knows yet; the list is refreshed either way, because an
      // overwrite the client gave up on may still have finished.
      toast.error(importFailureSentence(err), { duration: 10_000 })
      // …and so may have replaced the cached pages' project (#1206).
      forgetCachedProjectPages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    } finally {
      setImportLoading(false)
      setImportMode(null)
    }
  }, [importFile, importLoading, importPreview, whoBlocker, whoIsYou, user?.id, queryClient, navigate])

  // Track J · J3-2: merge is a multi-step flow, so hand the file + validate result
  // off to the full-page merge page (a File can't ride a route param) and navigate.
  const handleMergeStart = useCallback(() => {
    if (importLoading || !importFile || !importPreview?.existing_project) return
    const targetId = importPreview.existing_project.id
    setPendingMerge(importFile, importPreview, targetId)
    setImportFile(null)
    setImportPreview(null)
    if (importFileRef.current) importFileRef.current.value = ''
    navigate(`/projects/${targetId}/merge`)
  }, [importFile, importLoading, importPreview, navigate])

  const handleImportCancel = useCallback(() => {
    setImportFile(null)
    setImportPreview(null)
    if (importFileRef.current) importFileRef.current.value = ''
  }, [])

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    retry: retryUnanswered,
  })
  const data = projectsQuery.data
  /**
   * #963 — the project list is the FIRST thing a researcher sees, and "No
   * projects yet" is the worst possible false claim: it is the screen for
   * someone who has never used the tool, shown to someone whose work simply
   * failed to load. The old gate was `isLoading`, which React Query v5 reports
   * `false` once a failure has settled.
   */
  const projectsLoad = useListLoad(projectsQuery)

  const createMutation = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: (project) => {
      // #1206: a new project can take a deleted one's id — its cached pages
      // showed the deleted project's name.
      forgetCachedProjectPages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setIsNewProjectOpen(false)
      setNewProjectName('')
      setNewProjectDescription('')
      navigate(`/projects/${project.id}/overview`)
    },
  })

  const deleteTarget = deleteProjectId !== null
    ? data?.projects.find(p => p.id === deleteProjectId) ?? null
    : null

  const updateProjectMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pick<Project, 'name' | 'description' | 'status'>> }) =>
      projectsApi.update(id, data),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', variables.id] })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (project: Project) =>
      projectsApi.update(project.id, { status: project.status === 'archived' ? 'active' : 'archived' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: (projectId: number) => projectPortabilityApi.duplicateProject(projectId),
    onSuccess: (result) => {
      forgetCachedProjectPages(queryClient)  // #1206: the copy may take a reused id
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDuplicateProjectId(null)
      toast.success(`Duplicated as "${result.project_name}"`, staleToast(result))
    },
    // #842: Duplicate runs through the SAME export machinery, so it hits the
    // same size refusal — and it must say so rather than shrug.
    onError: (err) => { toastProjectExportError(err, 'Could not duplicate project') },
  })

  const handleCreateProject = (e: React.FormEvent) => {
    e.preventDefault()
    createMutation.mutate({
      name: newProjectName,
      description: newProjectDescription || undefined,
    })
  }

  const activeProjects = data?.projects.filter(s => s.status === 'active') || []
  const archivedProjects = data?.projects.filter(s => s.status === 'archived') || []

  // ONE builder for both lists' cards. The archived list wrote its own, and its
  // Duplicate called the mutation directly — skipping #482's confirmation (a copy
  // has its own identity and cannot be merged back) — with `duplicating` unscoped,
  // so every archived card read "Duplicating…" during any duplicate (10-14).
  const cardProps = (project: Project) => ({
    project,
    onArchive: () => archiveMutation.mutate(project),
    onDelete: () => setDeleteProjectId(project.id),
    onDuplicate: () => setDuplicateProjectId(project.id),
    duplicating: duplicateMutation.isPending && duplicateProjectId === project.id,
    editingProject,
    onRename: (id: number, field: 'name' | 'description') => setEditingProject({ id, field }),
    onUpdate: (id: number, data: Partial<Pick<Project, 'name' | 'description'>>) =>
      updateProjectMutation.mutate({ id, data }),
    onEditEnd: () => setEditingProject(null),
  })

  return (
    <div className="min-h-screen bg-mm-bg">
      {/* Same chrome treatment as the in-project TopRail (#427) — the brand
        * surface should be present on the first screen, not only inside a
        * project. */}
      <header className="bg-[hsl(var(--mm-chrome))] border-b border-white/[0.07] px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <MMLogo size={28} />
            <span className="text-[17px] font-semibold text-[hsl(var(--mm-chrome-text))]">Mixed Measures</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-md text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/10 transition-colors"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link
              to="/settings"
              className="p-1.5 rounded-md text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/10 transition-colors"
              aria-label="Settings"
            >
              <Settings className="w-4 h-4" />
            </Link>
            <DashboardCoderSwitcher />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3.5 py-3.5">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-mm-text">Projects</h2>
          <div className="flex items-center gap-2">
            <input
              ref={importFileRef}
              type="file"
              accept={MMPROJECT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleImportFileSelect(file)
                e.target.value = ''
              }}
            />
            {/* #1203 — busy is `aria-disabled` + `aria-busy` + the click guard, never
                `disabled` (#965): Chrome blurred the focused button 58 ms after the
                pick, so focus sat on <body> for the check and the preview dialog's
                focus return (#959) had no opener. */}
            <button
              onClick={() => { if (!importValidating) importFileRef.current?.click() }}
              aria-disabled={importValidating || undefined}
              aria-busy={importValidating || undefined}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium border border-border text-mm-text bg-mm-surface hover:bg-mm-surface-hover transition-colors aria-disabled:opacity-50 aria-busy:cursor-wait"
            >
              <FileInput className="w-4 h-4" />
              {importValidating ? 'Validating...' : 'Import Project'}
            </button>
          <Dialog open={isNewProjectOpen} onOpenChange={setIsNewProjectOpen}>
            <DialogTrigger asChild>
              <button className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium text-mm-on-fill bg-mm-green-fill hover:opacity-90 transition-opacity">
                <Plus className="w-4 h-4" />
                New Project
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
                <DialogDescription>
                  Create a new project to organize your data, coding, and analysis.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateProject} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input
                    id="name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    required
                    placeholder="e.g., User Research Q1 2024"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    value={newProjectDescription}
                    onChange={(e) => setNewProjectDescription(e.target.value)}
                    placeholder="Brief description of the project..."
                    rows={3}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsNewProjectOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending ? 'Creating...' : 'Create Project'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* #1203 — why the picked file was refused, under the button that picked
            it. Focus stays on that button; the alert announces. Red-700, not the
            600 Settings uses on its white card: this sits on the grey page
            (`mm-bg`), where 600 measures about 4.0:1. */}
        {importRefusal && (
          <p key={importRefusal.key} role="alert" className="-mt-4 mb-4 text-sm text-red-700 dark:text-red-400 leading-relaxed">
            {importRefusal.text}
          </p>
        )}

        {/* Import Preview AlertDialog */}
        {/* #1035 review §4 #8 — Escape closed this mid-import (the import ran on,
            unseen), and the buttons went natively `disabled`, which drops focus to
            <body> (#965). The Root refuses a close while it runs. */}
        <AlertDialog open={importPreview !== null} onOpenChange={(open) => { if (!open && !importLoading) handleImportCancel() }}>
          <AlertDialogContent className={`max-w-xl ${DIALOG_FITS_VIEWPORT}`}>
            <AlertDialogHeader>
              <AlertDialogTitle>Import Project</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  {importPreview?.existing_project ? (
                    <>
                      <p>
                        A copy of <strong>{importPreview.manifest.project_name}</strong> already
                        exists here as <strong>{importPreview.existing_project.name}</strong>.
                        <strong> Merge</strong> a colleague's codings into it, <strong>overwrite</strong> your
                        copy (replaced — a safety backup is saved first), or import a separate <strong>new</strong> copy?
                      </p>
                      {/* #482: refusal-end clarity — merge/overwrite are identity-scoped. */}
                      <p className="text-xs text-mm-text-muted">
                        Merge and overwrite apply to <strong>{importPreview.existing_project.name}</strong> only —
                        the project that shares this file's identity. A duplicated project has its own identity, so it
                        can't receive this merge.
                      </p>
                    </>
                  ) : keepIdentity ? (
                    <>
                      {/* #1321 — the only door a colleague's copy can come back through.
                          "new" re-mints the identity, so a copy imported that way could
                          never be merged with the project it came from. */}
                      <p>
                        Import <strong>{importPreview?.manifest?.project_name}</strong>. It keeps the identity of
                        the project it was exported from, so the two can be merged later — your coding
                        merged back into the original, or the original's new work into this copy.
                      </p>
                      {/* What a merge refuses was MEASURED both ways (#1321 review, r1):
                          409 for a split, a join or an edited turn, on either side; 200 once
                          the copy that changed is undone (Rejoin / Unmerge / the words put
                          back). Clip freezing was read, not driven, so no undo is promised
                          for it. "Rejoin" and "Unmerge" are the workbench menu's labels. */}
                      <p className="text-xs text-mm-text-muted">
                        While the copies are apart, code, quote and add notes, memos and codes freely. A merge refuses
                        copies whose units or words differ, so in neither copy split or join a turn or paragraph, edit
                        its words, or freeze or unfreeze an observation's clips. If one was changed, undoing it in the
                        copy that changed (Rejoin, Unmerge, or putting the words back) clears that refusal.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>Import <strong>{importPreview?.manifest?.project_name}</strong> as a new project?</p>
                      {/* #482: explain why only "new" is available so a duplicate→merge attempt isn't a silent dead-end. */}
                      <p className="text-xs text-mm-text-muted">
                        Merge and overwrite aren't offered: this file isn't a copy of any project already here. They're
                        available only for a file exported from an existing project (which carries that project's identity).
                        A project made with <strong>Duplicate</strong> has a separate identity and can't be merged back.
                      </p>
                    </>
                  )}
                  {importPreview?.manifest?.project_summary && (
                    <div className="text-xs text-mm-text-muted grid grid-cols-2 gap-1 bg-mm-bg rounded-md p-3">
                      {/* #639: observations belong here for the same reason as the
                          project card — this is the "what's in the file" summary, and
                          it undercounted an observations-bearing archive. The count
                          reads 0 for a pre-observations (v1/v2) file rather than
                          vanishing, because the backend schema defaults it.
                          #640: phrasing goes through `countLabel` so none of these
                          can read "1 conversations". */}
                      <span>{countLabel(importPreview.manifest.project_summary.conversation_count, 'conversation', 'conversations')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.document_count, 'document', 'documents')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.dataset_count, 'dataset', 'datasets')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.observation_count, 'observation', 'observations')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.code_count, 'code', 'codes')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.participant_count, 'participant', 'participants')}</span>
                      <span>{countLabel(importPreview.manifest.project_summary.memo_count, 'memo', 'memos')}</span>
                      {/* The canvas is the write-up; a file that carries one should
                          say so before it is imported. The count only reached the
                          wire on 2026-09-04 (#855 — the schema never declared it). */}
                      <span>{countLabel(importPreview.manifest.project_summary.canvas_count, 'canvas', 'canvases')}</span>
                    </div>
                  )}
                  <ProjectFileOrigin appVersion={importPreview?.manifest?.app_version} />
                  {importPreview?.warnings && importPreview.warnings.length > 0 && (
                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-2.5 text-xs text-amber-800 dark:text-amber-200">
                      {importPreview.warnings.map((w, i) => <p key={i}>{w}</p>)}
                    </div>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* 🔴 D2 — OUTSIDE the description on purpose (#955 d): controls are reached by
                Tab, and inside it every option's words would be read as the dialog's
                description. A real `fieldset`/`legend` (CodingImport's pattern; there is no
                radio-group component), so each option announces with its question. Each
                option's name is the file person's name and codings count — the FILE's
                values, which nothing here changes (#770). */}
            {askWhoYouAre && (
              <fieldset className="min-w-0 space-y-2 text-left" aria-describedby="coding-copy-who-note">
                <legend className="text-sm font-medium text-mm-text">Which of these people is you?</legend>
                {/* ONE string (#1067 c): a described element's sentences are one text node. */}
                <p id="coding-copy-who-note" className="text-xs text-mm-text-muted">
                  {`If you coded this project on another computer, choose yourself: that coding becomes yours, as ${user?.username}. ` +
                    'Everyone else in the file stays a coder of their own, so their coding and yours stay apart.'}
                </p>
                <div className="space-y-1.5">
                  {whoCandidates.map(c => (
                    <label key={c.original_id} className="flex items-start gap-2 text-sm text-mm-text">
                      <input
                        type="radio"
                        name="coding-copy-who"
                        className="mt-1 flex-none"
                        checked={whoIsYou?.kind === 'person' && whoIsYou.originalId === c.original_id}
                        onChange={() => setWhoIsYou({ kind: 'person', originalId: c.original_id })}
                      />
                      <span className="min-w-0 break-words">
                        {c.username}{' '}
                        <span className="text-mm-text-muted">— {countLabel(c.file_app_count, 'coding', 'codings')}</span>
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 text-sm text-mm-text">
                    <input
                      type="radio"
                      name="coding-copy-who"
                      className="mt-1 flex-none"
                      checked={whoIsYou?.kind === 'none'}
                      onChange={() => setWhoIsYou({ kind: 'none' })}
                    />
                    <span className="min-w-0">None of them</span>
                  </label>
                </div>
              </fieldset>
            )}
            {importLoading && (
              <LongWaitStatus
                label={importWaitLabel(importMode)}
                firstAnnouncement="Importing the project. Keep Mixed Measures open until this finishes."
              >
                {importWaitSentence(importMode, !!importPreview?.existing_project)}
              </LongWaitStatus>
            )}
            {/* The REASON *Import* is off — visible, and its description (#959/#965:
                never native `disabled`, which blurs a focused button). */}
            {whoBlocker && (
              <p id="coding-copy-who-blocker" className="text-sm text-amber-700 dark:text-amber-400 sm:text-right">
                {whoBlocker}
              </p>
            )}
            <AlertDialogFooter className="flex-wrap gap-2 sm:space-x-0">
              <AlertDialogCancel aria-disabled={importLoading || undefined}>Cancel</AlertDialogCancel>
              {importPreview?.existing_project ? (
                <>
                  {/* #1258 — the busy word goes on the button that was PRESSED;
                      `scroll-mb-6` is #1139's: `block: 'nearest'` ignores the
                      dialog's padding and would land the button flush on its edge. */}
                  <Button
                    ref={busyRef('new')}
                    variant="outline"
                    className="scroll-mb-6"
                    onClick={() => handleImportConfirm('new')}
                    aria-disabled={importLoading || undefined}
                    aria-busy={(importLoading && importMode === 'new') || undefined}
                  >
                    {importLoading && importMode === 'new' ? 'Importing…' : 'Import as new copy'}
                  </Button>
                  <Button
                    ref={busyRef('overwrite')}
                    variant="destructive"
                    className="scroll-mb-6"
                    onClick={() => handleImportConfirm('overwrite')}
                    aria-disabled={importLoading || undefined}
                    aria-busy={(importLoading && importMode === 'overwrite') || undefined}
                  >
                    {importLoading && importMode === 'overwrite' ? 'Working…' : 'Overwrite my copy'}
                  </Button>
                  <Button
                    variant="default"
                    onClick={handleMergeStart}
                    aria-disabled={importLoading || undefined}
                  >
                    Merge coding in…
                  </Button>
                </>
              ) : keepIdentity ? (
                <>
                  <Button
                    ref={busyRef('new')}
                    variant="outline"
                    className="scroll-mb-6"
                    onClick={() => handleImportConfirm('new')}
                    aria-disabled={importLoading || undefined}
                    aria-busy={(importLoading && importMode === 'new') || undefined}
                  >
                    {importLoading && importMode === 'new' ? 'Importing…' : 'Import as an independent project'}
                  </Button>
                  <Button
                    ref={busyRef('copy_for_coding')}
                    className="scroll-mb-6"
                    onClick={() => handleImportConfirm('copy_for_coding')}
                    aria-disabled={(importLoading || !!whoBlocker) || undefined}
                    aria-describedby={whoBlocker ? 'coding-copy-who-blocker' : undefined}
                    aria-busy={(importLoading && importMode === 'copy_for_coding') || undefined}
                  >
                    {importLoading && importMode === 'copy_for_coding' ? 'Importing…' : 'Import'}
                  </Button>
                </>
              ) : (
                // `preventDefault`: an AlertDialogAction is a Close, and this one
                // must stay open while the import runs.
                <AlertDialogAction
                  ref={busyRef('new')}
                  className="scroll-mb-6"
                  onClick={(e) => { e.preventDefault(); void handleImportConfirm('new') }}
                  aria-disabled={importLoading || undefined}
                  aria-busy={importLoading || undefined}
                >
                  {importLoading ? 'Importing…' : 'Import'}
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {projectsLoad.status !== 'ready' ? (
          <LoadState
            load={projectsLoad}
            loadingLabel="Loading your projects…"
            failedTitle="Your projects could not be loaded."
          />
        ) : activeProjects.length === 0 && archivedProjects.length === 0 ? (
          <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card text-center py-12 px-6">
            <FolderOpen className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
            <h3 className="text-lg font-medium text-mm-text mb-2">No projects yet</h3>
            {/* #411: the first screen a new evaluator sees — one orientation
                line + the worked-example pointer, nothing more. */}
            <p className="text-mm-text-muted mb-1 max-w-lg mx-auto">
              A project holds qualitative and quantitative data together — code interviews
              and documents, analyze survey data, and link both through shared participants.
            </p>
            <p className="text-sm text-mm-text-muted mb-4 max-w-lg mx-auto">
              New here? Download the Ferncrest example project from{' '}
              <a
                href="https://mixedmeasures.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-mm-text"
              >
                mixedmeasures.com
              </a>{' '}
              and open it with Import Project above.
            </p>
            <button
              onClick={() => setIsNewProjectOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium text-mm-on-fill bg-mm-green-fill hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {activeProjects.map((project) => (
                <ProjectCard key={project.id} {...cardProps(project)} />
              ))}
            </div>

            {archivedProjects.length > 0 && (
              <>
                <h3 className="text-sm font-medium text-mm-text-muted mb-3">Archived</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-60">
                  {archivedProjects.map((project) => (
                    <ProjectCard key={project.id} {...cardProps(project)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {/* #1035 — names the project and what it holds, offers Archive, says the
          wait; no client time limit on the request. */}
      <ProjectDeleteDialog
        project={deleteTarget}
        onClose={() => setDeleteProjectId(null)}
        onArchive={(project) => archiveMutation.mutate(project)}
      />

      {/* #482: duplicate is an INDEPENDENT copy — set expectations up front so no one
          codes a duplicate for hours expecting to merge it back (it can't be; a duplicate
          gets a fresh identity). The merge-later workflow is Export Project, named here. */}
      <ConfirmDialog
        open={duplicateProjectId !== null}
        onOpenChange={(open) => { if (!open) setDuplicateProjectId(null) }}
        title="Duplicate this project?"
        description="This creates an independent copy with its own identity — it can't be merged back into the original. To code a copy elsewhere and merge it in later, use Export Project instead, then open the file there with Import Project and choose Import, which keeps the project's identity."
        destructive={false}
        confirmLabel="Duplicate"
        loading={duplicateMutation.isPending}
        loadingLabel="Duplicating…"
        onConfirm={() => {
          if (duplicateProjectId !== null) {
            duplicateMutation.mutate(duplicateProjectId)
          }
        }}
      />
    </div>
  )
}

function ProjectCard({
  project,
  onArchive,
  onDelete,
  onDuplicate,
  duplicating,
  editingProject,
  onRename,
  onUpdate,
  onEditEnd,
}: {
  project: Project
  onArchive: () => void
  onDelete: () => void
  onDuplicate: () => void
  duplicating: boolean
  editingProject: { id: number; field: 'name' | 'description' } | null
  onRename: (id: number, field: 'name' | 'description') => void
  onUpdate: (id: number, data: Partial<Pick<Project, 'name' | 'description'>>) => void
  onEditEnd: () => void
}) {
  const isEditingName = editingProject?.id === project.id && editingProject?.field === 'name'
  const isEditingDescription = editingProject?.id === project.id && editingProject?.field === 'description'

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Link to={`/projects/${project.id}/overview`}>
          <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 hover:border-[hsl(var(--mm-green)/0.5)] transition-colors cursor-pointer">
            <div className="flex items-start justify-between mb-1">
              <div className="min-w-0 flex-1" title={project.name}>
                <InlineEditableText
                  value={project.name}
                  onSave={(name) => onUpdate(project.id, { name })}
                  className="text-[16px] font-semibold text-mm-text truncate block"
                  inputClassName="text-[16px] font-semibold"
                  startEditing={isEditingName}
                  onEditEnd={onEditEnd}
                />
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                {project.status === 'archived' && (
                  <span className="text-[11px] bg-mm-surface-hover text-mm-text-muted px-2 py-0.5 rounded">
                    Archived
                  </span>
                )}
                <span className="text-[11px] text-mm-text-faint" title="Last activity">
                  {formatRelativeTime(project.last_activity_at ?? project.updated_at)}
                </span>
              </div>
            </div>
            <InlineEditableText
              value={project.description || ''}
              placeholder="No description"
              onSave={(description) => onUpdate(project.id, { description: description || null })}
              className="text-[13px] text-mm-text-secondary line-clamp-2 mb-2 block"
              inputClassName="text-[13px]"
              tag="p"
              allowEmpty
              startEditing={isEditingDescription}
              onEditEnd={onEditEnd}
            />
            {/* The four SOURCE types, all unconditional — this row's job is "what
                kind of material is in here", so a zero is information, not noise.
                Observations was missing until #639, which meant an observation-only
                project rendered "0 conversations 0 documents 0 datasets" on the
                app's front door and read as empty. Peer concepts, peer treatment:
                participants/coders below stay conditional because they are not
                sources. Accents match TopRail's per-workspace colors. */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-mm-text-muted">
              <span><strong className="text-mm-green-text">{project.conversation_count.toLocaleString()}</strong> {plural(project.conversation_count, 'conversation', 'conversations')}</span>
              <span><strong className="text-mm-purple-text">{project.document_count.toLocaleString()}</strong> {plural(project.document_count, 'document', 'documents')}</span>
              <span><strong className="text-mm-orange-text">{project.dataset_count.toLocaleString()}</strong> {plural(project.dataset_count, 'dataset', 'datasets')}</span>
              <span><strong className="text-mm-teal-text">{project.observation_count.toLocaleString()}</strong> {plural(project.observation_count, 'observation', 'observations')}</span>
              {project.participant_count > 0 && (
                <span><strong className="text-mm-text">{project.participant_count.toLocaleString()}</strong> {plural(project.participant_count, 'participant', 'participants')}</span>
              )}
              {/* Track J · Group A (#1): only surfaces on multi-coder projects — a
                  solo "1 coder" on every project would just be noise. */}
              {project.coder_count > 1 && (
                <span><strong className="text-mm-text">{project.coder_count.toLocaleString()}</strong> coders</span>
              )}
            </div>
          </div>
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRename(project.id, 'name')}>
          <Pencil className="w-4 h-4 mr-2" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={async () => {
          try {
            await projectPortabilityApi.exportProject(project.id)
            toast.success('Project exported')
          } catch (err) {
            toastProjectExportError(err, 'Export failed')  // #842
          }
        }}>
          <Package className="w-4 h-4 mr-2" />
          Export Project
        </ContextMenuItem>
        <ContextMenuItem onClick={onDuplicate} disabled={duplicating}>
          <Copy className="w-4 h-4 mr-2" />
          {duplicating ? 'Duplicating…' : 'Duplicate'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onArchive}>
          <Archive className="w-4 h-4 mr-2" />
          {project.status === 'archived' ? 'Unarchive' : 'Archive'}
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="text-red-600">
          <Trash2 className="w-4 h-4 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
