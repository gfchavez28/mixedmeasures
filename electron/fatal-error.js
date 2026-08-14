// Lifting a backend startup failure into the crash dialog (#716).
//
// Pure (Electron-free) so it is unit-testable without a runtime or a display — the
// same split as backend-process.js / key-manager.js / zoom.js. main.js does the
// wiring; the parsing and the wording live here.
//
// The backend writes ONE marked line to stderr for a fatal startup failure (see
// backend/app/startup_errors.py). Everything else it writes — uvicorn's banner, the
// multi-line traceback with absolute source paths, ordinary logging — is developer
// output and must never reach a dialog.

const { StringDecoder } = require('node:string_decoder')

/**
 * Must match `MM_FATAL_PREFIX` in backend/app/startup_errors.py.
 *
 * The two constants are hand-mirrored across languages with no codegen, so
 * `backend/tests/test_startup_fatal.py` reads THIS file and fails if they drift —
 * without it each side's suite validates only its own half and both stay green
 * while the dialog goes generic forever (#723).
 */
const MM_FATAL_PREFIX = 'MM-FATAL: '

/**
 * Newline-less output we hold before dropping the head, and how much tail we keep.
 *
 * `push` only splits on `\n`, so a stream that emits bare `\r` (a progress bar)
 * never flushes and `pending` would grow for the life of the app. The kept tail is
 * orders of magnitude longer than a marker line, and our own fatal line always
 * arrives newline-TERMINATED, so this can only ever discard other tools' noise.
 */
const MAX_PENDING_CHARS = 64 * 1024
const PENDING_KEEP_CHARS = 8 * 1024

/** More than a handful is a loop, not a diagnosis. */
const MAX_FATAL_LINES = 5

/** Past this the dialog stops being dismissable-past on a small screen. */
const MAX_FATAL_CHARS = 1200

/**
 * Scan a stderr byte stream for marker lines.
 *
 * ⚠️ Chunk boundaries do NOT respect lines. `child.stderr.on('data')` delivers
 * whatever the pipe had, so `MM-FATAL: ` can arrive split across two chunks
 * ("...MM-FA" then "TAL: disk full"). A per-chunk `includes()` misses exactly the
 * case this exists for, so the incomplete tail is carried forward instead.
 *
 * ⚠️ Chunk boundaries do not respect CHARACTERS either, and that is a second bug
 * (#723). We are handed raw `Buffer`s, and `String(chunk)` decodes each one alone —
 * so a multi-byte UTF-8 character straddling a boundary becomes replacement
 * characters. It is not exotic input: the fatal message interpolates the backup
 * PATH and the OS error string. `StringDecoder` holds an incomplete sequence back
 * until the next chunk completes it. It passes a string through unchanged, so a
 * caller that already decoded still works.
 *
 * The marker is matched ANYWHERE in the line, not at its start: a partial line
 * without a trailing newline (uvicorn's progress output, say) can glue itself to the
 * front of ours, and that must not swallow the message.
 */
function createFatalLineCollector({ prefix = MM_FATAL_PREFIX, maxLines = MAX_FATAL_LINES } = {}) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const found = []

  const take = (line, sink) => {
    const at = line.indexOf(prefix)
    if (at === -1) return
    const text = line.slice(at + prefix.length).trim()
    if (text && sink.length < maxLines) sink.push(text)
  }

  return {
    push(chunk) {
      pending += decoder.write(chunk)
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() // the tail is incomplete until a newline arrives
      for (const part of parts) take(part, found)
      if (pending.length > MAX_PENDING_CHARS) pending = pending.slice(-PENDING_KEEP_CHARS)
    },
    /**
     * A crashing process frequently dies without a trailing newline, so the buffered
     * tail is read too. Non-mutating: calling this twice yields the same answer.
     *
     * ⚠️ Deliberately NOT `decoder.end()`. That would both mutate the decoder and
     * turn a genuinely incomplete trailing sequence into a replacement character —
     * the very artifact this exists to prevent. Undecodable trailing bytes are not
     * a message; dropping them is the honest outcome.
     */
    lines() {
      const out = found.slice()
      take(pending, out)
      return out
    },
  }
}

/**
 * Truncate without splitting a surrogate pair.
 *
 * A plain `slice` can cut between the two halves of an astral character (an emoji
 * in a project name, say) and leave a LONE SURROGATE in the dialog — which renders
 * as a replacement character, i.e. the same artifact #723 exists to remove, arriving
 * by a different route. Sibling of the code-point rule in `lib/text-offsets.ts`.
 */
function truncateForDialog(text, max) {
  if (text.length <= max) return text
  let cut = max - 1
  const last = text.charCodeAt(cut - 1)
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1 // keep the pair intact
  return `${text.slice(0, cut).trimEnd()}…`
}

/** "code 3" / "signal SIGKILL" / both — whichever the OS actually gave us. */
function describeExit(code, signal) {
  const parts = []
  if (code !== null && code !== undefined) parts.push(`exit code ${code}`)
  if (signal) parts.push(`signal ${signal}`)
  return parts.length ? parts.join(', ') : 'no exit code'
}

/**
 * The dialog to show when the backend dies.
 *
 * With no marker line this is the pre-#716 text verbatim — an unexplained crash is
 * still an unexplained crash, and inventing a cause would be worse than admitting we
 * have none. With one, the backend's own guidance leads and the exit code follows as
 * a support detail rather than as the headline.
 */
function crashDialogText({ code, signal, fatalLines = [], startupError = null }) {
  const exit = describeExit(code, signal)
  const closing = 'The app will close.'

  // 1. The backend told us what went wrong, in words written for a researcher.
  if (fatalLines.length) {
    return {
      // A different title on purpose: the marker is only ever emitted during startup,
      // so "stopped" would misdescribe an app that never started.
      title: 'Mixed Measures could not start',
      message: truncateForDialog(fatalLines.join('\n\n'), MAX_FATAL_CHARS),
      detail: `${closing} (engine ${exit})`,
    }
  }

  // 2. Startup failed without the backend saying anything useful — report the error we
  //    actually caught rather than inventing a cause we do not have.
  if (startupError) {
    const text = String((startupError && startupError.message) || startupError).trim()
    return {
      title: 'Mixed Measures failed to start',
      message: truncateForDialog(text || 'The app could not start.', MAX_FATAL_CHARS),
      detail: closing,
    }
  }

  // 3. The engine died while the app was running: the pre-#716 wording, verbatim.
  //    An unexplained crash is still an unexplained crash.
  return {
    title: 'Mixed Measures engine stopped',
    message: `The local engine exited unexpectedly (${exit}).`,
    detail: closing,
  }
}

/** What "Copy details" puts on the clipboard — the whole dialog, as support would want it. */
function crashDialogClipboardText({ title, message, detail }) {
  return [title, '', message, '', detail].join('\n')
}

module.exports = {
  MM_FATAL_PREFIX,
  MAX_FATAL_LINES,
  MAX_FATAL_CHARS,
  MAX_PENDING_CHARS,
  createFatalLineCollector,
  crashDialogText,
  crashDialogClipboardText,
  describeExit,
  truncateForDialog,
}
