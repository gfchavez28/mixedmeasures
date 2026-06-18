import api from './client'

// Auth types
export interface User {
  id: number
  username: string
  is_admin?: boolean
  csrf_token?: string
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
export const authApi = {
  getStatus: () => api.get<AuthStatus>('/auth/status').then(res => res.data),
  updateProfile: (username: string) =>
    api.patch<User>('/auth/me', { username }).then(res => res.data),
}
