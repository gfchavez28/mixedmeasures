/**
 * #1527 (D84, D86, 1.5.9) — the co-occurrence CSV's door sends the request the figure
 * sends: a source list whenever it is PRESENT (`''` is "none of this kind"), the question
 * selection, and the level.
 *
 * Until 1.5.9 the door dropped a falsy list, so `''` never left the browser and one
 * selected interview counted every document and clip in the file; it sent no
 * `text_column_ids` and no `level` at all, so the file was always the unit-level matrix
 * over every question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { downloadFromApi } = vi.hoisted(() => ({ downloadFromApi: vi.fn(() => Promise.resolve()) }))
vi.mock('./download', () => ({ downloadFromApi, EXPORT_TIMEOUT_MS: 900_000 }))

import { exportApi } from './export'

function sentQuery(): URLSearchParams {
  const url = (downloadFromApi.mock.calls[0] as unknown as [string])[0]
  return new URLSearchParams(url.split('?')[1] ?? '')
}

beforeEach(() => downloadFromApi.mockClear())

describe('exportApi.codeCooccurrence', () => {
  it('sends an empty source kind as empty, never drops it', async () => {
    await exportApi.codeCooccurrence(3, {
      conversation_ids: '7', document_ids: '', observation_ids: '', text_column_ids: '',
      source: 'all',
    })
    const q = sentQuery()
    expect(q.get('conversation_ids')).toBe('7')
    for (const key of ['document_ids', 'observation_ids', 'text_column_ids']) {
      expect(q.has(key)).toBe(true)
      expect(q.get(key)).toBe('')
    }
  })

  it('sends no source list when none is given (every source)', async () => {
    await exportApi.codeCooccurrence(3, { source: 'all' })
    const q = sentQuery()
    for (const key of ['conversation_ids', 'document_ids', 'observation_ids', 'text_column_ids']) {
      expect(q.has(key)).toBe(false)
    }
  })

  it('sends the question selection and the level', async () => {
    await exportApi.codeCooccurrence(3, { text_column_ids: '4,5', level: 'source', source: 'text' })
    const q = sentQuery()
    expect(q.get('text_column_ids')).toBe('4,5')
    expect(q.get('level')).toBe('source')
  })
})
