/**
 * Shared CSV serialization helpers for client-side exports.
 *
 * `csvSafe` mirrors the backend `csv_safe` (routers/export_helpers.py): it
 * defangs the high-impact OWASP formula-injection prefix subset (`=`, `@`,
 * tab, CR) by prefixing a single quote. `+`/`-` are deliberately excluded to
 * avoid false-positives on legitimate negative numbers in respondent data.
 *
 * Any user-derived field written to CSV MUST pass through these helpers.
 */

/** UTF-8 byte-order mark — prepend to a CSV so Excel reads non-ASCII correctly. */
export const UTF8_BOM = String.fromCharCode(0xfeff)

const FORMULA_PREFIXES = ['=', '@', '\t', '\r']

export function csvSafe(val: string): string {
  return val.length > 0 && FORMULA_PREFIXES.includes(val[0]) ? "'" + val : val
}

/** Defang + RFC-4180 quote a single field (quotes when it contains `,"`/CR/LF). */
export function escapeCsvField(val: string): string {
  const safe = csvSafe(val)
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Serialize a matrix of string rows to RFC-4180 CSV (CRLF line endings). */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n')
}
