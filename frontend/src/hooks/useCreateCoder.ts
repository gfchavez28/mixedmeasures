import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { authApi, type Coder } from '@/lib/api'

/**
 * #530 — one shared create-coder mutation for every "Add coder" surface (TopRail
 * coder menu, Settings Coder identity, Dashboard switcher). Creation invalidates
 * the `['coders']` roster; the caller then switches to the new coder via
 * `useCoderSwitch`'s `requestSwitch(coder, { skipConfirm: true })` — creating a
 * coder is already an explicit choice, so no second confirm (#460's skip case).
 * New create surfaces MUST route through this, not a private mutation.
 */
export function useCreateCoder(opts?: { onCreated?: (coder: Coder) => void }) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => authApi.createCoder(name),
    onSuccess: (coder) => {
      queryClient.invalidateQueries({ queryKey: ['coders'] })
      opts?.onCreated?.(coder)
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || 'Could not create coder')
    },
  })
}
