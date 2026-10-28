import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { authApi, type Coder } from '@/lib/api'
import { resetCoderRoster } from '@/hooks/useCoders'

/**
 * #530 — one shared create-coder mutation for every "Add coder" surface (TopRail
 * coder menu, Settings Coder identity, Dashboard switcher). The caller then
 * switches to the new coder via `useCoderSwitch`'s
 * `requestSwitch(coder, { skipConfirm: true })` — creating a coder is already an
 * explicit choice, so no second confirm (#460's skip case).
 * New create surfaces MUST route through this, not a private mutation.
 *
 * 🔴 Creating a coder ADDS one, so the roster is RESET, never invalidated (#964,
 * 10-19 group C item 11): the caller switches to the new coder straight away,
 * and an invalidated roster keeps answering "one coder" — blind mode off — until
 * its refetch lands (for the session, if it fails), so the new coder could see
 * the old one's codings.
 */
export function useCreateCoder(opts?: { onCreated?: (coder: Coder) => void }) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => authApi.createCoder(name),
    onSuccess: (coder) => {
      void resetCoderRoster(queryClient)
      opts?.onCreated?.(coder)
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || 'Could not create coder')
    },
  })
}
