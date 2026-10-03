// Tests for renderer-recovery.js (#1046).
//
// Every failure this guards is one a researcher meets as a WHITE WINDOW: a
// crash nobody listens for, a dialog that never appears because it was
// suppressed, a hang dialog that outlives the hang, a "reload" that reports its
// own kill as a second crash, or a reload loop on a page that fails on load.
// None is reachable from the app's own test suite, and a real renderer crash
// needs a display — so the window, its webContents and `dialog` are fakes.

'use strict'

const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const {
  REPEAT_WINDOW_MS,
  DELIBERATE_KILL_GRACE_MS,
  KILL_FALLBACK_MS,
  CRASH,
  HANG,
  crashDialogOptions,
  attachRendererRecovery,
} = require('./renderer-recovery.js')

const APP_URL = 'http://127.0.0.1:8711/'

function fakeWindow({ visible = true } = {}) {
  const win = new EventEmitter()
  const contents = new EventEmitter()
  contents.calls = { reload: 0, loadURL: [], forcefullyCrashRenderer: 0 }
  contents.reload = () => { contents.calls.reload += 1 }
  contents.loadURL = (url) => { contents.calls.loadURL.push(url) }
  contents.forcefullyCrashRenderer = () => { contents.calls.forcefullyCrashRenderer += 1 }
  let pid = 4241
  contents.getOSProcessId = () => { pid += 1; return pid }
  win.webContents = contents
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  win.isVisible = () => visible
  return win
}

/** A `dialog` whose every message box is answered by `answer(options)`. An
 *  AbortSignal in the options behaves as Electron documents: the box resolves
 *  as if cancelled. */
function fakeDialog(answer = (o) => o.defaultId) {
  const dialog = { shown: [], parents: [] }
  dialog.showMessageBox = (...args) => {
    const options = args.length === 2 ? args[1] : args[0]
    dialog.parents.push(args.length === 2 ? args[0] : null)
    dialog.shown.push(options)
    const response = answer(options)
    if (response === 'hold') {
      return new Promise((resolve) => {
        options.signal?.addEventListener('abort', () => resolve({ response: options.cancelId }))
      })
    }
    return Promise.resolve({ response })
  }
  return dialog
}

function setup({ answer, visible, clock } = {}) {
  const win = fakeWindow({ visible })
  const dialog = fakeDialog(answer)
  let quitting = false
  const quits = []
  const time = clock || { t: 1_000_000 }
  const timers = []
  const killed = []
  const recovery = attachRendererRecovery({
    win,
    dialog,
    appUrl: APP_URL,
    isQuitting: () => quitting,
    quit: () => quits.push(true),
    killProcess: (pid) => killed.push(pid),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    now: () => time.t,
  })
  const runTimers = () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn() })
  return {
    win, contents: win.webContents, dialog, recovery, quits, time, killed, timers, runTimers,
    setQuitting: (v) => { quitting = v },
  }
}

const gone = (contents, reason = 'oom', exitCode = 0) =>
  contents.emit('render-process-gone', {}, { reason, exitCode })

test('a crash shows ONE dialog that says saved work is safe, and Reload reloads the page', async () => {
  const { contents, dialog, recovery } = setup()
  gone(contents, 'oom')
  await recovery.settled()
  assert.strictEqual(dialog.shown.length, 1)
  const box = dialog.shown[0]
  assert.strictEqual(box.message, 'The window stopped working.')
  assert.match(box.detail, /ran out of memory/)
  assert.match(box.detail, /Everything you had saved is safe/)
  assert.deepStrictEqual(box.buttons, ['Reload this page', 'Open the project list', 'Quit'])
  assert.strictEqual(box.defaultId, CRASH.RELOAD)
  assert.strictEqual(contents.calls.reload, 1)
})

test('"Open the project list" loads the app root, and "Quit" quits', async () => {
  const home = setup({ answer: () => CRASH.HOME })
  gone(home.contents)
  await home.recovery.settled()
  assert.deepStrictEqual(home.contents.calls.loadURL, [APP_URL])
  assert.strictEqual(home.contents.calls.reload, 0)

  const quit = setup({ answer: () => CRASH.QUIT })
  gone(quit.contents)
  await quit.recovery.settled()
  assert.strictEqual(quit.quits.length, 1)
  assert.strictEqual(quit.contents.calls.reload, 0)
})

test('a second crash soon after recovering recommends the project list, not another reload', async () => {
  const s = setup()
  gone(s.contents)
  await s.recovery.settled()
  s.time.t += 30 * 1000
  gone(s.contents)
  await s.recovery.settled()
  const second = s.dialog.shown[1]
  assert.strictEqual(second.message, 'The window stopped working again.')
  assert.strictEqual(second.defaultId, CRASH.HOME)
  assert.strictEqual(second.cancelId, CRASH.HOME, 'Escape must not re-enter the loop')
  assert.deepStrictEqual(s.contents.calls.loadURL, [APP_URL])
})

