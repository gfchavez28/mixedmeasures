/**
 * Track J · J3-1: importProject must carry the import mode + overwrite target to the
 * backend so a round-trip can replace an existing local copy (vs always create-new).
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

describe('projectPortabilityApi.importProject (J3-1 modes)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults to mode "new" with no overwrite target', async () => {
    await projectPortabilityApi.importProject(file)
    const fd = lastFormData()
    expect(fd.get('import_mode')).toBe('new')
    expect(fd.get('target_project_id')).toBeNull()
  })

  it('sends overwrite mode + target_project_id', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'overwrite', targetProjectId: 42 })
    const fd = lastFormData()
    expect(fd.get('import_mode')).toBe('overwrite')
    expect(fd.get('target_project_id')).toBe('42')
  })

  it('omits the target when mode is "new" even if a target id is passed', async () => {
    await projectPortabilityApi.importProject(file, { mode: 'new', targetProjectId: 42 })
    const fd = lastFormData()
    expect(fd.get('import_mode')).toBe('new')
    expect(fd.get('target_project_id')).toBeNull()
  })
})
