/**
 * #1321 D2 — `importProject` carries a `coder_mapping` for a coding copy as well as a merge:
 * the import dialog's answer to "which of these people is you?" (`lib/coding-copy.ts`). It
 * sent one for merge only, so the answer would have been dropped on the wire and the
 * server's no-answer rule would have made the researcher a second coder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: { project_id: 7, project_name: 'X' } }),
    get: vi.fn(),
  },
}))

import api from './client'
import { projectPortabilityApi } from './project-portability'

const file = new File(['x'], 'p.mmproject')
const lastFormData = () => (api.post as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as FormData
const mapping = { '3': { action: 'match' as const, target_user_id: 7 } }

describe('importProject — coder_mapping', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a coding copy sends it', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'copy_for_coding', coderMapping: mapping })
    const fd = lastFormData()
    expect(fd.get('import_mode')).toBe('copy_for_coding')
    expect(JSON.parse(fd.get('coder_mapping') as string)).toEqual(mapping)
    expect(fd.get('target_project_id')).toBeNull()
  })

  it('a merge still sends it', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'merge', targetProjectId: 4, coderMapping: mapping })
    expect(JSON.parse(lastFormData().get('coder_mapping') as string)).toEqual(mapping)
  })

  it('a new import and an overwrite never do (their dialog asks nothing, D6)', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'new', coderMapping: mapping })
    expect(lastFormData().get('coder_mapping')).toBeNull()
    vi.clearAllMocks()
    await projectPortabilityApi.importProject(file, { mode: 'overwrite', targetProjectId: 4, coderMapping: mapping })
    expect(lastFormData().get('coder_mapping')).toBeNull()
  })

  it('no mapping given, none sent ("None of them")', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'copy_for_coding' })
    expect(lastFormData().get('coder_mapping')).toBeNull()
  })
})
