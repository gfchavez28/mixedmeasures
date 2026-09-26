import type { DatasetAppendPreviewResponse } from '@/lib/api'

type Counts = Pick<
  DatasetAppendPreviewResponse,
  'duplicate_count' | 'in_file_duplicate_count' | 'total_rows'
>

function rows(n: number): string {
  return n === 1 ? 'row' : 'rows'
}

/**
 * The append preview's duplicate sentence (#1014).
 *
 * `duplicate_count` is every record the import will skip, and since #1014 that
 * includes a record repeating an EARLIER record in the same file — which the
 * old sentence, "N of M rows match existing responses", would have misdescribed
 * as already being in the dataset. So the two kinds are named separately.
 */
export function describeAppendDuplicates(p: Counts): string {
  const inFile = p.in_file_duplicate_count
  const existing = p.duplicate_count - inFile
  const ofTotal = `of ${p.total_rows} ${rows(p.total_rows)}`
  if (inFile === 0) {
    return `${existing} ${ofTotal} match existing responses`
  }
  if (existing === 0) {
    return `${inFile} ${ofTotal} repeat an earlier row in this file`
  }
  return (
    `${p.duplicate_count} ${ofTotal} are duplicates: ` +
    `${existing} ${existing === 1 ? 'matches an existing response' : 'match existing responses'}, ` +
    `${inFile} ${inFile === 1 ? 'repeats' : 'repeat'} an earlier row in this file`
  )
}
