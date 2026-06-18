import type { ResponseLengthResponse } from '@/lib/api'

interface ResponseLengthPanelProps {
  data: ResponseLengthResponse | null
  loading: boolean
}

export default function ResponseLengthPanel({ data, loading }: ResponseLengthPanelProps) {
  if (loading) {
    return <div className="text-center py-6 text-mm-text-muted text-sm">Loading...</div>
  }
  if (!data) return null

  const allItems = [
    ...data.codes.map(c => ({ ...c, isUncoded: false })),
    { code_id: -1, code_name: '(Uncoded)', code_color: '#d1d5db' as string | null, avg_words: data.uncoded.avg_words, text_count: data.uncoded.text_count, isUncoded: true },
  ]

  const maxWords = Math.max(...allItems.map(c => c.avg_words), 1)

  return (
    <div className="border rounded-lg bg-mm-surface p-4" role="region" aria-label="Response length by code">
      <h3 className="text-sm font-medium mb-3">Response Length by Code</h3>

      <div className="space-y-1.5">
        {allItems.map(c => {
          if (c.text_count === 0) return null
          return (
            <div key={c.code_id} className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: c.code_color || '#6b7280' }}
              />
              <span className={`text-xs w-28 truncate flex-shrink-0 ${c.isUncoded ? 'text-mm-text-faint italic' : 'text-mm-text'}`} title={c.code_name}>
                {c.code_name}
              </span>
              <div className="flex-1 bg-mm-bg rounded-full h-3 overflow-hidden" role="meter" aria-valuenow={c.avg_words} aria-valuemin={0} aria-valuemax={maxWords} aria-label={`${c.code_name}: ${c.avg_words.toFixed(0)} avg words`}>
                <div
                  className={`h-full rounded-full transition-all ${c.isUncoded ? 'bg-gray-300 dark:bg-gray-600' : 'bg-teal-400'}`}
                  style={{ width: `${(c.avg_words / maxWords) * 100}%` }}
                />
              </div>
              <span className="text-xs tabular-nums w-10 text-right font-medium">{c.avg_words.toFixed(0)}w</span>
              <span className="text-[11px] text-mm-text-faint w-6 text-right">n={c.text_count}</span>
            </div>
          )
        })}
      </div>

      {data.codes.length > 0 && data.uncoded.text_count > 0 && (
        <p className="text-xs text-mm-text-faint mt-2">
          {data.uncoded.avg_words > 0 && data.codes.length > 0 && (() => {
            const totalCoded = data.codes.reduce((s, c) => s + c.text_count, 0)
            return totalCoded > 0 ? (
              <>
                Coded comments avg {Math.round(data.codes.reduce((s, c) => s + c.avg_words * c.text_count, 0) / totalCoded)} words
                vs. uncoded avg {Math.round(data.uncoded.avg_words)} words.
              </>
            ) : null
          })()}
        </p>
      )}
    </div>
  )
}
