type ImportType = 'conversation' | 'dataset' | 'document'

let pending: { files: File[]; type: ImportType; timestamp: number } | null = null

export function setPendingImportFiles(files: File[], type: ImportType): void {
  pending = { files, type, timestamp: Date.now() }
}

export function consumePendingImportFiles(type: ImportType): File[] | null {
  if (!pending || pending.type !== type) return null
  // Discard if older than 30 seconds (stale safety net)
  if (Date.now() - pending.timestamp > 30_000) {
    pending = null
    return null
  }
  const files = pending.files
  pending = null
  return files
}
