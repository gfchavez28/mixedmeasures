export interface PreviewData {
  headers: string[]
  sample_rows: Record<string, string>[]
  total_rows: number
  unique_speakers: string[]
  detected_columns: Record<string, string>
  unique_values_by_column: Record<string, string[]>
}

export interface SpeakerMapping {
  original_label: string
  normalized_name: string
  is_facilitator: boolean
  color_index: number
  color?: string | null
}

// Threshold for warning about too many unique speaker values
export const SPEAKER_COUNT_WARNING_THRESHOLD = 25

// Colors for column mapping highlights
export const COLUMN_COLORS: Record<string, { bg: string; bgLight: string; text: string; label: string }> = {
  speaker: { bg: 'bg-orange-100 dark:bg-orange-900/40', bgLight: 'bg-orange-50 dark:bg-orange-900/20', text: 'text-orange-800 dark:text-orange-300', label: 'Speaker' },
  text: { bg: 'bg-emerald-100 dark:bg-emerald-900/40', bgLight: 'bg-emerald-50 dark:bg-emerald-900/20', text: 'text-emerald-800 dark:text-emerald-300', label: 'Text' },
  start_time: { bg: 'bg-sky-100 dark:bg-sky-900/40', bgLight: 'bg-sky-50 dark:bg-sky-900/20', text: 'text-sky-800 dark:text-sky-300', label: 'Start Time' },
  end_time: { bg: 'bg-violet-100 dark:bg-violet-900/40', bgLight: 'bg-violet-50 dark:bg-violet-900/20', text: 'text-violet-800 dark:text-violet-300', label: 'End Time' },
}

// Speaker color palettes for visual distinction (subtle tint — Issue 208)
export const PARTICIPANT_COLORS = [
  'bg-orange-50/50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800',
  'bg-orange-50/60 border-orange-200 dark:bg-orange-950/25 dark:border-orange-800',
  'bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800',
  'bg-amber-50/60 border-amber-200 dark:bg-amber-950/25 dark:border-amber-800',
  'bg-rose-50/50 border-rose-200 dark:bg-rose-950/20 dark:border-rose-800',
  'bg-rose-50/60 border-rose-200 dark:bg-rose-950/25 dark:border-rose-800',
  'bg-red-50/50 border-red-200 dark:bg-red-950/20 dark:border-red-800',
  'bg-orange-50/60 border-orange-200 dark:bg-orange-950/25 dark:border-orange-800',
  'bg-amber-50/60 border-amber-200 dark:bg-amber-950/25 dark:border-amber-800',
  'bg-rose-50/60 border-rose-200 dark:bg-rose-950/25 dark:border-rose-800',
]

export const FACILITATOR_COLORS = [
  'bg-purple-50/50 border-purple-200 dark:bg-purple-950/20 dark:border-purple-800',
  'bg-purple-50/60 border-purple-200 dark:bg-purple-950/25 dark:border-purple-800',
  'bg-violet-50/50 border-violet-200 dark:bg-violet-950/20 dark:border-violet-800',
  'bg-violet-50/60 border-violet-200 dark:bg-violet-950/25 dark:border-violet-800',
  'bg-fuchsia-50/50 border-fuchsia-200 dark:bg-fuchsia-950/20 dark:border-fuchsia-800',
]

// Get speaker color class based on color_index and is_facilitator status
export function getSpeakerColorClass(colorIndex: number, isFacilitator: boolean): string {
  const palette = isFacilitator ? FACILITATOR_COLORS : PARTICIPANT_COLORS
  return palette[colorIndex % palette.length]
}

/** Placeholder shown for a participant/speaker that has no real name. */
export const UNNAMED_LABEL = '(Unnamed)'

/**
 * A name that is empty, whitespace-only, or made entirely of punctuation
 * (e.g. an unnamed focus-group speaker imported as "...") is treated as
 * "no name". Used to swap dots/blanks for a clear placeholder + neutral
 * avatar glyph instead of rendering literal "..." / "..".  (#396)
 */
export function isUnnamedLabel(name: string | null | undefined): boolean {
  if (!name) return true
  return !/[\p{L}\p{N}]/u.test(name)
}

