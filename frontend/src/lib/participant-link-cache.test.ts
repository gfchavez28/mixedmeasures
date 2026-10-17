/**
 * #1054 review §4 #5 — every door that links or unlinks a record refreshes ONE set.
 *
 * Six doors (the Participants panel's link and unlink, the grid's link cell, Link
 * by column, the dataset import and the append) had each grown their own
 * invalidation list; none refreshed the record picker, so the record just linked
 * was offered to the next person and picking it answered 409.
 *
 * #1152 — two more doors refreshed the participant LIST alone: a document's
 * subject (Documents page) and the speakers a conversation import links. After
 * either, the panel and the withdrawal report said the person was linked to
 * nothing (reproduced live). They are doors now: the subject is sent through its
 * own named request (`documentsApi.setSubject`; `update` no longer takes the
 * field) and the import is recognised by its request.
 *
 * The doors are DERIVED — every file that sends a linking request or reads an
 * import's `participant_link_report` — so a ninth is held to the helper the day
 * it is written.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import { stripComments } from '@/lib/strip-comments'
import { SOURCE_SCAN_TIMEOUT_MS, SRC_DIR, sourceFiles } from '@/test-support/source-tree'
import { invalidateAfterParticipantLinkChange } from './participant-link-cache'

const LINK_DOOR = /\b(linkDatasetRow|unlinkDatasetRow|linkParticipant|linkByColumn|bulkLinkParticipants|setSubject)\(|\bconversationsApi\.import\(|\.participant_link_report\b|\.linkReport\)/

const doors = sourceFiles({ ext: 'tsx', floor: 250 })
  .map(file => ({ file: relative(SRC_DIR, file), src: stripComments(readFileSync(file, 'utf8'), file) }))
  .filter(({ src }) => LINK_DOOR.test(src))

describe('#1054 — one refresh after any participant-link change', () => {
  it('refreshes the picker, the participant reads, the counts and every dataset read', async () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined)
    await invalidateAfterParticipantLinkChange(qc, 7)
    const keys = spy.mock.calls.map(([f]) => (f as { queryKey?: unknown[] }).queryKey).filter(Boolean)
    expect(keys).toEqual(expect.arrayContaining([
      ['participants', 7], ['withdrawal-report', 7], ['linkable-rows', 7],
      ['project', 7], ['project-summary', 7], ['projects'], ['participant-detail'],
      // #1152 — the documents door refreshed this by hand; routing it here must
      // not lose it.
      ['qual-source-frequencies', 7],
    ]))
    const predicate = spy.mock.calls
      .map(([f]) => (f as { predicate?: (q: { queryKey: unknown[] }) => boolean }).predicate)
      .find(Boolean)!
    expect(predicate({ queryKey: ['dataset-data', 7, 2] })).toBe(true)
    expect(predicate({ queryKey: ['datasets', 7] })).toBe(true)
    expect(predicate({ queryKey: ['codes', 7] })).toBe(false)
  })

  it('finds the known doors (the scan can see)', () => {
    expect(doors.map(d => d.file).sort()).toEqual(expect.arrayContaining([
      'components/LinkByColumnDialog.tsx',
      'pages/AppendImport.tsx',
      'pages/ConversationImport.tsx',
      'pages/DatasetImport.tsx',
      'pages/DatasetView.tsx',
      'pages/DocumentsListPage.tsx',
      'pages/ParticipantsPage.tsx',
    ]))
  }, SOURCE_SCAN_TIMEOUT_MS)

  it.each(doors.map(d => [d.file, d.src]))('%s refreshes through the shared helper', (_, src) => {
    expect(src).toContain('invalidateAfterParticipantLinkChange(')
  })

  it('PREDICATE FALSIFIER: the scan recognises each kind of door', () => {
    for (const planted of [
      'participantsApi.linkDatasetRow(1, 2, 3, 4)',
      'datasetsApi.linkByColumn(1, 2, 3)',
      'if (result.participant_link_report) {}',
      'results.some(r => r.linkReport)',
      'documentsApi.setSubject(1, 12, 7)',
      'await conversationsApi.import(id, files[0], { name })',
    ]) expect(planted).toMatch(LINK_DOOR)
    for (const nearMiss of [
      'datasetsApi.previewLinkByColumn(1, 2, 3)',
      // A rename is not a link, and cannot carry a subject any more.
      'documentsApi.update(1, 12, { name })',
      // A dynamic import, and the conversation import's PREVIEW, are not doors.
      "const m = await import('./x')",
      'conversationsApi.preview(id, file)',
      // The API object's own declaration is not a call.
      'setSubject: (projectId: number) => api.patch(url)',
    ]) expect(nearMiss).not.toMatch(LINK_DOOR)
  })
})
