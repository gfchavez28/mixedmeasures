const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// #1051 — every export's Save dialog was titled "blob:http://127.0.0.1:<port>/<uuid>".
// Electron titles a download's dialog with its URL when none is set
// (electron_download_manager_delegate.cc on 44-x-y, read 2026-10-05:
// `if (settings.title.empty()) settings.title = item->GetURL().spec();` and, two lines
// on, `if (settings.default_path.empty()) settings.default_path = default_path;`).
//
// The handler lives in main.js, which needs Electron to load (the module is kept
// inline deliberately: a new packaged module would change `build.files`, which is a
// pipeline change after the 1.5.6 rc). So its shape is read from the source, the way
// fatal-error.test.js reads main.js's crash wiring. The behaviour itself is proved by
// driving the shell (the save dialog's title is visible on Linux GTK).
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').replace(/\/\/.*$/gm, '')

function handler() {
  const start = main.indexOf("session.defaultSession.on('will-download'")
  assert.ok(start >= 0, 'main.js no longer registers a will-download handler (#1051)')
  return main.slice(start, main.indexOf('})', start) + 2)
}

test('#1051 — the app titles its own save dialogs with the file name, not the blob URL', () => {
  assert.match(handler(), /item\.setSaveDialogOptions\(\{\s*title:\s*`Save “\$\{item\.getFilename\(\)\}”`\s*\}\)/)
})

test('#1051 — it is scoped to this app’s own origin, as the loopback token is', () => {
  assert.match(handler(), /if \(`\$\{item\.getInitiatorOrigin\(\)\}\/` !== appOrigin\) return/)
})

test('#1051 — it sets NO defaultPath, which would pin a folder over Chromium’s last-used one', () => {
  assert.doesNotMatch(handler(), /defaultPath/)
})