test('POSITIVE CONTROL: a crash long after the last one is a first crash again', async () => {
  const s = setup()
  gone(s.contents)
  await s.recovery.settled()
  s.time.t += REPEAT_WINDOW_MS + 1
  gone(s.contents)
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown[1].defaultId, CRASH.RELOAD)
})

test('no dialog for a clean exit, while quitting, or after the window closed', async () => {
  const clean = setup()
  gone(clean.contents, 'clean-exit')
  assert.strictEqual(clean.dialog.shown.length, 0)

  const quitting = setup()
  quitting.setQuitting(true)
  gone(quitting.contents)
  assert.strictEqual(quitting.dialog.shown.length, 0)

  const closed = setup()
  closed.win.emit('closed')
  gone(closed.contents)
  assert.strictEqual(closed.dialog.shown.length, 0)
})

test('a close a page CANCELLED (beforeunload) does not silence later crashes', async () => {
  // 'close' fires on the attempt; only 'closed' means the window went away.
  const s = setup()
  s.win.emit('close')
  gone(s.contents)
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown.length, 1)
})

test('crashes while the crash dialog is open do not stack a second dialog', async () => {
  const s = setup({ answer: () => 'hold' })
  gone(s.contents)
  gone(s.contents, 'crashed')
  assert.strictEqual(s.dialog.shown.length, 1)
})

test('a crash before the window was ever shown gets an UNPARENTED dialog', async () => {
  const s = setup({ visible: false })
  gone(s.contents)
  await s.recovery.settled()
  assert.strictEqual(s.dialog.parents[0], null)

  const shown = setup({ visible: true })
  gone(shown.contents)
  await shown.recovery.settled()
  assert.strictEqual(shown.dialog.parents[0], shown.win)
})

test('a hang asks Wait / Reload, and "Wait" does nothing to the page', async () => {
  const s = setup({ answer: () => HANG.WAIT })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  const box = s.dialog.shown[0]
  assert.strictEqual(box.message, 'The window is not responding.')
  assert.deepStrictEqual(box.buttons, ['Wait', 'Reload the window'])
  assert.strictEqual(box.defaultId, HANG.WAIT)
  assert.strictEqual(s.contents.calls.reload, 0)
  assert.strictEqual(s.contents.calls.forcefullyCrashRenderer, 0)
})

test('"Reload the window" ends the hung renderer and reloads only once it is GONE — and never reports its own kill', async () => {
  const s = setup({ answer: () => HANG.RELOAD })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  assert.strictEqual(s.contents.calls.forcefullyCrashRenderer, 1)
  assert.strictEqual(s.contents.calls.reload, 0, 'reloading into a renderer that is still hung does nothing')
  gone(s.contents, 'killed') // the kill's own event
  // 🔴 Not inside the event handler: a synchronous reload there froze a real
  // Electron's MAIN process (measured). It runs on the next tick.
  assert.strictEqual(s.contents.calls.reload, 0, 'the reload must not run inside render-process-gone')
  s.runTimers()
  assert.strictEqual(s.contents.calls.reload, 1)
  assert.strictEqual(s.dialog.shown.length, 1, 'no crash dialog for the kill we asked for')
  assert.deepStrictEqual(s.killed, [], 'the fallback is cancelled once the process has gone')

  // POSITIVE CONTROL: the suppression is spent — a real crash afterwards is reported.
  gone(s.contents, 'oom')
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown.length, 2)
  assert.strictEqual(s.dialog.shown[1].message, 'The window stopped working.')
})

test('when forcefullyCrashRenderer does not end it, the renderer is ended by process id — then reloaded', async () => {
  // MEASURED in a real Electron 42: the documented call left the renderer in
  // crash handling for over a minute with no 'render-process-gone'.
  const s = setup({ answer: () => HANG.RELOAD })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  assert.strictEqual(s.timers.length, 1)
  assert.strictEqual(s.timers[0].ms, KILL_FALLBACK_MS)
  s.runTimers()
  assert.deepStrictEqual(s.killed, [4242])
  assert.strictEqual(s.contents.calls.reload, 0)
  gone(s.contents, 'killed')
  s.runTimers()
  assert.strictEqual(s.contents.calls.reload, 1)
  assert.strictEqual(s.dialog.shown.length, 1)
})

test("a second hang's kill never fires the first kill's timer at the first renderer's id", async () => {
  // The id of a renderer that has GONE may already belong to another process.
  const s = setup({ answer: () => HANG.RELOAD })
  s.win.emit('unresponsive') // renderer 4242
  await s.recovery.settled()
  gone(s.contents, 'killed') // it went on its own — its fallback must now do nothing
  s.win.emit('unresponsive') // renderer 4243, whose kill does NOT end by itself
  await s.recovery.settled()
  s.runTimers()
  assert.deepStrictEqual(s.killed, [4243])
})

