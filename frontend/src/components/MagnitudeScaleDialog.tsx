import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { codesApi, serverDetailMessage, type Code } from '@/lib/api'
import { MAX_TICKS, isTickable, type MagnitudeAnchor, type MagnitudeScale } from '@/lib/magnitude'

/**
 * Declare a code's rating scale (#35) — the authoring half of the instrument.
 *
 * Deliberately modelled on the Variables view's *Value labels & missing values*
 * section rather than invented: declaring a magnitude scale and declaring a
 * variable's value labels are the SAME ACT, so the researcher meets one
 * vocabulary — a range, and labels for the points that need them.
 *
 * ⚠️ **The server is the authority and its refusals are surfaced verbatim.** It
 * refuses a narrowing that would strand existing ratings, naming the count; there
 * is no client mirror of that check, because the client cannot see every rating
 * (the segment cache is one conversation, the ratings span the project). A local
 * pre-check would be confidently wrong on exactly the projects that have data.
 */

interface Props {
  projectId: number
  code: Code
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface DraftAnchor { value: string; label: string }

export default function MagnitudeScaleDialog({ projectId, code, open, onOpenChange }: Props) {
  const existing = code.magnitude_scale ?? null
  const queryClient = useQueryClient()

  const [min, setMin] = useState(existing ? String(existing.min) : '0')
  const [max, setMax] = useState(existing ? String(existing.max) : '10')
  const [step, setStep] = useState(existing ? String(existing.step) : '1')
  const [anchors, setAnchors] = useState<DraftAnchor[]>(
    existing?.anchors.map(a => ({ value: String(a.value), label: a.label })) ?? [],
  )

  const save = useMutation({
    mutationFn: (scale: MagnitudeScale | null) =>
      codesApi.setMagnitudeScale(projectId, code.id, scale),
    onSuccess: (_c, scale) => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      onOpenChange(false)
      toast(scale ? `Rating scale set for "${code.name}"` : `Rating scale cleared for "${code.name}"`)
    },
    onError: (e: unknown) => {
      // The stranding refusal is the message that matters most — it names how many
      // ratings a narrowing would orphan, which the researcher needs in order to
      // decide. Surface the server's own words rather than a generic failure.
      toast.error(serverDetailMessage(e) ?? 'Could not save the rating scale')
    },
  })

  const nMin = Number(min)
  const nMax = Number(max)
  const nStep = Number(step)
  const boundsValid =
    Number.isFinite(nMin) && Number.isFinite(nMax) && Number.isFinite(nStep) &&
    nMax > nMin && nStep > 0 && nStep <= nMax - nMin

  const draftScale: MagnitudeScale | null = boundsValid
    ? {
        min: nMin,
        max: nMax,
        step: nStep,
        anchors: anchors
          .filter(a => a.label.trim() && Number.isFinite(Number(a.value)))
          .map<MagnitudeAnchor>(a => ({ value: Number(a.value), label: a.label.trim() })),
      }
    : null

  // Mirrors the strip's own branch so the researcher learns the consequence while
  // declaring, not after: past this density the control becomes a number input.
  const willTick = draftScale ? isTickable(draftScale) : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Rating scale — {code.name}</DialogTitle>
          <DialogDescription>
            Let coders rate how much each segment has this characteristic. Give the
            scale a range, and label the points that need explaining — those labels
            are what make one coder's 3 mean the same as another's.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-mm-text-secondary">
            Minimum
            <Input value={min} onChange={e => setMin(e.target.value)} inputMode="decimal" className="mt-1 font-mono" />
          </label>
          <label className="text-xs text-mm-text-secondary">
            Maximum
            <Input value={max} onChange={e => setMax(e.target.value)} inputMode="decimal" className="mt-1 font-mono" />
          </label>
          <label className="text-xs text-mm-text-secondary">
            Step
            <Input value={step} onChange={e => setStep(e.target.value)} inputMode="decimal" className="mt-1 font-mono" />
          </label>
        </div>

        {!boundsValid && (
          <p className="text-xs text-mm-amber">
            The maximum must be greater than the minimum, and the step must fit inside the range.
          </p>
        )}
        {boundsValid && !willTick && (
          <p className="text-xs text-mm-text-muted">
            That is more than {MAX_TICKS} points, so coders will type a number instead
            of picking from a row of buttons.
          </p>
        )}

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium">Anchor labels</span>
            <Button
              type="button" variant="ghost" size="sm"
              onClick={() => setAnchors(a => [...a, { value: '', label: '' }])}
            >
              <Plus className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
              Add anchor
            </Button>
          </div>
          {anchors.length === 0 ? (
            <p className="text-xs text-mm-text-muted">
              None yet. Labelling at least the two ends is what turns a number into
              an instrument.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {anchors.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={a.value}
                    onChange={e => setAnchors(list => list.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                    inputMode="decimal"
                    aria-label={`Anchor ${i + 1} value`}
                    className="w-20 font-mono"
                  />
                  <Input
                    value={a.label}
                    onChange={e => setAnchors(list => list.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                    aria-label={`Anchor ${i + 1} label`}
                    placeholder="e.g. not a factor"
                    className="flex-1 min-w-0"
                  />
                  <Button
                    type="button" variant="ghost" size="sm"
                    aria-label={`Remove anchor ${i + 1}`}
                    onClick={() => setAnchors(list => list.filter((_, j) => j !== i))}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {/*
            Clearing is offered beside saving, not hidden, because it is safe: the
            server KEEPS every rating and they simply stop being interpretable
            until a scale returns. The destructive edit is a NARROWING, and that is
            the one the server refuses.
          */}
          {existing && (
            <Button
              type="button" variant="ghost"
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
            >
              Remove scale
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => draftScale && save.mutate(draftScale)}
              disabled={!draftScale || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save scale'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
