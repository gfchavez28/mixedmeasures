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

/**
 * #1143 — the guidance when the engine could not be STARTED at all.
 *
 * A spawn that fails emits only 'error' — no exit code, no stderr, no marker line —
 * so the crash dialog's other two sources have nothing to say, and the researcher is
 * the one who has to act. The likeliest real cause is security software: PyInstaller
 * binaries are commonly flagged, and a quarantine leaves the install looking intact.
 * So the sentence names the engine's FILE (the name a quarantine list shows) and its
 * path, and what to check — never only the error code.
 *
 * Returned as plain text for `crashDialogText`'s `startupError` arm, which shows it
 * verbatim under "Mixed Measures failed to start".
 */
function backendSpawnFailureMessage(err, exePath) {
  const code = (err && err.code) || null
  const file = exePath ? String(exePath).split(/[\\/]/).pop() : 'mm-backend'
  const where = exePath ? `\n\nThe engine should be at:\n${exePath}` : ''
  if (code === 'ENOENT') {
    return `Mixed Measures could not find its engine (“${file}”). Security software `
      + 'may have quarantined it, or the installation may be damaged. Check your '
      + `antivirus for “${file}” and restore it, or reinstall Mixed Measures.${where}`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Mixed Measures was not allowed to start its engine (“${file}”). Security `
      + `software may be blocking it. Allow “${file}” in your antivirus or security `
      + `settings, or reinstall Mixed Measures.${where}`
  }
  const reason = code || (err && err.message) || 'an unknown error'
  return `Mixed Measures could not start its engine (“${file}”): ${reason}. `
    + `Reinstalling Mixed Measures may fix this.${where}`
}

/** What "Copy details" puts on the clipboard — the whole dialog, as support would want it. */
function crashDialogClipboardText({ title, message, detail }) {
  return [title, '', message, '', detail].join('\n')
}

const CRASH_BUTTONS = ['Copy details', 'Quit']
const CRASH_COPY = 0
const CRASH_QUIT = 1

/** The first line of `detail` once "Copy details" has worked, or failed. */
const COPIED_NOTE = 'The details are copied. Paste them somewhere before you choose Quit.'
const COPY_FAILED_NOTE = 'The details could not be copied. A screenshot of this message works too; take it before you choose Quit.'

/**
 * Show the crash dialog until the researcher chooses Quit; the caller quits after.
 *
 * "Copy details" used to copy and quit in ONE press (#716). That took the guidance off the
 * screen — and it names a folder the researcher is being asked to act on — said nothing
 * about whether the copy worked, and on Linux an app's clipboard can empty when the app
 * exits, before anything was pasted. Now the copy is awaited (Electron 44 made
 * `clipboard.writeText` return a Promise, in the main process too) and the same dialog
 * comes back with a first line saying it worked. A re-shown native dialog is announced
 * again, so a screen reader hears the confirmation too. Only Quit (or Escape) ends it.
 *
 * Electron-free: `dialog` and `clipboard` are injected, like the rest of this file.
 */
async function showCrashDialog({ dialog, clipboard, text, log = () => {} }) {
  let note = null
  for (;;) {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: text.title,
      message: text.message,
      detail: note ? `${note}\n\n${text.detail}` : text.detail,
      buttons: CRASH_BUTTONS,
      defaultId: CRASH_QUIT,
      cancelId: CRASH_QUIT,
      noLink: true,
    })
    if (choice !== CRASH_COPY) return
    try {
      await clipboard.writeText(crashDialogClipboardText(text))
      note = COPIED_NOTE
    } catch (err) {
      log(`crash dialog: copy failed (${(err && err.message) || err})`)
      note = COPY_FAILED_NOTE
    }
  }
}

module.exports = {
  MM_FATAL_PREFIX,
  MAX_FATAL_LINES,
  MAX_FATAL_CHARS,
  MAX_PENDING_CHARS,
  createFatalLineCollector,
  crashDialogText,
  crashDialogClipboardText,
  backendSpawnFailureMessage,
  showCrashDialog,
  CRASH_BUTTONS,
  COPIED_NOTE,
  COPY_FAILED_NOTE,
  describeExit,
  truncateForDialog,
}
