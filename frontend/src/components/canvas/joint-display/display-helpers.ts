/**
 * The joint display's small pure helpers that its components share — dates, the drift stamp
 * and a pin's attribution line. Kept out of the component files so fast refresh stays whole.
 */
import type { JointDisplayPinFact, JointDisplayRowResult } from '@/lib/api'
import { rowCells, type JointDisplay, type JointDisplayPin, type JointDisplayRowBaseline } from '@/lib/joint-display'
import { fingerprintJointDisplayRow } from '../figure-baseline'
import { SERVER_VOCABULARY as V, surveyAnswerSourceText } from '@/lib/joint-display-vocabulary'

export function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "12 Nov 2026" from a stored YYYY-MM-DD — read as a CALENDAR date, never through UTC (#408). */
export function formatWrittenDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  if (!m) return ''
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The baseline a row takes when its meta-inference is saved or its new numbers accepted (D168.5). */
export function stampBaseline(result: JointDisplayRowResult): JointDisplayRowBaseline {
  const cells = rowCells(result)
  return { hash: fingerprintJointDisplayRow(cells).hash, cells, stamped_at: todayIso() }
}

/**
 * A pin's attribution line (D163.4), from the display's setting and the quote's LIVE facts —
 * never from anything stored on the pin. '' for a pin whose quote a withdrawal removed (its
 * `excerptId` is null and its words already blanked); a quote no longer found says so.
 */
export function pinAttribution(
  pin: JointDisplayPin,
  fact: JointDisplayPinFact | undefined,
  attribution: JointDisplay['attribution'],
): string {
  if (pin.excerptId == null) return ''
  if (!fact) return 'This quote is no longer in the project.'
  // Joint display slice 2 (R8, r4-4): an answer's source says it is a survey answer.
  const source = fact.source_kind === V.PIN_SOURCE_ANSWER ? surveyAnswerSourceText(fact.source_name) : fact.source_name
  let who = ''
  switch (attribution.label) {
    case 'participant': who = fact.participant_identifier ?? fact.speaker_label ?? source; break
    case 'speaker': who = fact.speaker_label ?? source; break
    case 'source': who = source; break
    case 'none': who = ''; break
  }
  const parts: (string | null)[] = [who, attribution.column_id != null ? fact.column_value : null]
  if ((attribution.label === 'participant' || attribution.label === 'speaker') && who !== source) {
    parts.push(source)
  }
  return parts.filter(Boolean).join(' · ')
}
