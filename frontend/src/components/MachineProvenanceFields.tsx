import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  ACCESS_NOT_RECORDED, MACHINE_ACCESS_KINDS, MACHINE_ACCESS_LABEL, accessChoice, accessFromChoice,
  droppedWithoutModel, unreadableParameters, type MachineProvenanceDraft,
} from '@/lib/machine-coder'

/** The form's values — `lib/machine-coder.ts::MachineProvenanceDraft`, which
 * `provenanceFromDraft` turns into what is sent. */
export type MachineProvenanceValues = MachineProvenanceDraft

/**
 * The four fields that record what produced a machine coder's labels — model,
 * how it was reached, settings, prompt (queue row 49, STRATEGY's question 3).
 *
 * 🔴 **ONE copy, used by the coding import AND the machine-coder dialog.** They
 * were two hand-written copies that had drifted in what they showed (the
 * settings example differed) and shared two defects: a hand-rolled `<textarea>`
 * on a darker fill with no focus ring — it read as disabled — and an example
 * model name that looked like a filled-in value, so a researcher could leave the
 * field blank believing it recorded.
 *
 * ⚠️ **Examples carry `e.g.`**, the convention every other placeholder here uses
 * (`e.g., Participant 001`). A placeholder is never the NAME — each field has a
 * real `<Label htmlFor>` (#905).
 *
 * ⚠️ `idPrefix` must be a valid id fragment (no spaces). The import passes a
 * `useId`-derived prefix, never a coder name typed into a file.
 */
export default function MachineProvenanceFields({
  idPrefix, values, onChange,
}: {
  idPrefix: string
  values: MachineProvenanceValues
  onChange: (patch: Partial<MachineProvenanceValues>) => void
}) {
  const modelHintId = `${idPrefix}-model-hint`
  const paramsHintId = `${idPrefix}-params-hint`
  const paramsWarnId = `${idPrefix}-params-unreadable`
  const unreadable = unreadableParameters(values.parameters)
  const dropped = droppedWithoutModel(values)
  const droppedId = `${idPrefix}-model-dropped`
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-model`}>Model</Label>
          <Input
            id={`${idPrefix}-model`}
            placeholder="e.g. gpt-4o-2024-08-06"
            aria-describedby={dropped.length ? `${modelHintId} ${droppedId}` : modelHintId}
            value={values.model}
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <p id={modelHintId} className="text-xs text-mm-text-muted">
            The exact version if you have it. Left blank, the configuration is
            recorded as not known.
          </p>
          {/* #1038 h — a blank model sends NO configuration (the server refuses a
              setting of nothing), so what else was filled in is dropped. Said
              here, beside the empty field, for the reason the unreadable-settings
              line below is: forgiving must not mean silent. Described, not live. */}
          {dropped.length > 0 && (
            <p id={droppedId} className="text-xs text-amber-700 dark:text-amber-300">
              Without a model, {joinList(dropped)} will not be recorded.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-access`}>How it was reached</Label>
          {/* 🔴 #1006 — *Not recorded* is a CHOICE, not only the placeholder. It
              was the placeholder alone, so once a kind was picked nothing could
              put it back — and the configuration FREEZES once the coder has coded,
              so a mis-click at import time became a permanent claim about how the
              model was reached, on the form that exists to record that truthfully.
              The only other exit, *Other*, asserts something different again. */}
          <Select
            value={accessChoice(values.access)}
            onValueChange={(v) => onChange({ access: accessFromChoice(v) })}
          >
            <SelectTrigger id={`${idPrefix}-access`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ACCESS_NOT_RECORDED}>Not recorded</SelectItem>
              {MACHINE_ACCESS_KINDS.map(kind => (
                <SelectItem key={kind} value={kind}>{MACHINE_ACCESS_LABEL[kind]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-params`}>Settings</Label>
        {/* 🔴 MULTI-LINE on purpose. Settings are pasted from config files, and a
            single-line <input> DELETES pasted line breaks (the value-sanitization
            algorithm), so `temperature=0⏎top_p=1` arrived as the one setting
            `temperature = "0top_p=1"`, silently. */}
        <Textarea
          id={`${idPrefix}-params`}
          rows={2}
          placeholder="e.g. temperature=0, top_p=1, seed=42"
          aria-describedby={unreadable.length ? `${paramsHintId} ${paramsWarnId}` : paramsHintId}
          value={values.parameters}
          onChange={(e) => onChange({ parameters: e.target.value })}
        />
        <p id={paramsHintId} className="text-xs text-mm-text-muted">
          One per <code>name=value</code>, separated by commas or new lines. A
          value holding a comma goes in quotes or brackets, e.g.{' '}
          <code>stop=["END", "###"]</code>.
        </p>
        {/* Described, NOT a live region: it changes on every keystroke, and an
            alert per character would drown the field. It is read when the
            field is focused and is on screen beside it. */}
        {unreadable.length > 0 && (
          <p id={paramsWarnId} className="text-xs text-amber-700 dark:text-amber-300">
            Will not be recorded: {unreadable.map(u => `“${u}”`).join(', ')} — write
            each as <code>name=value</code>, and quote a value that holds a comma.
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-prompt`}>Prompt</Label>
        <Textarea
          id={`${idPrefix}-prompt`}
          rows={4}
          placeholder="The instructions the model was given."
          value={values.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </div>
    </div>
  )
}

/** `['a']` → `a`, `['a','b']` → `a and b`, `['a','b','c']` → `a, b and c`. */
function joinList(items: string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
