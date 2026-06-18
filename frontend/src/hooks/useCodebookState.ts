import { useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

// ── Types ────────────────────────────────────────────────────────────────────

export type CodebookMode = 'tree' | 'network'
export type CodebookSizing = 'uniform' | 'seg' | 'src'
export type CodebookFormat = 'compact' | 'full'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultForKey(key: string): string {
  switch (key) {
    case 'mode': return 'tree'
    case 'catFmt': return 'full'
    case 'codeFmt': return 'full'
    case 'sizing': return 'uniform'
    case 'netLevel': return '-1'
    case 'minSeg': return '0'
    case 'inactive': return ''
    case 'netTable': return ''
    default: return ''
  }
}

function parseIds(raw: string): Set<number> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map(Number).filter(n => !isNaN(n) && n > 0))
}

function serializeIds(ids: Set<number>): string {
  return Array.from(ids).sort((a, b) => a - b).join(',')
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCodebookState() {
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Read URL params ──────────────────────────────────────────────────

  const mode = (searchParams.get('mode') || 'tree') as CodebookMode
  const catFormat = (searchParams.get('catFmt') || 'full') as CodebookFormat
  const codeFormat = (searchParams.get('codeFmt') || 'full') as CodebookFormat
  const sizing = (searchParams.get('sizing') || 'uniform') as CodebookSizing
  const selection = searchParams.get('sel') || null
  const search = searchParams.get('search') || ''
  const inactive = searchParams.get('inactive') === '1'
  const netTable = searchParams.get('netTable') === '1'
  const netLevel = Number(searchParams.get('netLevel') ?? '-1')
  const minSeg = Number(searchParams.get('minSeg') ?? '0')
  const maxSeg = useMemo(() => {
    const raw = searchParams.get('maxSeg')
    return raw !== null ? Number(raw) : null
  }, [searchParams])

  const hideCodesRaw = searchParams.get('hideCodes') ?? ''
  const hideConvsRaw = searchParams.get('hideConvs') ?? ''
  const hideColsRaw = searchParams.get('hideCols') ?? ''
  const hiddenCodeIds = useMemo(() => parseIds(hideCodesRaw), [hideCodesRaw])
  const hiddenConvIds = useMemo(() => parseIds(hideConvsRaw), [hideConvsRaw])
  const hiddenColIds = useMemo(() => parseIds(hideColsRaw), [hideColsRaw])

  // ── Generic setter ────────────────────────────────────────────────────

  const setUrlParam = useCallback((key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === getDefaultForKey(key)) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  // ── Individual setters ────────────────────────────────────────────────

  const setMode = useCallback((v: CodebookMode) => setUrlParam('mode', v), [setUrlParam])
  const setCatFormat = useCallback((v: CodebookFormat) => setUrlParam('catFmt', v), [setUrlParam])
  const setCodeFormat = useCallback((v: CodebookFormat) => setUrlParam('codeFmt', v), [setUrlParam])
  const setSizing = useCallback((v: CodebookSizing) => setUrlParam('sizing', v), [setUrlParam])
  const setSelection = useCallback((v: string | null) => setUrlParam('sel', v || ''), [setUrlParam])
  const setSearch = useCallback((v: string) => setUrlParam('search', v), [setUrlParam])
  const setInactive = useCallback((v: boolean) => setUrlParam('inactive', v ? '1' : ''), [setUrlParam])
  const setNetTable = useCallback((v: boolean) => setUrlParam('netTable', v ? '1' : ''), [setUrlParam])
  const setNetLevel = useCallback((v: number) => setUrlParam('netLevel', String(v)), [setUrlParam])
  const setMinSeg = useCallback((v: number) => setUrlParam('minSeg', String(v)), [setUrlParam])
  const setMaxSeg = useCallback((v: number | null) => setUrlParam('maxSeg', v !== null ? String(v) : ''), [setUrlParam])

  const setHiddenCodeIds = useCallback((ids: Set<number>) => {
    setUrlParam('hideCodes', serializeIds(ids))
  }, [setUrlParam])

  const setHiddenConvIds = useCallback((ids: Set<number>) => {
    setUrlParam('hideConvs', serializeIds(ids))
  }, [setUrlParam])

  const setHiddenColIds = useCallback((ids: Set<number>) => {
    setUrlParam('hideCols', serializeIds(ids))
  }, [setUrlParam])

  // Remove specific code IDs from hidden set (reads fresh URL state via functional update)
  const removeHiddenCodeIds = useCallback((idsToRemove: number[]) => {
    setSearchParams(prev => {
      const current = parseIds(prev.get('hideCodes') ?? '')
      for (const id of idsToRemove) current.delete(id)
      const next = new URLSearchParams(prev)
      const serialized = serializeIds(current)
      if (!serialized) next.delete('hideCodes')
      else next.set('hideCodes', serialized)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const clearAllHidden = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('hideCodes')
      next.delete('hideConvs')
      next.delete('hideCols')
      return next
    }, { replace: true })
  }, [setSearchParams])

  return {
    // State
    mode, catFormat, codeFormat, sizing, selection, search, inactive, netTable,
    netLevel, minSeg, maxSeg, hiddenCodeIds, hiddenConvIds, hiddenColIds,
    // Setters
    setMode, setCatFormat, setCodeFormat, setSizing, setSelection, setSearch,
    setInactive, setNetTable, setNetLevel, setMinSeg, setMaxSeg,
    setHiddenCodeIds, setHiddenConvIds, setHiddenColIds,
    removeHiddenCodeIds, clearAllHidden,
    // Generic
    setUrlParam,
  }
}

export type CodebookState = ReturnType<typeof useCodebookState>
