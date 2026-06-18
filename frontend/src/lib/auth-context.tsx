import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { authApi, setCsrfToken, type User } from './api'

interface AuthContextType {
  user: User | null
  isLoading: boolean
  inactivityTimeoutMinutes: number
  encryptionEnabled: boolean
  refreshAuth: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

const ACTIVITY_THROTTLE_MS = 30_000
const WARNING_BEFORE_MINUTES = 2

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [inactivityTimeoutMinutes, setInactivityTimeoutMinutes] = useState(0)
  const [encryptionEnabled, setEncryptionEnabled] = useState(false)
  const lastActivityRef = useRef(Date.now())
  const warningShownRef = useRef(false)

  const refreshAuth = useCallback(async () => {
    try {
      const status = await authApi.getStatus()
      setInactivityTimeoutMinutes(status.inactivity_timeout_minutes ?? 0)
      setEncryptionEnabled(status.encryption_enabled ?? false)
      if (status.authenticated && status.user) {
        setUser(status.user)
        if (status.user.csrf_token) {
          setCsrfToken(status.user.csrf_token)
        }
      } else {
        setUser(null)
        setCsrfToken(null)
      }
    } catch (err) {
      console.error('Auth refresh failed:', err)
      setUser(null)
      setCsrfToken(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshAuth()
  }, [refreshAuth])

  // Inactivity tracking: throttled activity listener + warning check
  useEffect(() => {
    if (!user || inactivityTimeoutMinutes <= 0) return

    let lastThrottle = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - lastThrottle > ACTIVITY_THROTTLE_MS) {
        lastThrottle = now
        lastActivityRef.current = now
        warningShownRef.current = false
      }
    }

    const checkInactivity = () => {
      const elapsed = (Date.now() - lastActivityRef.current) / 60_000
      const warningThreshold = inactivityTimeoutMinutes - WARNING_BEFORE_MINUTES
      if (warningThreshold > 0 && elapsed >= warningThreshold && !warningShownRef.current) {
        warningShownRef.current = true
        toast('Your session will expire due to inactivity.', {
          id: 'inactivity-warning',
          duration: WARNING_BEFORE_MINUTES * 60_000,
          action: {
            label: 'Stay signed in',
            onClick: () => {
              authApi.getStatus()
              lastActivityRef.current = Date.now()
              warningShownRef.current = false
            },
          },
        })
      }
    }

    window.addEventListener('mousemove', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('click', onActivity)
    const interval = setInterval(checkInactivity, ACTIVITY_THROTTLE_MS)

    return () => {
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('click', onActivity)
      clearInterval(interval)
    }
  }, [user, inactivityTimeoutMinutes])

  return (
    <AuthContext.Provider value={{ user, isLoading, inactivityTimeoutMinutes, encryptionEnabled, refreshAuth }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
