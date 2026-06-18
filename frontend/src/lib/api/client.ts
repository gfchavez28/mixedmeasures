// ── Error class ───────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number
  response: { status: number; data: unknown; headers: Record<string, string> }

  constructor(status: number, data: unknown, headers: Record<string, string>) {
    const detail = (data as { detail?: string })?.detail
    super(detail || `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.response = { status, data, headers }
  }
}

// ── CSRF token ────────────────────────────────────────────────────────

let csrfToken: string | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

// ── Types ─────────────────────────────────────────────────────────────

interface RequestConfig {
  params?: object
  headers?: Record<string, string>
  responseType?: 'json' | 'blob' | 'text'
  timeout?: number
  signal?: AbortSignal
  transformResponse?: Array<(data: string) => unknown>
}

interface ApiResponse<T> {
  data: T
  headers: Record<string, string>
}

// ── Core request ──────────────────────────────────────────────────────

function headersToRecord(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {}
  headers.forEach((value, key) => { obj[key] = value })
  return obj
}

function buildUrl(path: string, params?: object): string {
  const url = `/api${path}`
  if (!params) return url
  const sp = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) sp.append(key, String(val))
  }
  const qs = sp.toString()
  return qs ? `${url}?${qs}` : url
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  config: RequestConfig = {},
): Promise<ApiResponse<T>> {
  const { params, headers: extraHeaders, responseType = 'json', timeout = 30_000, signal, transformResponse } = config

  const url = buildUrl(path, params)
  const headers: Record<string, string> = { ...extraHeaders }
  const isFormData = body instanceof FormData

  // Default Content-Type for JSON bodies; let browser set boundary for FormData
  if (!isFormData && body !== undefined && body !== null) {
    headers['Content-Type'] ??= 'application/json'
  }
  if (isFormData) {
    delete headers['Content-Type']
  }

  // CSRF token on mutating methods
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = csrfToken
  }

  // Timeout via AbortSignal
  const timeoutSignal = AbortSignal.timeout(timeout)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const response = await fetch(url, {
    method,
    headers,
    body: isFormData ? body : (body !== undefined && body !== null ? JSON.stringify(body) : undefined),
    credentials: 'include',
    signal: combinedSignal,
  })

  if (!response.ok) {
    const respHeaders = headersToRecord(response.headers)
    let errorData: unknown
    try {
      errorData = await response.json()
    } catch {
      try { errorData = { detail: await response.text() } } catch { errorData = {} }
    }

    // 401 → the session lapsed (e.g. expiry). Local-first has no login screen,
    // so clear the stale CSRF token and reload: AuthProvider re-hits /status,
    // which auto-provisions a fresh session and returns us to where we were.
    if (response.status === 401) {
      csrfToken = null
      window.location.reload()
    }

    throw new ApiError(response.status, errorData, respHeaders)
  }

  const respHeaders = headersToRecord(response.headers)

  if (responseType === 'blob') {
    return { data: await response.blob() as T, headers: respHeaders }
  }
  if (responseType === 'text' || transformResponse) {
    const text = await response.text()
    const data = transformResponse ? transformResponse[0](text) : text
    return { data: data as T, headers: respHeaders }
  }
  // Handle empty responses (e.g. 204 No Content from DELETE endpoints)
  const contentLength = response.headers.get('content-length')
  if (response.status === 204 || contentLength === '0') {
    return { data: undefined as T, headers: respHeaders }
  }
  const text = await response.text()
  if (!text) {
    return { data: undefined as T, headers: respHeaders }
  }
  return { data: JSON.parse(text) as T, headers: respHeaders }
}

// ── Public API (same interface as previous axios instance) ────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- matches axios default; callers with explicit generics retain full type safety */
const api = {
  get: <T = any>(url: string, config?: RequestConfig) =>
    request<T>('GET', url, undefined, config),
  post: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('POST', url, body, config),
  put: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PUT', url, body, config),
  patch: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PATCH', url, body, config),
  delete: <T = any>(url: string, config?: RequestConfig) =>
    request<T>('DELETE', url, undefined, config),
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default api