// Generate initials from speaker name (e.g., "John Doe" → "JD", "Alice" → "AL").
// Unnamed names (empty / whitespace / punctuation-only) yield a neutral "–".
export function getSpeakerInitials(name: string | null | undefined): string {
  if (isUnnamedLabel(name)) return '–'

  const words = name!.trim().split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return '–'

  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  } else if (words[0].length >= 2) {
    return words[0].slice(0, 2).toUpperCase()
  } else {
    return words[0].toUpperCase().padEnd(2, '?')
  }
}

// Get initials badge colors based on speaker role
export function getInitialsBadgeColors(isFacilitator: boolean): string {
  return isFacilitator
    ? 'bg-purple-200 text-purple-800 ring-purple-300 dark:bg-purple-800 dark:text-purple-200 dark:ring-purple-700'
    : 'bg-orange-200 text-orange-800 ring-orange-300 dark:bg-orange-800 dark:text-orange-200 dark:ring-orange-700'
}

// A participant is "orphaned" when no live source references it — every
// conversation/dataset it appeared in was deleted. Participants are
// project-scoped and intentionally survive source deletion (shared
// cross-source identity), so these accumulate until manually removed.
// Structurally typed so this stays import-cycle-free.
export function isOrphanedParticipant(
  p: { linked_speakers: unknown[]; dataset_rows: unknown[] }
): boolean {
  return p.linked_speakers.length === 0 && p.dataset_rows.length === 0
}

// Generate conversation name from participant (non-facilitator) names
export function generateParticipantName(
  mappings: SpeakerMapping[],
  existingNames: string[]
): string {
  const participants = mappings
    .filter(m => !m.is_facilitator)
    .map(m => m.normalized_name.trim())
    .filter(n => n.length > 0)

  if (participants.length === 0) return ''

  let baseName: string
  if (participants.length === 1) {
    baseName = participants[0]
  } else if (participants.length === 2) {
    baseName = `${participants[0]} & ${participants[1]}`
  } else {
    const last = participants[participants.length - 1]
    const rest = participants.slice(0, -1)
    baseName = `Group (${rest.join(', ')}, & ${last})`
  }

  // Handle duplicate names with (1), (2) suffixes
  const lowerNames = existingNames.map(n => n.toLowerCase())
  if (!lowerNames.includes(baseName.toLowerCase())) return baseName

  let counter = 1
  while (lowerNames.includes(`${baseName} (${counter})`.toLowerCase())) {
    counter++
  }
  return `${baseName} (${counter})`
}

// #410: sync participant-derived auto-names into the VISIBLE name fields.
// Called live while the user is on the Speakers step so the field always
// shows exactly the name that will be imported — names the user has manually
// edited (userEditedIndices) are never touched, and a file with no derivable
// participant name keeps its current (filename-derived) value. Returns the
// input array identity when nothing changed so React state stays stable.
export function syncAutoNames(
  names: string[],
  mappingsPerFile: SpeakerMapping[][],
  existingNames: string[],
  userEditedIndices: Set<number>,
): string[] {
  const next = [...names]
  const taken = [...existingNames]
  let changed = false
  for (let i = 0; i < next.length; i++) {
    if (!userEditedIndices.has(i)) {
      const autoName = generateParticipantName(mappingsPerFile[i] ?? [], taken)
      if (autoName && autoName !== next[i]) {
        next[i] = autoName
        changed = true
      }
    }
    taken.push(next[i])
  }
  return changed ? next : names
}

// Extract speaker mappings from a preview result
export function extractSpeakerMappings(
  preview: PreviewData,
  speakerCol: string
): SpeakerMapping[] {
  const speakerValues = speakerCol && preview.unique_values_by_column
    ? preview.unique_values_by_column[speakerCol] || []
    : preview.unique_speakers

  return speakerValues.map((speaker: string, index: number) => ({
    original_label: speaker,
    normalized_name: speaker,
    is_facilitator: speaker.toLowerCase().includes('interviewer') || speaker.toLowerCase().includes('facilitator'),
    color_index: index,
  }))
}
