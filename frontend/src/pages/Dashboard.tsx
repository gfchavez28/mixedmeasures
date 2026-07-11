import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, FolderOpen, Archive, Trash2, Pencil, Moon, Sun, Settings, FileInput, Package, ChevronDown, Copy, UserPlus } from 'lucide-react'
import { projectsApi, projectPortabilityApi, type Project } from '@/lib/api'
import type { ImportValidationResult, ProjectImportMode } from '@/lib/api'
import { setPendingMerge } from '@/lib/pending-merge'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useTheme } from '@/lib/theme-context'
import { useCoders } from '@/hooks/useCoders'
import { useCoderSwitch } from '@/hooks/useCoderSwitch'
import { useCreateCoder } from '@/hooks/useCreateCoder'
import { coderColor } from '@/lib/coder-color'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import MMLogo from '@/components/MMLogo'
import InlineEditableText from '@/components/InlineEditableText'
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

/**
 * #459 — Dashboard coder switcher. The TopRail only lives inside a project, so the
 * projects list needs its own way to switch identity. Compact dropdown. #530: it
 * renders on single-coder installs too (menu = just "New coder") — the old plain-name
 * span left a fresh install with no way to become multi-coder from this screen.
 * Reuses the shared switch-with-confirm flow (#460) + shared create flow (#530).
 */
