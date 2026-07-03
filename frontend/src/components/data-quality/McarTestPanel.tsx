import { TriangleAlert, Info, CircleCheck, CircleX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { McarTestResponse } from '@/lib/api'

interface McarTestPanelProps {
  /** Client-side pre-flight: selected column_ids */
  hasSelection: boolean
  /** Client-side pre-flight: true if columns span multiple datasets */
  isMultiDataset: boolean
  /** Client-side pre-flight: true if selection has ordinal/numeric variables */
  hasNumericVars: boolean
  /** Mutation state */
  isPending: boolean
  /** Server result (null if not yet run) */
  result: McarTestResponse | null
  /** Error from mutation */
  error: Error | null
  /** Trigger the test */
  onRun: () => void
}

export default function McarTestPanel({
  hasSelection,
  isMultiDataset,
  hasNumericVars,
  isPending,
  result,
  error,
  onRun,
}: McarTestPanelProps) {
  // Client-side pre-flight checks
  const canRun = hasSelection && !isMultiDataset && hasNumericVars

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-mm-text">Little&apos;s MCAR Test</span>
        <span title="Tests whether missing data is Missing Completely At Random. A non-significant result (p &ge; .05) suggests MCAR is plausible.">
          <Info className="w-3 h-3 text-mm-text-faint" />
        </span>
      </div>

      {/* Pre-flight warnings */}
      {!hasSelection && (
        <div className="text-[10px] text-mm-text-faint italic">
          Select variables to run the test.
        </div>
      )}
      {hasSelection && isMultiDataset && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>Select variables from a single dataset.</span>
        </div>
      )}
      {hasSelection && !isMultiDataset && !hasNumericVars && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>Requires ordinal or numeric variables.</span>
        </div>
      )}

      {/* Run button */}
      <Button
        variant="outline"
        size="sm"
        className="text-xs h-7 w-full"
        disabled={!canRun || isPending}
        onClick={onRun}
      >
        {isPending ? 'Running...' : 'Run Test'}
      </Button>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-[10px] text-red-700 dark:text-red-300" role="alert">
          <CircleX className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{error.message || 'Test failed. Try adjusting your selection.'}</span>
        </div>
      )}

      {/* Result display */}
      {result && !isPending && (
        <>
          {/* Ineligible */}
          {!result.eligibility.eligible && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-300" role="alert">
              <TriangleAlert className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{result.eligibility.reason}</span>
            </div>
          )}

          {/* Warning (non-blocking) */}
          {result.eligibility.eligible && result.eligibility.warning && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-mm-blue/12 border border-mm-blue/30 text-[10px] text-mm-blue-text" role="status">
              <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{result.eligibility.warning}</span>
            </div>
          )}

          {/* Test result */}
          {result.result && (
            <div className="space-y-1.5" role="status">
              {/* APA string */}
              <div className="px-2 py-1.5 rounded bg-mm-bg border border-mm-border-subtle font-mono text-[11px] text-mm-text tabular-nums">
                {result.result.apa_string}
              </div>

              {/* Interpretation badge */}
              {result.result.p >= 0.05 ? (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-[10px] text-emerald-700 dark:text-emerald-300 font-medium">
                  <CircleCheck className="w-3 h-3 flex-shrink-0" />
                  MCAR plausible
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-300 font-medium">
                  <TriangleAlert className="w-3 h-3 flex-shrink-0" />
                  MCAR rejected
                </div>
              )}

              {/* Details */}
              <div className="text-[10px] text-mm-text-faint space-y-0.5">
                <div>n = {result.result.n}, {result.result.n_variables} variables, {result.result.n_patterns} patterns</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