test('a still-hung renderer does not raise a second hang dialog while its kill is in flight', async () => {
  const s = setup({ answer: () => HANG.RELOAD })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  s.win.emit('unresponsive')
  assert.strictEqual(s.dialog.shown.length, 1)
})

test('a kill that never produced an event does not silence later hangs once its grace runs out', async () => {
  let n = 0
  const s = setup({ answer: () => (n++ === 0 ? HANG.RELOAD : HANG.WAIT) })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  s.runTimers() // the fallback "kills" — and no render-process-gone ever arrives
  s.win.emit('unresponsive')
  assert.strictEqual(s.dialog.shown.length, 1, 'still in flight: no second dialog yet')
  s.time.t += DELIBERATE_KILL_GRACE_MS + 1
  s.win.emit('unresponsive')
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown.length, 2, 'the question is asked again once the kill has plainly failed')
})

test('a kill whose grace has run out explains nothing: a later crash is a crash', async () => {
  const s = setup({ answer: (o) => (o.message === 'The window is not responding.' ? HANG.RELOAD : o.defaultId) })
  s.win.emit('unresponsive')
  await s.recovery.settled()
  s.time.t += DELIBERATE_KILL_GRACE_MS + 1
  gone(s.contents, 'crashed')
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown.length, 2)
  assert.strictEqual(s.dialog.shown[1].message, 'The window stopped working.')
})

test('the hang dialog goes away by itself when the page responds again', async () => {
  const s = setup({ answer: () => 'hold' })
  s.win.emit('unresponsive')
  assert.strictEqual(s.dialog.shown.length, 1)
  s.win.emit('unresponsive') // repeated while open: still one dialog
  assert.strictEqual(s.dialog.shown.length, 1)
  s.win.emit('responsive')
  await s.recovery.settled()
  assert.strictEqual(s.contents.calls.reload, 0)
  assert.strictEqual(s.contents.calls.forcefullyCrashRenderer, 0)
})

test('a crash while the hang dialog is open replaces it with the crash dialog', async () => {
  let n = 0
  const s = setup({ answer: (o) => (n++ === 0 ? 'hold' : o.defaultId) })
  s.win.emit('unresponsive')
  gone(s.contents, 'oom')
  await s.recovery.settled()
  assert.strictEqual(s.dialog.shown.length, 2)
  assert.strictEqual(s.dialog.shown[0].signal.aborted, true, 'the hang question was withdrawn')
  assert.strictEqual(s.dialog.shown[1].message, 'The window stopped working.')
  assert.strictEqual(s.contents.calls.reload, 1)
})

test('a dialog that throws is logged and does not wedge recovery', async () => {
  const win = fakeWindow()
  const logs = []
  let calls = 0
  const dialog = {
    showMessageBox: () => (calls++ === 0 ? Promise.reject(new Error('no display')) : Promise.resolve({ response: 0 })),
  }
  const recovery = attachRendererRecovery({
    win, dialog, appUrl: APP_URL, isQuitting: () => false, quit: () => {}, log: (m) => logs.push(m),
  })
  gone(win.webContents)
  await recovery.settled()
  assert.ok(logs.some((m) => /crash dialog failed/.test(m)))
  gone(win.webContents)
  await recovery.settled()
  assert.strictEqual(calls, 2, 'the next crash is still reported')
})

test('main.js wires it onto the MAIN window (a source scan: the one link a headless suite cannot drive)', () => {
  // Every rule above is tested through fakes; whether main.js calls the module
  // at all is not, because main.js needs a real Electron. Deleting the call
  // leaves the require in place, so packaged-files.test.js cannot see it
  // either. ⚠️ A scan proves the CALL is written, not that the dialog appears —
  // that half is a packaged-build check (RELEASING §4b), like #716's.
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const start = src.indexOf('function createMainWindow(')
  const end = src.indexOf('function setupUpdater(')
  assert.ok(start > 0 && end > start, 'createMainWindow must still be found — else this scan checks nothing')
  const body = src.slice(start, end)
  assert.match(body, /new BrowserWindow\(/, 'the scanned slice must be the function that creates the window')
  assert.match(body, /attachRendererRecovery\(\{\s*win: mainWindow,/)
})

test('crashDialogOptions names an unknown reason plainly and carries the details line', () => {
  const box = crashDialogOptions({ reason: 'something-new', exitCode: 7 })
  assert.match(box.detail, /^The page stopped unexpectedly\./)
  assert.match(box.detail, /Details: something-new, exit code 7$/)
})