function DashboardCoderSwitcher() {
  const { user } = useAuth()
  const { coders } = useCoders()
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
  const others = coders.filter(c => c.id !== user.id)
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

  const handleImportFileSelect = useCallback(async (file: File) => {
    setImportFile(file)
    setImportValidating(true)
    try {
      const result = await projectPortabilityApi.validateImport(file)
      setImportPreview(result)
    } catch {
      toast.error('Invalid project file')
      setImportFile(null)
    } finally {
      setImportValidating(false)
    }
  }, [])

  const handleImportConfirm = useCallback(async (mode: ProjectImportMode = 'new') => {
    if (!importFile) return
    setImportLoading(true)
    try {
      const targetProjectId = importPreview?.existing_project?.id
      const result = await projectPortabilityApi.importProject(importFile, {
        mode,
        targetProjectId: mode === 'overwrite' ? targetProjectId : undefined,
      })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(
        mode === 'overwrite'
          ? `Updated "${result.project_name}" from the imported file`
          : `Imported "${result.project_name}"`,
      )
      setImportFile(null)
      setImportPreview(null)
      navigate(`/projects/${result.project_id}/overview`)
    } catch {
      toast.error('Project import failed')
    } finally {
      setImportLoading(false)
    }
  }, [importFile, importPreview, queryClient, navigate])

  // Track J · J3-2: merge is a multi-step flow, so hand the file + validate result
  // off to the full-page merge page (a File can't ride a route param) and navigate.
  const handleMergeStart = useCallback(() => {
    if (!importFile || !importPreview?.existing_project) return
    const targetId = importPreview.existing_project.id
    setPendingMerge(importFile, importPreview, targetId)
    setImportFile(null)
    setImportPreview(null)
    if (importFileRef.current) importFileRef.current.value = ''
    navigate(`/projects/${targetId}/merge`)
  }, [importFile, importPreview, navigate])

  const handleImportCancel = useCallback(() => {
    setImportFile(null)
    setImportPreview(null)
    if (importFileRef.current) importFileRef.current.value = ''
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })

  const createMutation = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setIsNewProjectOpen(false)
      setNewProjectName('')
      setNewProjectDescription('')
      navigate(`/projects/${project.id}/overview`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: projectsApi.delete,
    onSuccess: () => {
      setDeleteProjectId(null)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

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
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDuplicateProjectId(null)
      toast.success(`Duplicated as "${result.project_name}"`)
    },
    onError: () => { toast.error('Could not duplicate project') },
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
            <button
              onClick={() => importFileRef.current?.click()}
              disabled={importValidating}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium border border-mm-border text-mm-text bg-mm-surface hover:bg-mm-surface-hover transition-colors disabled:opacity-50"
            >
              <FileInput className="w-4 h-4" />
              {importValidating ? 'Validating...' : 'Import Project'}
            </button>
          <Dialog open={isNewProjectOpen} onOpenChange={setIsNewProjectOpen}>
            <DialogTrigger asChild>
              <button className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-green))] hover:opacity-90 transition-opacity">
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

        {/* Import Preview AlertDialog */}
        <AlertDialog open={importPreview !== null} onOpenChange={(open) => { if (!open) handleImportCancel() }}>
          <AlertDialogContent className="max-w-xl">
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
                      <span>{importPreview.manifest.project_summary.conversation_count} conversations</span>
                      <span>{importPreview.manifest.project_summary.document_count} documents</span>
                      <span>{importPreview.manifest.project_summary.dataset_count} datasets</span>
                      <span>{importPreview.manifest.project_summary.code_count} codes</span>
                      <span>{importPreview.manifest.project_summary.participant_count} participants</span>
                      <span>{importPreview.manifest.project_summary.memo_count} memos</span>
                    </div>
                  )}
                  {importPreview?.warnings && importPreview.warnings.length > 0 && (
                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-2.5 text-xs text-amber-800 dark:text-amber-200">
                      {importPreview.warnings.map((w, i) => <p key={i}>{w}</p>)}
                    </div>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-wrap gap-2 sm:space-x-0">
              <AlertDialogCancel disabled={importLoading}>Cancel</AlertDialogCancel>
              {importPreview?.existing_project ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => handleImportConfirm('new')}
                    disabled={importLoading}
                  >
                    Import as new copy
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => handleImportConfirm('overwrite')}
                    disabled={importLoading}
                  >
                    {importLoading ? 'Working…' : 'Overwrite my copy'}
                  </Button>
                  <Button
                    variant="default"
                    onClick={handleMergeStart}
                    disabled={importLoading}
                  >
                    Merge coding in…
                  </Button>
                </>
              ) : (
                <AlertDialogAction onClick={() => handleImportConfirm('new')} disabled={importLoading}>
                  {importLoading ? 'Importing...' : 'Import'}
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {isLoading ? (
          <div className="text-center py-12 text-mm-text-muted">Loading projects...</div>
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
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-green))] hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {activeProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onArchive={() => archiveMutation.mutate(project)}
                  onDelete={() => setDeleteProjectId(project.id)}
                  onDuplicate={() => setDuplicateProjectId(project.id)}
                  duplicating={duplicateMutation.isPending && duplicateProjectId === project.id}
                  editingProject={editingProject}
                  onRename={(id, field) => setEditingProject({ id, field })}
                  onUpdate={(id, data) => updateProjectMutation.mutate({ id, data })}
                  onEditEnd={() => setEditingProject(null)}
                />
              ))}
            </div>

            {archivedProjects.length > 0 && (
              <>
                <h3 className="text-sm font-medium text-mm-text-muted mb-3">Archived</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-60">
                  {archivedProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onArchive={() => archiveMutation.mutate(project)}
                      onDelete={() => setDeleteProjectId(project.id)}
                      onDuplicate={() => duplicateMutation.mutate(project.id)}
                      duplicating={duplicateMutation.isPending}
                      editingProject={editingProject}
                      onRename={(id, field) => setEditingProject({ id, field })}
                      onUpdate={(id, data) => updateProjectMutation.mutate({ id, data })}
                      onEditEnd={() => setEditingProject(null)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      <ConfirmDialog
        open={deleteProjectId !== null}
        onOpenChange={(open) => { if (!open) setDeleteProjectId(null) }}
        title="Delete project"
        description="Are you sure you want to delete this project? This cannot be undone."
        loading={deleteMutation.isPending}
        loadingLabel="Deleting..."
        onConfirm={() => {
          if (deleteProjectId !== null) {
            deleteMutation.mutate(deleteProjectId)
          }
        }}
      />

      {/* #482: duplicate is an INDEPENDENT copy — set expectations up front so no one
          codes a duplicate for hours expecting to merge it back (it can't be; a duplicate
          gets a fresh identity). The merge-later workflow is Export Project, named here. */}
      <ConfirmDialog
        open={duplicateProjectId !== null}
        onOpenChange={(open) => { if (!open) setDuplicateProjectId(null) }}
        title="Duplicate this project?"
        description="This creates an independent copy with its own identity — it can't be merged back into the original. To code a copy elsewhere and merge it in later, use Export Project instead."
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
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-mm-text-muted">
              <span><strong className="text-mm-green-text">{project.conversation_count}</strong> {project.conversation_count === 1 ? 'conversation' : 'conversations'}</span>
              <span><strong className="text-mm-purple-text">{project.document_count}</strong> {project.document_count === 1 ? 'document' : 'documents'}</span>
              <span><strong className="text-mm-orange-text">{project.dataset_count}</strong> {project.dataset_count === 1 ? 'dataset' : 'datasets'}</span>
              {project.participant_count > 0 && (
                <span><strong className="text-mm-text">{project.participant_count}</strong> {project.participant_count === 1 ? 'participant' : 'participants'}</span>
              )}
              {/* Track J · Group A (#1): only surfaces on multi-coder projects — a
                  solo "1 coder" on every project would just be noise. */}
              {project.coder_count > 1 && (
                <span><strong className="text-mm-text">{project.coder_count}</strong> coders</span>
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
          } catch {
            toast.error('Export failed')
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
