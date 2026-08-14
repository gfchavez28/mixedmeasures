const test = require('node:test')
const assert = require('node:assert')
const {
  MM_FATAL_PREFIX,
  MAX_FATAL_LINES,
  MAX_FATAL_CHARS,
  MAX_PENDING_CHARS,
  createFatalLineCollector,
  crashDialogText,
  crashDialogClipboardText,
  describeExit,
  truncateForDialog,
} = require('./fatal-error')

/** A high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// The real thing #692 raises, which is the whole reason #716 exists.
const DISK_FULL =
  'Could not create the pre-migration backup at /home/r/.mm/backups/mm_2026.db: ' +
  '[Errno 28] No space left on device. No migration was applied and your data is ' +
  'untouched. Free up disk space (or fix permissions on /home/r/.mm/backups) and relaunch.'

// ⚠️ Feed the PRODUCTION type. `child.stderr.on('data')` emits Buffers; every test
// here fed STRINGS until #723, and a string slice cannot split a multi-byte
// character — which is precisely how a decoding bug hid from a suite that had
// already been mutation-verified for split MARKERS. The fixture type is part of
// what a test proves.
const feed = (collector, ...chunks) => {
  for (const c of chunks) collector.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c)
  return collector.lines()
}

test('a whole line in one chunk is collected', () => {
  const c = createFatalLineCollector()
  assert.deepStrictEqual(feed(c, `${MM_FATAL_PREFIX}${DISK_FULL}\n`), [DISK_FULL])
})

test('the marker split across two chunks is still collected', () => {
  // The defect a per-chunk `includes()` would have: the pipe delivers what it has.
  const c = createFatalLineCollector()
  const whole = `${MM_FATAL_PREFIX}${DISK_FULL}\n`
  const cut = 6 // mid-marker: "MM-FAT" | "AL: ..."
  assert.deepStrictEqual(feed(c, whole.slice(0, cut), whole.slice(cut)), [DISK_FULL])
})

test('a message split mid-sentence across many chunks is reassembled', () => {
  const c = createFatalLineCollector()
  const whole = `${MM_FATAL_PREFIX}${DISK_FULL}\n`
  const chunks = []
  for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7))
  assert.deepStrictEqual(feed(c, ...chunks), [DISK_FULL])
})

test('a fatal line with no trailing newline is still reported', () => {
  // A crashing process routinely dies without flushing a final newline.
  const c = createFatalLineCollector()
  assert.deepStrictEqual(feed(c, `${MM_FATAL_PREFIX}${DISK_FULL}`), [DISK_FULL])
})

test('lines() does not consume — calling twice gives the same answer', () => {
  const c = createFatalLineCollector()
  c.push(`${MM_FATAL_PREFIX}${DISK_FULL}`)
  assert.deepStrictEqual(c.lines(), c.lines())
})

// #723 — the decode half of "chunk boundaries do not respect lines".
//
// Splitting at EVERY byte offset is the point: the defect only appears when the cut
// lands inside a multi-byte sequence, and hand-picking one offset is how you write a
// test that passes against the broken code.
const splitAtEveryByte = (message) => {
  const whole = Buffer.from(`${MM_FATAL_PREFIX}${message}\n`, 'utf8')
  for (let cut = 1; cut < whole.length; cut++) {
    const c = createFatalLineCollector()
    assert.deepStrictEqual(
      feed(c, whole.subarray(0, cut), whole.subarray(cut)),
      [message],
      `corrupted when split at byte ${cut} of ${whole.length}`,
    )
  }
}

test('a 2- and 3-byte character split across chunks is not corrupted', () => {
  // The real shape: a Windows profile path plus the backend's own truncation ellipsis.
  splitAtEveryByte('Could not create the pre-migration backup at C:\\Users\\José\\backups… relaunch.')
})

test('an astral (4-byte) character split across chunks is not corrupted', () => {
  // A project name can carry an emoji, and an astral character is 4 bytes / 2 UTF-16
  // units — the case that breaks naive decoding AND naive truncation.
  splitAtEveryByte('Backup failed for 📊 Ferncrest — free up disk space and relaunch.')
})

test('a caller that already decoded still works — strings pass through', () => {
  // StringDecoder.write() returns a string unchanged, so the module stays usable by
  // any future caller that set an encoding on the stream itself.
  const c = createFatalLineCollector()
  c.push(`${MM_FATAL_PREFIX}${DISK_FULL}\n`)
  assert.deepStrictEqual(c.lines(), [DISK_FULL])
})

test('a newline-less stream cannot grow the buffer without bound', () => {
  // `push` splits on \n only, so a bare-\r progress stream would otherwise accumulate
  // for the life of the app. The cap must not cost us a later fatal line.
  const c = createFatalLineCollector()
  const noise = Buffer.from(`\r${'x'.repeat(4096)}`, 'utf8')
  for (let i = 0; i < Math.ceil((MAX_PENDING_CHARS * 2) / 4096); i++) c.push(noise)
  assert.deepStrictEqual(feed(c, `\n${MM_FATAL_PREFIX}${DISK_FULL}\n`), [DISK_FULL])
})

test('the dialog cap never leaves a lone surrogate', () => {
  // Cutting between the halves of an astral character renders as the very artifact
  // #723 removes, arriving by a different route.
  const text = `${'x'.repeat(MAX_FATAL_CHARS - 2)}📊yyy`
  const out = truncateForDialog(text, MAX_FATAL_CHARS)
  assert.ok(out.length <= MAX_FATAL_CHARS, `overlong: ${out.length}`)
  assert.ok(!LONE_SURROGATE.test(out), 'lone surrogate left in the dialog text')
  assert.match(out, /…$/)
})

test('developer noise is not collected', () => {
  // uvicorn's banner and its multi-line traceback with absolute source paths: this
  // is precisely what must never reach a user-facing dialog.
  const c = createFatalLineCollector()
  const noise = [
    'INFO:     Started server process [45189]\n',
    'INFO:     Waiting for application startup.\n',
    'ERROR:    Traceback (most recent call last):\n',
    '  File "/opt/app/starlette/routing.py", line 694, in lifespan\n',
    '    async with self.lifespan_context(app) as maybe_state:\n',
    'ERROR:    Application startup failed. Exiting.\n',
  ]
  assert.deepStrictEqual(feed(c, ...noise), [])
})

test('a marker glued to the end of a partial line is still found', () => {
  // Something wrote without a trailing newline, so our line begins mid-string.
  const c = createFatalLineCollector()
  assert.deepStrictEqual(feed(c, `Waiting...${MM_FATAL_PREFIX}${DISK_FULL}\n`), [DISK_FULL])
})

test('CRLF line endings are handled', () => {
  const c = createFatalLineCollector()
  assert.deepStrictEqual(feed(c, `${MM_FATAL_PREFIX}${DISK_FULL}\r\n`), [DISK_FULL])
})

test('collection is capped so a loop cannot fill the dialog', () => {
  const c = createFatalLineCollector({ maxLines: 2 })
  const lines = feed(c, ...[1, 2, 3, 4, 5].map((n) => `${MM_FATAL_PREFIX}fatal ${n}\n`))
  assert.deepStrictEqual(lines, ['fatal 1', 'fatal 2'])
})

test('an empty marker line is ignored', () => {
  const c = createFatalLineCollector()
  assert.deepStrictEqual(feed(c, `${MM_FATAL_PREFIX}   \n`), [])
})

test('with no fatal line the dialog is the pre-#716 text, unchanged', () => {
  const { title, message, detail } = crashDialogText({ code: 3, signal: null, fatalLines: [] })
  assert.strictEqual(title, 'Mixed Measures engine stopped')
  assert.match(message, /exited unexpectedly \(exit code 3\)/)
  assert.match(detail, /The app will close\./)
})

test('with a fatal line the guidance leads and the exit code follows', () => {
  const { title, message, detail } = crashDialogText({ code: 3, signal: null, fatalLines: [DISK_FULL] })
  assert.strictEqual(title, 'Mixed Measures could not start')
  // The recovery step is the point of the whole issue, and `message` is what a dialog
  // presents first — by weight to a sighted reader, by order to a screen reader.
  assert.strictEqual(message, DISK_FULL)
  assert.match(detail, /engine exit code 3/)
})

test('the dialog body is capped', () => {
  const { message } = crashDialogText({ code: 1, signal: null, fatalLines: ['x'.repeat(5000)] })
  assert.ok(message.length <= MAX_FATAL_CHARS, `runaway dialog: ${message.length}`)
  assert.match(message, /…/)
})

// #724 — the startup path used to show its own dialog and, by quitting, suppress this
// module's. Both now route here, so the ranking is a property of the text, not of who
// happened to arrive first.

test('a startup error is reported when the backend said nothing', () => {
  const { title, message, detail } = crashDialogText({
    code: null,
    signal: null,
    startupError: new Error('Backend did not become healthy within 60000ms'),
  })
  assert.strictEqual(title, 'Mixed Measures failed to start')
  assert.match(message, /did not become healthy/)
  assert.match(detail, /The app will close\./)
})

test('a fatal line OUTRANKS the startup error — the cause beats the symptom', () => {
  // This is the #724 race, settled by ranking: waitForHealth can only ever report
  // "exited before it became healthy", while the backend already told us it was a
  // full disk. Showing the symptom instead of the cause is the bug.
  const { title, message } = crashDialogText({
    code: 3,
    signal: null,
    fatalLines: [DISK_FULL],
    startupError: new Error('Backend process exited before it became healthy'),
  })
  assert.strictEqual(title, 'Mixed Measures could not start')
  assert.strictEqual(message, DISK_FULL)
  assert.doesNotMatch(message, /became healthy/)
})

test('a startup error with no message still yields a sentence', () => {
  const { message } = crashDialogText({ code: null, signal: null, startupError: new Error('') })
  assert.ok(message.trim().length > 0, 'a nameless failure must not produce an empty dialog')
})

test('Copy details carries the whole dialog, not just the headline', () => {
  const text = crashDialogText({ code: 3, signal: null, fatalLines: [DISK_FULL] })
  const copied = crashDialogClipboardText(text)
  for (const part of [text.title, text.message, text.detail]) assert.ok(copied.includes(part))
})

test('describeExit reports whichever of code/signal the OS gave', () => {
  assert.strictEqual(describeExit(3, null), 'exit code 3')
  assert.strictEqual(describeExit(null, 'SIGKILL'), 'signal SIGKILL')
  assert.strictEqual(describeExit(0, 'SIGTERM'), 'exit code 0, signal SIGTERM')
  assert.strictEqual(describeExit(null, null), 'no exit code')
})

test('the default line cap is a real number', () => {
  assert.ok(MAX_FATAL_LINES > 0 && MAX_FATAL_LINES <= 10)
})
