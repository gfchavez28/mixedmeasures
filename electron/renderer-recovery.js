// What the window does when its page crashes or stops responding (#1046).
//
// Before this, nothing listened for either. A renderer that ran out of memory
// (#1045: opening a 122,382-participant dataset) left Electron showing the dead
// page's white background — no message, no way back but killing the app, and
// nothing to say the researcher's work was safe. It was: the backend is a
// separate process and every save had already reached it.
//
// Same Electron-free split as updater.js and fatal-error.js: the window, its
// webContents and `dialog` are INJECTED, so every rule here is unit-tested
// headlessly (renderer-recovery.test.js); main.js only wires it.
//
// ⚠️ fatal-error.js's dialog is for the BACKEND failing to start (#716) and ends
// by quitting. This one keeps the app alive and offers the way back, because
// here the backend is fine and only the page died.

'use strict'

/** A second crash this soon after recovering from one suggests the page itself
 *  is what fails, so the dialog stops recommending a reload of it. */
const REPEAT_WINDOW_MS = 2 * 60 * 1000

/** How long after a deliberate kill (the "Reload the window" answer to a hang)
 *  its own `render-process-gone` is expected — and must not be reported as a
 *  crash, which would put a second dialog on top of the reload just asked for. */
const DELIBERATE_KILL_GRACE_MS = 10 * 1000

/** How long `forcefullyCrashRenderer()` gets to end a hung renderer before it
 *  is ended by process id instead. MEASURED in a real Electron 42 (WSL): the
 *  documented call made the renderer log "Crashing because hung" and then sit
 *  in crash handling for over 60 s without exiting, so no `render-process-gone`
 *  ever came and the reload had nothing to reload into. A SIGKILL from outside
 *  ended the same renderer at once (reason `killed`). */
const KILL_FALLBACK_MS = 3 * 1000

const CRASH_BUTTONS = ['Reload this page', 'Open the project list', 'Quit']
const CRASH = { RELOAD: 0, HOME: 1, QUIT: 2 }
const HANG_BUTTONS = ['Wait', 'Reload the window']
const HANG = { WAIT: 0, RELOAD: 1 }

/** Electron's `render-process-gone` reasons, in the words a researcher reads. */
const REASON_WORDS = {
  oom: 'ran out of memory',
  crashed: 'stopped unexpectedly',
  'abnormal-exit': 'stopped unexpectedly',
  killed: 'was stopped by the system',
  'launch-failed': 'could not start',
  'integrity-failure': 'failed a security check',
  'memory-eviction': 'was closed by the system to free memory',
}

const SAVED_WORK =
  'Everything you had saved is safe: your projects are kept by the part of Mixed Measures '
  + 'that is still running, not by this window. Anything typed but not yet saved may be lost.'

/**
 * The crash dialog. `repeat` = it happened again soon after the last recovery,
 * so "Open the project list" becomes the default: reloading a page that fails
 * on load would only loop.
 */
function crashDialogOptions({ reason, exitCode = null, repeat = false }) {
  const words = REASON_WORDS[reason] || 'stopped unexpectedly'
  const detailParts = [`The page ${words}. ${SAVED_WORK}`]
  if (repeat) {
    detailParts.push(
      'It happened again soon after the last reload, so this page may be what is failing. '
      + 'Opening the project list starts again from a different page.',
    )
  }
  detailParts.push(`Details: ${reason || 'unknown'}${exitCode == null ? '' : `, exit code ${exitCode}`}`)
  const recommended = repeat ? CRASH.HOME : CRASH.RELOAD
  return {
    type: 'error',
    title: 'Mixed Measures',
    message: repeat ? 'The window stopped working again.' : 'The window stopped working.',
    detail: detailParts.join('\n\n'),
    buttons: CRASH_BUTTONS,
    defaultId: recommended,
    // Escape takes the recommended way back: a dismissed dialog over a dead
    // page would leave exactly the white window this exists to replace.
    cancelId: recommended,
    noLink: true,
  }
}

function hangDialogOptions() {
  return {
    type: 'warning',
    title: 'Mixed Measures',
    message: 'The window is not responding.',
    detail:
      'It may be busy with a very large list or calculation. You can wait for it to finish, '
      + 'or reload the window. Everything you had saved is safe; anything typed but not yet '
      + 'saved may be lost if you reload.',
    buttons: HANG_BUTTONS,
    defaultId: HANG.WAIT,
    cancelId: HANG.WAIT,
    noLink: true,
  }
}

/**
 * Wire crash and hang recovery onto a BrowserWindow.
 *
 * @param {object} opts
 * @param {object} opts.win         the BrowserWindow (EventEmitter + webContents, isDestroyed, isVisible)
 * @param {object} opts.dialog      Electron's `dialog` (only `showMessageBox` is used)
 * @param {string} opts.appUrl      the app's root, loaded by "Open the project list"
 * @param {() => boolean} opts.isQuitting  true once the app is on its way out
 * @param {() => void} opts.quit    quits the app
 * @param {(pid: number) => void} [opts.killProcess]  ends a process by id (the hang fallback)
 * @param {typeof setTimeout} [opts.setTimer]
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ settled: () => Promise<void> }} `settled` resolves once any open
 *   dialog has been answered and acted on — for tests.
 */
