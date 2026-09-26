import api from './client'
import type { MachineProvenance } from '@/lib/machine-coder'

// Auth types
export interface User {
  id: number
  username: string
  is_admin?: boolean
  csrf_token?: string
  // Active coder's badge color (Track J · J1) — carried so the TopRail dot matches
  // the roster (`Coder`) + attribution badges instead of a palette fallback (#452).
  display_color?: string | null
}

export interface AuthStatus {
  needs_setup: boolean
  authenticated: boolean
  user: User | null
  inactivity_timeout_minutes: number
  encryption_enabled: boolean
}

// API functions - Auth.
// Post-J0 only the local-coder flow remains client-side. The multi-user account
// endpoints (/setup, /login, /logout, /change-password, /users) still exist on the
// backend but are gated behind MM_MULTIUSER_AUTH_ENABLED (default off) until
// Track J reintroduces a coder roster — their client methods were removed with them.
/** A roster coder (Track J · J1) — richer than User (carries color/type/archived). */
export interface Coder {
  id: number
  username: string
  display_color?: string | null
  /**
   * `human` or `ai` (a MACHINE coder — #989). 🔴 The PREDICATE lives in
   * `lib/coding-layers.ts::isMachineCoder`, not here: this module is the wire
   * shape, and a runtime export from it forces every `vi.mock('@/lib/api')` in
   * the suite to stub a function it does not care about. Never compare this
   * field to a string at a call site.
   */
  coder_type?: string
  is_admin?: boolean
  archived?: boolean
  /**
   * A MACHINE coder's configuration (queue row 49), or null — for a person, and
   * for a machine whose configuration was never recorded. The shape and every
   * helper live in `lib/machine-coder.ts` for `coder_type`'s reason above.
   */
  machine_provenance?: MachineProvenance | null
  /**
   * 🔴 Has this coder produced any coding? Once it has, `PATCH /auth/coders/{id}`
   * REFUSES a configuration change — two configurations of one model are two
   * coders. Derived per request by the server; **never re-derived on the client**,
   * or the editor is offered for an act the server 409s (#806 / #974).
   */
  provenance_locked?: boolean
}

export const authApi = {
  getStatus: () => api.get<AuthStatus>('/auth/status').then(res => res.data),
  updateProfile: (username: string, display_color?: string | null) =>
    api.patch<User>('/auth/me', { username, display_color }).then(res => res.data),
  // Track J · J1 — passwordless coder roster (local-first; no security claim).
  // Default = non-archived roster (the lens useCoders relies on). Pass true only
  // for the Settings roster manager, which also lists archived coders to unarchive.
  // `=== true` is deliberate: React Query calls a bare `queryFn: listCoders` with a
  // context object (truthy) — strict-checking keeps useCoders on the non-archived roster.
  listCoders: (includeArchived = false) =>
    api.get<Coder[]>(`/auth/coders${includeArchived === true ? '?include_archived=true' : ''}`).then(res => res.data),
  // `coder_type` is omitted by every existing caller and defaults to `human`
  // server-side; pass `'ai'` to register a MACHINE coder (#989), optionally with
  // the model configuration that produced its labels (row 49).
  createCoder: (
    username: string,
    display_color?: string | null,
    coder_type?: 'human' | 'ai',
    machine_provenance?: MachineProvenance | null,
  ) =>
    api.post<Coder>('/auth/coders', {
      username, display_color, coder_type, machine_provenance,
    }).then(res => res.data),
  /**
   * Edit a MACHINE coder (#999, closed by row 49).
   *
   * 🔴 **There was no door at all before this.** `PATCH /auth/me` renames the
   * ACTIVE coder — J1's rule that only a coder edits their own name — and
   * `switch-coder` refuses a machine, so a machine imported under a bad name was
   * stuck with it. It is restricted to machines on purpose: for people a rename
   * stays self-service.
   *
   * ⚠️ Omit a field to leave it alone; an explicit `null` on `display_color`
   * clears it. The server refuses a CONFIGURATION change once the coder holds a
   * coding, which is what `Coder.provenance_locked` says in advance.
   */
  updateCoder: (
    coderId: number,
    changes: {
      username?: string
      display_color?: string | null
      machine_provenance?: MachineProvenance | null
    },
  ) => api.patch<Coder>(`/auth/coders/${coderId}`, changes).then(res => res.data),
  switchCoder: (coderId: number) =>
    api.post<Coder>('/auth/switch-coder', { coder_id: coderId }).then(res => res.data),
  archiveCoder: (coderId: number) =>
    api.post<Coder>(`/auth/coders/${coderId}/archive`, {}).then(res => res.data),
  unarchiveCoder: (coderId: number) =>
    api.post<Coder>(`/auth/coders/${coderId}/unarchive`, {}).then(res => res.data),
}
