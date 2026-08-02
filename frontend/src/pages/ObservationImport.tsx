import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronRight, FileInput, X, AlertTriangle, Film } from 'lucide-react'

import { observationsApi, mediaApi } from '@/lib/api'
import type { SegmentationMode, ClipPreviewResponse } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatBytes, countLabel } from '@/lib/format'
import { formatTimestamp } from '@/lib/utils'
import { openPickerFromZoneClick } from '@/lib/drop-zone'
import { consumePendingImportFiles } from '@/lib/pending-import-files'
import SourceKindPanel from '@/components/SourceKindPanel'
import {
  SEGMENTATION_FREEZE_REVERSIBLE,
  FROZEN_CONSEQUENCES,
  OPEN_CONSEQUENCES,
  FREEZE_BEFORE_YOU_DISTRIBUTE,
} from '@/lib/source-kind-copy'
import { validateMediaFile, describeMediaUploadError } from '@/lib/media-constants'
import {
  OBSERVATION_MEDIA_ACCEPT,
  OBSERVATION_MEDIA_FORMAT_LABEL,
  isSupportedObservationMedia,
  CUE_FILE_ACCEPT,
  CUE_FILE_FORMAT_LABEL,
  isSupportedCueFile,
} from '@/lib/observation-import-formats'

type Step = 'upload' | 'setup' | 'confirm' | 'results'

/**
 * `confirm` exists because the wizard used to commit blind (#638): it created,
 * attached and CUT in one click, so a cue file's clip count, its warnings, and
 * the MAX_CLIPS refusal all arrived only after the clips were written.
 *
 * It is skipped for `none` — there is nothing to preview when the answer is
 * "no clips" — so the progress rail legitimately jumps setup → results there.
 */
const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'setup', label: 'Set up clips' },
  { key: 'confirm', label: 'Confirm clips' },
  { key: 'results', label: 'Results' },
]

const MODES: { key: SegmentationMode; label: string; hint: string }[] = [
  {
    key: 'none',
    label: 'Start empty',
    hint: 'Mark clips yourself while watching — recommended for observational coding.',
  },
  {
    key: 'fixed_interval',
    label: 'Fixed intervals',
    hint: 'Slice the timeline into equal clips, for interval-style coding.',
  },
  {
    key: 'cue_list',
    label: 'From a cue file',
    hint: `Chapters or subtitles (${CUE_FILE_FORMAT_LABEL}) become labelled clips.`,
  },
]

