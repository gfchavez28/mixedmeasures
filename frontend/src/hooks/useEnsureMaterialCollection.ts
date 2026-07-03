import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { materialsApi } from '@/lib/api'

/**
 * Returns an async function that resolves the project's default material-collection
 * id, lazily creating the "Materials" collection if the project has none yet (#469b).
 *
 * A project normally gets this collection when it's created in-app or imported from a
 * `.mmproject`, so `defaultCollectionId` is almost always already set. This guards the
 * edge case where a project has zero collections (e.g. an API- or seed-built project),
 * so "Add to Materials" is never a dead-end.
 *
 * The collection is created only on an explicit user save action (the returned fn is
 * called from an Add-to-Materials handler) — never on read/load, so it does not
 * write-on-GET (DEC-C) and can't double-create under React StrictMode the way an
 * effect-driven create-on-mount would.
 */
export function useEnsureMaterialCollection(
  pid: number,
  defaultCollectionId: number | null,
): () => Promise<number> {
  const queryClient = useQueryClient()
  return useCallback(async (): Promise<number> => {
    if (defaultCollectionId) return defaultCollectionId
    const created = await materialsApi.createCollection(pid)
    await queryClient.invalidateQueries({ queryKey: ['material-collections', pid] })
    return created.id
  }, [pid, defaultCollectionId, queryClient])
}
