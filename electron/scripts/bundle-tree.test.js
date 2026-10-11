// Tests for bundle-tree.js (#1122). The mac leg trusts this comparison to say whether the app
// an updater unpacks from the zip is the app that was built, so these use REAL symlinks and
// REAL modes on disk, and pin each way an archive can change a bundle: a symlink stored as
// what it points to (#9846), a lost executable bit, a changed byte, a missing or extra file.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { MODE_BITS, snapshot, compareSnapshots, summarise, main } = require('./bundle-tree.js')

/**
 * A miniature .app with the shapes that matter: a framework whose `Versions/Current` and
 * top-level entries are symlinks, an executable, a plain resource.
 */
function miniApp(root) {
  const app = path.join(root, 'Mini.app')
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework')
  fs.mkdirSync(path.join(fw, 'Versions', 'A', 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Electron Framework'), 'mach-o bytes')
  fs.chmodSync(path.join(fw, 'Versions', 'A', 'Electron Framework'), 0o755)
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), '<plist/>')
  fs.symlinkSync('A', path.join(fw, 'Versions', 'Current'))
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(fw, 'Electron Framework'))
  fs.symlinkSync('Versions/Current/Resources', path.join(fw, 'Resources'))
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Mini'), 'launcher')
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'Mini'), 0o755)
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'LICENSE.electron.txt'), 'MIT')
  fs.chmodSync(path.join(app, 'Contents', 'Resources', 'LICENSE.electron.txt'), 0o644)
  return app
}

function pair() {
  return [miniApp(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-a-'))), miniApp(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-b-')))]
}

const diff = (a, b) => compareSnapshots(snapshot(a), snapshot(b))

test('two copies of the same bundle compare identical', () => {
  const [a, b] = pair()
  assert.deepEqual(diff(a, b), [])
})

test('a symlink is recorded by its own target and never followed', () => {
  const [a] = pair()
  const s = snapshot(a)
  assert.equal(s.get('Contents/Frameworks/Electron Framework.framework/Versions/Current'), 'link -> A')
  // Not followed: nothing is listed UNDER the link, though its target holds files.
  assert.ok(![...s.keys()].some((k) => k.startsWith('Contents/Frameworks/Electron Framework.framework/Versions/Current/')))
  assert.deepEqual(summarise(s), { entries: s.size, links: 3, executables: 2 })
})

test('#9846: Versions/Current stored as a real folder instead of a link is caught', () => {
  const [a, b] = pair()
  const current = path.join(b, 'Contents/Frameworks/Electron Framework.framework/Versions/Current')
  fs.unlinkSync(current)
  fs.cpSync(path.join(path.dirname(current), 'A'), current, { recursive: true })
  const lines = diff(a, b)
  assert.ok(lines.some((l) => l.startsWith('differs: Contents/Frameworks/Electron Framework.framework/Versions/Current\n') && /built: {4}link -> A/.test(l) && /unpacked: dir/.test(l)))
  assert.ok(lines.some((l) => l.startsWith('only in the unpacked app: Contents/Frameworks/Electron Framework.framework/Versions/Current/')))
})

test('a top-level framework link dereferenced to a file is caught', () => {
  const [a, b] = pair()
  const link = path.join(b, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
  fs.unlinkSync(link)
  fs.writeFileSync(link, 'mach-o bytes')
  assert.equal(diff(a, b).length, 1)
})

test('a lost executable bit is caught', () => {
  const [a, b] = pair()
  fs.chmodSync(path.join(b, 'Contents', 'MacOS', 'Mini'), 0o644)
  const lines = diff(a, b)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /built: {4}file 555 /)
  assert.match(lines[0], /unpacked: file 444 /)
})

test('write bits alone are not a difference (MODE_BITS leaves them out on purpose)', () => {
  assert.equal(MODE_BITS & 0o222, 0)
  const [a, b] = pair()
  fs.chmodSync(path.join(b, 'Contents', 'Resources', 'LICENSE.electron.txt'), 0o664)
  assert.deepEqual(diff(a, b), [])
})

test('a changed byte, a missing file, an extra file and a retargeted link are each caught', () => {
  const [a, b] = pair()
  fs.writeFileSync(path.join(b, 'Contents', 'MacOS', 'Mini'), 'launcheR')
  fs.unlinkSync(path.join(b, 'Contents', 'Resources', 'LICENSE.electron.txt'))
  fs.writeFileSync(path.join(b, 'Contents', 'Resources', 'extra'), 'x')
  const fwr = path.join(b, 'Contents/Frameworks/Electron Framework.framework/Resources')
  fs.unlinkSync(fwr)
  fs.symlinkSync('Versions/A/Resources', fwr)
  const lines = diff(a, b)
  assert.equal(lines.length, 4)
  assert.ok(lines.some((l) => l.startsWith('differs: Contents/MacOS/Mini\n')))
  assert.ok(lines.some((l) => l.startsWith('missing from the unpacked app: Contents/Resources/LICENSE.electron.txt')))
  assert.ok(lines.some((l) => l.startsWith('only in the unpacked app: Contents/Resources/extra')))
  assert.ok(lines.some((l) => /Resources\n {4}built: {4}link -> Versions\/Current\/Resources\n {4}unpacked: link -> Versions\/A\/Resources/.test(l)))
})

test('main: 0 and the counts when identical, 1 when not, and an empty bundle is refused', (t) => {
  const out = []
  t.mock.method(console, 'log', (s) => out.push(s))
  t.mock.method(console, 'error', (s) => out.push(s))
  const [a, b] = pair()
  assert.equal(main(['compare', a, b]), 0)
  assert.match(out.at(-1), /identical — \d+ entries, 3 symlinks, 2 executable files/)
  fs.chmodSync(path.join(b, 'Contents', 'MacOS', 'Mini'), 0o644)
  assert.equal(main(['compare', a, b]), 1)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-empty-'))
  assert.throws(() => main(['compare', empty, b]), /is empty/)
  assert.throws(() => main(['diff', a, b]), /usage/)
})
