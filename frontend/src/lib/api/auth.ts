import api from './client'

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
// A roster coder (Track J · J1) — richer than User (carries color/type/archived).
export interface Coder {
  id: number
  username: string
  display_color?: string | null
  coder_type?: string
  is_admin?: boolean
  archived?: boolean
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
  createCoder: (username: string, display_color?: string | null) =>
    api.post<Coder>('/auth/coders', { username, display_color }).then(res => res.data),
  switchCoder: (coderId: number) =>
    api.post<Coder>('/auth/switch-coder', { coder_id: coderId }).then(res => res.data),
  archiveCoder: (coderId: number) =>
    api.post<Coder>(`/auth/coders/${coderId}/archive`, {}).then(res => res.data),
  unarchiveCoder: (coderId: number) =>
    api.post<Coder>(`/auth/coders/${coderId}/unarchive`, {}).then(res => res.data),
}
