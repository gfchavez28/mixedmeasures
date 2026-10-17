/**
 * #1117 — which version of Mixed Measures made a project file, said as a fact in the
 * import confirmation.
 *
 * It used to arrive as an amber WARNING — "Exported from app version 1.0.0 (current:
 * 1.5.7)." — beside a false one, "Some data may not import correctly", on every file
 * from 1.5.3 or earlier (the website's own example among them). The import brings an
 * older format forward and drops nothing, and a NEWER format is refused before this
 * dialog opens, so neither is a caution. The version is still worth knowing — a
 * colleague's file says how far behind their copy is — so it is shown, plainly.
 */
export default function ProjectFileOrigin({ appVersion }: { appVersion?: string | null }) {
  const version = appVersion?.trim()
  // A manifest without one (hand-built, or a format before the field) says nothing
  // rather than "Made with Mixed Measures unknown".
  if (!version || version === 'unknown') return null
  return <p className="text-xs text-mm-text-muted">Made with Mixed Measures {version}.</p>
}