export default function ObservationImport() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<SegmentationMode>('none')
  const [intervalSeconds, setIntervalSeconds] = useState(30)
  const [cueFile, setCueFile] = useState<File | null>(null)

  /** The browser's own measurement — the ONLY length source for a WebM. */
  const [duration, setDuration] = useState<number | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [previewUnplayable, setPreviewUnplayable] = useState(false)

  const [busy, setBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: number; name: string; created: number; warnings: string[] } | null>(null)

  /**
   * The observation once it exists on the server with its recording attached —
   * i.e. after the expensive part. Held across the confirm step so that going
   * Back, changing the interval and previewing again never re-uploads, and so a
   * failed preview leaves the recording banked rather than thrown away (#638).
   *
   * Abandoning here leaves an observation with a recording and no clips. That is
   * not a leak: it is exactly what "Start empty" produces, it appears in the
   * Observations list, and it is the state the researcher would have to be given
   * anyway if the cut failed.
   */
  const [staged, setStaged] = useState<{ id: number; name: string } | null>(null)
  const [preview, setPreview] = useState<ClipPreviewResponse | null>(null)

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cueInputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  /**
   * #543: an attach legitimately runs minutes-to-hours, and react-router keeps
   * `navigate` live after unmount — so an unguarded success YANKS the user out of
   * wherever they went, and an unguarded failure is SILENT (setState no-ops: no
   * card, no message, no retry).
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true   // StrictMode re-runs effects; reset after the dev unmount
    return () => { mountedRef.current = false }
  }, [])

  /**
   * A recording handed over from somewhere else — the Conversations importer's
   * "this belongs in an Observation" offer, or a media file dropped on a list
   * page. It arrives already staged, so taking the offer never costs a re-upload.
   *
   * Consume-once, and guarded by a run-once ref: StrictMode double-invokes the
   * effect, and the second run sees the already-consumed null. Pairing the
   * consume with an `else` would then clobber the freshly-seeded file (the
   * MergeProject lesson).
   */
  const handoffRef = useRef(false)
  useEffect(() => {
    if (handoffRef.current) return
    handoffRef.current = true
    const pending = consumePendingImportFiles('observation')
    const first = pending?.[0]
    if (first) chooseFile(first)
    // chooseFile is intentionally omitted: this must run exactly once, and it
    // reads only `name`, which is empty on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The object URL is created and revoked INSIDE an effect keyed on the file.
  // Doing it in the onChange handler leaks under StrictMode's double-invoke.
  useEffect(() => {
    if (!file) { setObjectUrl(null); return }
    const url = URL.createObjectURL(file)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Focus the step's heading on change. Otherwise the focused button unmounts,
  // focus falls to <body>, and the next Tab restarts from the top of the document
  // — the same failure class as a recycled virtualized row (#484).
  useEffect(() => { headingRef.current?.focus() }, [step])

  const stepIndex = STEPS.findIndex(s => s.key === step)

  // Mirrors `staged` for `chooseFile`, which must not take it as a dependency:
  // the handoff effect calls chooseFile exactly once and re-running on a staged
  // change would re-seed the file (the MergeProject lesson, one door over).
  const stagedRef = useRef<{ id: number; name: string } | null>(null)
  useEffect(() => { stagedRef.current = staged }, [staged])

  const chooseFile = useCallback((picked: File) => {
    const check = validateMediaFile(picked)
    if (!check.ok) { toast.error(check.error); return }

    // A DIFFERENT recording invalidates whatever is already staged — its media,
    // its duration and any preview built from them. Drop it server-side rather
    // than leaving a nameless observation holding the previous upload (#638).
    const prior = stagedRef.current
    if (prior) {
      stagedRef.current = null
      setStaged(null)
      setPreview(null)
      observationsApi.remove(projectId, prior.id).catch(() => {})
    }

    setFile(picked)
    setDuration(null)
    setPreviewUnplayable(false)
    if (!name.trim()) setName(picked.name.replace(/\.[^.]+$/, ''))
  }, [name, projectId])

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current++; setIsDragOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false) }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)
      const dropped = Array.from(e.dataTransfer.files).filter(f => isSupportedObservationMedia(f.name))
      if (dropped.length === 0) {
        toast.error(`That file isn't a recording we can read. Accepted: ${OBSERVATION_MEDIA_FORMAT_LABEL}`)
        return
      }
      chooseFile(dropped[0])
    },
  }

  /**
   * Do WE know how long this is? (A WebM with no duration header reports Infinity
   * in the browser until you seek, so a plain null-check is not enough.)
   *
   * This gates the CLIP ESTIMATE only — never the mode itself. The browser and the
   * server are different decoders, and the browser is the WEAKER one: it plays by
   * codec, while the backend reads the container (it walks moov/mvhd, so it knows
   * an H.264 .mp4's length perfectly well even where Chromium refuses to decode a
   * single frame of it). Disabling "fixed intervals" because the local preview
   * couldn't play would block an import the server can complete — and this is not
   * hypothetical: it is exactly what the live pass hit on a real NASA H.264 file.
   *
   * If the server genuinely cannot read the length either, it refuses with an
   * honest 400 that names the way out. That refusal is the gate; this is not.
   */
  const durationKnown = duration != null && Number.isFinite(duration) && duration > 0

  const segmentationRequest = () => ({
    mode,
    intervalSeconds: mode === 'fixed_interval' ? intervalSeconds : null,
    cueFile,
  })

  const invalidateObservationQueries = useCallback(() => {
    // AFTER the attach — a pre-attach invalidation would cache has_media=false
    // for the staleTime window (#543c).
    queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  }, [queryClient, projectId])

  /**
   * Put the recording on the server, then ask what cutting WOULD produce.
   *
   * The upload is the expensive, irreversible part, so it happens once and is
   * kept: a re-preview after changing the interval reuses `staged`, and a preview
   * that FAILS leaves the recording banked so the researcher can switch mode and
   * retry instead of re-uploading gigabytes.
   */
  async function handleStageAndPreview() {
    if (!file) return
    setBusy(true)
    setPreviewError(null)

    let observationId = staged?.id ?? null
    try {
      if (observationId === null) {
        // 1. Create the row — the recording needs an owner id to be stored under.
        const obs = await observationsApi.create(projectId, { name: name.trim() || file.name })
        observationId = obs.id

        // 2. Attach the recording. ONE upload, through the hardened media seam.
        //    The client's duration is passed as a hint: the server prefers its own
        //    probe, but for WebM it has no reader at all, so without this the
        //    timeline would have no length.
        await mediaApi.upload(projectId, 'observation', obs.id, file, duration)
        invalidateObservationQueries()
        if (!mountedRef.current) return
        setStaged({ id: obs.id, name: obs.name })
      }

      // "Start empty" has nothing to preview — commit straight through.
      if (mode === 'none') {
        await runCut(observationId)
        return
      }

      // 3. What WOULD the cut produce? Reads the length the server persisted, so
      //    this count is the count that lands — not a second measurement.
      const p = await observationsApi.previewSegmentation(projectId, observationId, segmentationRequest())
      if (!mountedRef.current) return
      setPreview(p)
      setStep('confirm')
    } catch (err) {
      const message = describeMediaUploadError(err)
      if (!mountedRef.current) {
        toast.error(`Import failed: ${message}`, { duration: 15000 })
        return
      }
      // Did the recording land? If so KEEP it — the researcher can change the
      // mode and try again without paying for the upload twice.
      if (observationId !== null) {
        const landed = await observationsApi.get(projectId, observationId).catch(() => null)
        if (landed?.has_media) {
          invalidateObservationQueries()
          if (!mountedRef.current) return
          setStaged({ id: landed.id, name: landed.name })
          setPreviewError(message)
          return
        }
        // The recording never landed, so the row is an empty shell. Remove it, or
        // three retries leave three nameless observations behind.
        await observationsApi.remove(projectId, observationId).catch(() => {})
        if (mountedRef.current) setStaged(null)
      }
      setPreviewError(message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  /** Write the clips. Separated so the confirm step commits nothing but this. */
  async function runCut(observationId: number) {
    const cut = await observationsApi.cutSegmentation(projectId, observationId, segmentationRequest())
    invalidateObservationQueries()

    if (!mountedRef.current) {
      // They navigated away mid-cut. Never yank them back; the warnings ride the
      // toast because they have no post-hoc home.
      toast.success(`"${cut.observation.name}" imported`, {
        description: cut.warnings.length
          ? cut.warnings.join(' ')
          : `${cut.created} clip(s) ready to code.`,
      })
      return
    }
    setResult({
      id: cut.observation.id,
      name: cut.observation.name,
      created: cut.created,
      warnings: cut.warnings,
    })
    setStep('results')
  }

  async function handleConfirmCut() {
    if (!staged) return
    setBusy(true)
    setPreviewError(null)
    try {
      await runCut(staged.id)
    } catch (err) {
      const message = describeMediaUploadError(err)
      if (!mountedRef.current) {
        toast.error(`Import failed: ${message}`, { duration: 15000 })
        return
      }
      // The recording is already banked and the preview already succeeded, so a
      // failure here is the cut alone. Land the observation empty and say why —
      // never discard a recording over a failed slice.
      setResult({
        id: staged.id,
        name: staged.name,
        created: 0,
        warnings: [
          `The recording uploaded fine, but the clips couldn't be cut: ${message}`,
          'The observation is ready — mark clips in the workbench.',
        ],
      })
      setStep('results')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
              stepIndex === i
                ? 'bg-mm-teal text-white'
                : stepIndex > i
                  ? 'bg-mm-teal/15 text-mm-teal-text'
                  : 'bg-mm-bg text-mm-text-faint',
            )}>
              <span className="sr-only">Step {i + 1} of {STEPS.length}: </span>
              <span aria-hidden>{i + 1}</span>
            </div>
            <span className="ml-2 text-sm font-medium">{s.label}</span>
            {i < STEPS.length - 1 && <ChevronRight className="w-4 h-4 mx-4 text-mm-text-faint" aria-hidden />}
          </div>
        ))}
      </nav>

      {step === 'upload' && <SourceKindPanel current="observation" projectId={projectId} />}

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle ref={headingRef} tabIndex={-1} className="outline-none">
              Upload a recording
            </CardTitle>
            <CardDescription>
              You’ll code this recording directly on its timeline — no transcript needed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                'rounded-lg border-2 border-dashed p-12 text-center transition-colors mb-4',
                isDragOver
                  ? 'border-mm-teal bg-mm-teal/5'
                  : 'border-mm-border-medium bg-mm-surface',
              )}
              onClick={e => openPickerFromZoneClick(e, () => fileInputRef.current?.click())}
              {...dragHandlers}
            >
              <Film className="w-12 h-12 mx-auto text-mm-text-faint mb-4" aria-hidden />
              <p className="text-sm text-mm-text-muted mb-1">
                Drag and drop a recording here, or click to browse
              </p>
              {/* The copy renders the module's label — an empty state promising one
                * format while the filter accepts six just relocates the lie (#552). */}
              <p className="text-xs text-mm-text-faint mb-4">{OBSERVATION_MEDIA_FORMAT_LABEL}</p>
              <Button onClick={() => fileInputRef.current?.click()}>Select recording</Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={OBSERVATION_MEDIA_ACCEPT}
                className="hidden"
                onChange={e => {
                  const picked = e.target.files?.[0]
                  if (picked) chooseFile(picked)
                  e.target.value = ''
                }}
              />
            </div>

            {file && (
              <div className="space-y-3 mb-6">
                <div className="flex items-center justify-between px-3 py-2 rounded-md bg-mm-bg text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-mm-text">{file.name}</span>
                    <span className="text-mm-text-faint shrink-0">{formatBytes(file.size)}</span>
                    {duration != null && Number.isFinite(duration) && (
                      <span className="text-mm-text-faint shrink-0 font-mono tabular-nums">
                        {formatTimestamp(duration)}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => { setFile(null); setDuration(null) }}
                    className="text-mm-text-faint hover:text-mm-text transition-colors ml-2"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>

                {/* Spot-check player. `preload="metadata"` matters: a blob URL for a
                  * multi-GB file would otherwise buffer aggressively. A codec the
                  * browser can't decode must NOT block the import — the backend
                  * accepts by container, which is broader than what Chrome plays. */}
                {objectUrl && !previewUnplayable && (
                  <video
                    src={objectUrl}
                    controls
                    preload="metadata"
                    className="w-full rounded-md bg-black max-h-64"
                    onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
                    onError={() => setPreviewUnplayable(true)}
                  />
                )}

                {/* A codec your browser can't decode is NOT a file we can't import:
                  * the backend accepts by CONTAINER (and reads the length out of the
                  * container), which is broader than what Chromium will play. So this
                  * is a note, never a blocker — and the Import button stays enabled. */}
                {previewUnplayable && (
                  <p className="text-xs text-mm-text-muted flex items-start gap-2 p-3 rounded-md bg-mm-bg">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                    <span>
                      Your browser can't preview this file's codec, so there's no spot-check
                      player here. It will still import and play in the workbench.
                    </span>
                  </p>
                )}

                <div>
                  <label htmlFor="obs-name" className="text-sm font-medium text-mm-text">
                    Name
                  </label>
                  <Input
                    id="obs-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Classroom Obs — Day 2"
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button disabled={!file} onClick={() => setStep('setup')}>Continue</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'setup' && (
        <Card>
          <CardHeader>
            <CardTitle ref={headingRef} tabIndex={-1} className="outline-none">
              Starting clips
            </CardTitle>
            <CardDescription>
              Clips stay fully editable in the workbench — this is a starting point, not a
              commitment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <fieldset>
              <legend className="sr-only">How should the timeline be cut into clips?</legend>
              <div className="space-y-2">
                {MODES.map(m => (
                  <label
                    key={m.key}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                      mode === m.key
                        ? 'border-mm-teal bg-mm-teal/5'
                        : 'border-mm-border bg-mm-surface hover:border-mm-border-strong',
                    )}
                  >
                    <input
                      type="radio"
                      name="segmentation-mode"
                      className="mt-1"
                      checked={mode === m.key}
                      onChange={() => setMode(m.key)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-mm-text">{m.label}</span>
                      <span className="block text-xs text-mm-text-muted mt-0.5">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {mode === 'fixed_interval' && (
              <div>
                <label htmlFor="obs-interval" className="text-sm font-medium text-mm-text">
                  Interval (seconds)
                </label>
                <Input
                  id="obs-interval"
                  type="number"
                  min={1}
                  value={intervalSeconds}
                  onChange={e => setIntervalSeconds(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 max-w-[10rem]"
                />
                {/* A local ESTIMATE, and now labelled as one. It divides the
                    BROWSER's duration, while the cut divides the server's — two
                    measurements, which is why the exact figure comes from the
                    confirm step and this only has to be roughly right (#638). */}
                <p className="text-xs text-mm-text-muted mt-1" role="status" aria-live="polite">
                  {durationKnown && intervalSeconds >= 1
                    ? `Roughly ${Math.ceil(duration! / intervalSeconds).toLocaleString()} clips — you'll see the exact cut before anything is created.`
                    // We couldn't measure it locally (the browser can't decode every
                    // format it can upload). The server reads the container itself and
                    // will say so if it can't.
                    : "We'll work out the number of clips from the recording once it uploads, and show you before anything is created."}
                </p>
              </div>
            )}

            {mode === 'cue_list' && (
              <div>
                <span className="text-sm font-medium text-mm-text">Cue file</span>
                <div
                  className="mt-1 rounded-lg border-2 border-dashed border-mm-border-medium bg-mm-surface p-6 text-center"
                  onClick={e => openPickerFromZoneClick(e, () => cueInputRef.current?.click())}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => {
                    e.preventDefault()
                    const picked = Array.from(e.dataTransfer.files).find(f => isSupportedCueFile(f.name))
                    if (picked) setCueFile(picked)
                    else toast.error(`A cue file must be ${CUE_FILE_FORMAT_LABEL}.`)
                  }}
                >
                  {cueFile ? (
                    <div className="flex items-center justify-center gap-2 text-sm">
                      <span className="truncate text-mm-text">{cueFile.name}</span>
                      <button
                        onClick={() => setCueFile(null)}
                        className="text-mm-text-faint hover:text-mm-text"
                        aria-label={`Remove ${cueFile.name}`}
                      >
                        <X className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    </div>
                  ) : (
                    <>
                      <FileInput className="w-8 h-8 mx-auto text-mm-text-faint mb-2" aria-hidden />
                      <p className="text-xs text-mm-text-faint mb-3">{CUE_FILE_FORMAT_LABEL}</p>
                      <Button variant="outline" onClick={() => cueInputRef.current?.click()}>
                        Select cue file
                      </Button>
                    </>
                  )}
                  <input
                    ref={cueInputRef}
                    type="file"
                    accept={CUE_FILE_ACCEPT}
                    className="hidden"
                    onChange={e => {
                      const picked = e.target.files?.[0]
                      if (picked) setCueFile(picked)
                      e.target.value = ''
                    }}
                  />
                </div>
              </div>
            )}

            {previewError && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 text-sm">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
                <span className="text-mm-text">{previewError}</span>
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('upload')} disabled={busy}>
                Back
              </Button>
              <Button
                onClick={handleStageAndPreview}
                disabled={busy || (mode === 'cue_list' && !cueFile)}
              >
                {busy
                  ? (staged ? 'Working out the clips…' : 'Uploading recording…')
                  : (mode === 'none' ? 'Create observation' : 'Preview clips')}
              </Button>
            </div>

            {busy && (
              <p className="text-xs text-mm-text-muted text-center" role="status" aria-live="polite">
                Uploading {file ? formatBytes(file.size) : 'the recording'} — large recordings can
                take a while. Keep this tab open, or we'll let you know when it finishes.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'confirm' && preview && (
        <Card>
          <CardHeader>
            <CardTitle ref={headingRef} tabIndex={-1} className="outline-none">
              {countLabel(preview.total_segments, 'clip', 'clips')} from this recording
            </CardTitle>
            <CardDescription>
              Nothing has been cut yet. The recording is uploaded and this is what
              cutting would produce — read from the length the server measured, so
              this count is the count that lands.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* The warnings are the reason this step earns its click. A cue file
              * that names speakers is a TRANSCRIPT, and the backend says so here —
              * which is only useful while "import it as a Conversation instead" is
              * still a choice. Post-cut it was a reproach. */}
            {preview.warnings.length > 0 && (
              <div className="space-y-2">
                {preview.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
                    <span className="text-mm-text">{w}</span>
                  </div>
                ))}
              </div>
            )}

            {preview.segments.length > 0 && (
              <div>
                <ul className="divide-y divide-mm-border rounded-md border border-mm-border overflow-hidden">
                  {preview.segments.map(c => (
                    <li key={c.sequence_order} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                      <span className="font-mono text-xs text-mm-text-muted shrink-0 tabular-nums">
                        {formatTimestamp(c.start_time)}–{formatTimestamp(c.end_time)}
                      </span>
                      <span className="truncate text-mm-text">{c.label}</span>
                    </li>
                  ))}
                </ul>
                {/* `segments` is only a head — never imply the list is the whole cut. */}
                {preview.total_segments > preview.segments.length && (
                  <p className="text-xs text-mm-text-muted mt-1.5">
                    Showing the first {preview.segments.length} of{' '}
                    {preview.total_segments.toLocaleString()}.
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-mm-text-muted">
              Clips stay fully editable in the workbench — split, merge, retime or
              delete them at any point.
            </p>

            {previewError && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 text-sm">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
                <span className="text-mm-text">{previewError}</span>
              </div>
            )}

            <div className="flex justify-between">
              {/* Back keeps the recording staged — changing the interval and
                * previewing again must never re-upload. */}
              <Button variant="outline" onClick={() => setStep('setup')} disabled={busy}>
                Back
              </Button>
              <Button onClick={handleConfirmCut} disabled={busy}>
                {busy ? 'Cutting clips…' : `Cut ${countLabel(preview.total_segments, 'clip', 'clips')}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'results' && result && (
        <Card>
          <CardHeader>
            <CardTitle ref={headingRef} tabIndex={-1} className="outline-none">
              "{result.name}" is ready
            </CardTitle>
            <CardDescription>
              {result.created > 0
                ? `${result.created} clip(s) created. Open the observation to start coding.`
                : 'No starting clips — mark them in the workbench while you watch.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.warnings.length > 0 && (
              <div className="space-y-2">
                {result.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
                    <span className="text-mm-text">{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* D20 — the freeze is a PREVIEW here, never a control.
              *
              * The decision is real and it shapes the whole reliability posture, but
              * it cannot be made yet: freezing a "start empty" observation would
              * freeze zero clips. So we name the question where it is next
              * actionable, and the workbench carries the act. The wording is the
              * same module the Reliability tab will read, so the two cannot drift. */}
            {/* #668 — this block is a HEADS-UP, never a choice, and it has to
              * READ that way. It used to pose the freeze QUESTION and
              * list "Frozen — …" / "Open — …" as two bullets, directly above two
              * buttons one of which said "Open observation". The list read as
              * the options and the buttons read as the answer, so the primary
              * CTA looked like picking "Open" — the word doing double duty as
              * the verb (open it) and the state (open cuts).
              *
              * The fix is a statement, not a question, and a CTA that names the
              * act rather than a state: "Start coding". The pre-distribution
              * warning stays — it is the reason D20 puts this here at all. */}
            <div className="rounded-lg border border-mm-border bg-mm-bg p-3">
              <h3 className="text-sm font-medium text-mm-text">
                One decision waits for you in the workbench
              </h3>
              <p className="text-xs text-mm-text-muted mt-1">
                Once your clips are cut you&apos;ll choose whether to <strong>freeze</strong> them,
                and that choice shapes how agreement is measured.
              </p>
              <ul className="mt-2 space-y-1.5">
                <li className="text-xs text-mm-text-muted">{FROZEN_CONSEQUENCES}</li>
                <li className="text-xs text-mm-text-muted">{OPEN_CONSEQUENCES}</li>
              </ul>
              <p className="text-xs text-mm-text-faint mt-2">
                {SEGMENTATION_FREEZE_REVERSIBLE} {FREEZE_BEFORE_YOU_DISTRIBUTE}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/observations`)}>
                All observations
              </Button>
              <Button onClick={() => navigate(`/projects/${projectId}/observations/${result.id}`)}>
                Start coding
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