function attachRendererRecovery({
  win,
  dialog,
  appUrl,
  isQuitting,
  quit,
  killProcess = (pid) => process.kill(pid, 'SIGKILL'),
  setTimer = setTimeout,
  now = Date.now,
  log = () => {},
}) {
  const contents = win.webContents
  let closing = false
  let crashDialogOpen = false
  let hangDialog = null // the AbortController of an open "not responding" dialog
  let lastRecoveryAt = null
  let deliberateKill = null // { until } while a kill the researcher asked for is in flight
  let pending = Promise.resolve()

  const windowAlive = () => !closing && !isQuitting() && !win.isDestroyed()

  // A native dialog parented to a window that has not been shown yet (a crash
  // during the first load, before `ready-to-show`) can itself be invisible on
  // Windows — so it is only parented to a visible window.
  const show = (options) => (win.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))

  const closeHangDialog = () => {
    if (hangDialog) hangDialog.abort()
    hangDialog = null
  }

  // In flight = asked for and not yet expired. ⚠️ Never test `deliberateKill`
  // alone: a kill that produces no event (the fallback could not end the
  // process) would otherwise stay "in flight" forever and silence every later
  // hang dialog.
  const killInFlight = () => deliberateKill !== null && now() < deliberateKill.until

  const endDeliberateKill = () => { deliberateKill = null }

  // ⚠️ 'closed', not 'close': a page's `beforeunload` (WritingCanvas registers
  // one) can CANCEL a close, and a flag set on the attempt would then stay set
  // and silence every later crash. A page going away with its window exits
  // cleanly ('clean-exit', ignored below) or after the window is destroyed.
  win.on('closed', () => {
    closing = true
    closeHangDialog()
    endDeliberateKill()
  })

  const failed = (what) => (err) => {
    log(`renderer: the ${what} dialog failed (${(err && err.message) || err})`)
  }

  contents.on('render-process-gone', (_event, details = {}) => {
    const { reason, exitCode } = details
    if (killInFlight()) {
      // The kill the researcher asked for. Not a crash to report — and only
      // NOW is the old renderer gone, so only now does a reload get a fresh
      // one (reloading into a renderer that is still hung does nothing).
      endDeliberateKill()
      log(`renderer: ended at the researcher's request (${reason}); reloading`)
      // 🔴 NEXT TICK, never inside this handler. MEASURED in a real Electron
      // 42: `reload()` called synchronously from 'render-process-gone', after
      // the hung renderer had been killed, froze the MAIN process — its
      // heartbeat stopped and the window never loaded. Deferred one tick, the
      // same sequence reloaded in 0.1 s. (The crash path reloads after its
      // dialog is answered, which is already a later tick.)
      setTimer(() => { if (windowAlive()) contents.reload() }, 0)
      return
    }
    endDeliberateKill() // a kill whose grace ran out no longer explains anything
    if (reason === 'clean-exit') return
    if (!windowAlive() || crashDialogOpen) return
    closeHangDialog()
    const repeat = lastRecoveryAt !== null && now() - lastRecoveryAt < REPEAT_WINDOW_MS
    log(`renderer: process gone (${reason}${exitCode == null ? '' : `, exit code ${exitCode}`})${repeat ? ', again' : ''}`)
    crashDialogOpen = true
    pending = show(crashDialogOptions({ reason, exitCode, repeat }))
      .then(({ response }) => {
        if (!windowAlive()) return
        lastRecoveryAt = now()
        if (response === CRASH.QUIT) quit()
        else if (response === CRASH.HOME) contents.loadURL(appUrl)
        else contents.reload()
      })
      .catch(failed('crash'))
      .finally(() => { crashDialogOpen = false })
  })

  win.on('unresponsive', () => {
    if (!windowAlive() || hangDialog || crashDialogOpen || killInFlight()) return
    const controller = new AbortController()
    hangDialog = controller
    log('renderer: not responding')
    pending = show({ ...hangDialogOptions(), signal: controller.signal })
      .then(({ response }) => {
        // An aborted dialog answers with its cancelId; the page recovered (or
        // the window closed) and there is nothing to do.
        if (controller.signal.aborted || !windowAlive()) return
        if (response !== HANG.RELOAD) return
        // A hung renderer cannot run the unload a plain reload() waits for, so
        // it is ended first and the reload happens on its 'render-process-gone'
        // (above). `forcefullyCrashRenderer()` is Electron's documented call;
        // KILL_FALLBACK_MS records why it is not trusted alone.
        const pid = contents.getOSProcessId()
        const kill = { until: now() + DELIBERATE_KILL_GRACE_MS }
        setTimer(() => {
          // 🔴 Only THIS kill's process, and only while it has not gone. Once
          // its 'render-process-gone' arrives the id may be reused by any
          // process on the machine; and a second hang's kill must not fire the
          // first one's timer at the first one's id.
          if (deliberateKill !== kill) return
          log(`renderer: process ${pid} still running ${KILL_FALLBACK_MS} ms after forcefullyCrashRenderer; ending it`)
          try {
            killProcess(pid)
          } catch (err) {
            log(`renderer: could not end process ${pid} (${(err && err.message) || err})`)
          }
        }, KILL_FALLBACK_MS)
        deliberateKill = kill
        contents.forcefullyCrashRenderer()
      })
      .catch(failed('not-responding'))
      .finally(() => { if (hangDialog === controller) hangDialog = null })
  })

  // The page came back on its own: take the question away.
  win.on('responsive', closeHangDialog)

  return { settled: () => pending }
}

module.exports = {
  REPEAT_WINDOW_MS,
  DELIBERATE_KILL_GRACE_MS,
  KILL_FALLBACK_MS,
  CRASH,
  HANG,
  crashDialogOptions,
  hangDialogOptions,
  attachRendererRecovery,
}
