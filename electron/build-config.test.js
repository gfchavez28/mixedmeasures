const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Two ways the packaging config breaks with every gate green. Both are release-time
// failures — they surface on the tool that BUILDS and SIGNS, in the middle of a cut.
//
// 1) A key electron-builder REMOVED. v26 deleted `win.publisherName` and declares
//    WindowsConfiguration.additionalProperties = false, so a stale key does not get
//    ignored — it fails config validation and the build stops. The schema ships INSIDE
//    the installed toolchain (`app-builder-lib/scheme.json`), so validating against it
//    here is the standing enumeration-debt remedy: derive the requirement from the
//    artifact the next variant must touch. The next major's removals then fail
//    `npm test` on the bump commit rather than mid-release.
//
// 2) `publisherName` going missing. It is what electron-updater compares a downloaded
//    update's Authenticode subject against, and electron-updater SKIPS Windows update
//    signature verification ENTIRELY when it is absent — a silent security downgrade
//    that installs, launches and passes every other gate. It cannot live in
//    package.json any more: v26 picks the signing manager by the mere PRESENCE of
//    `win.azureSignOptions` (winPackager.js), so a block here would engage Azure
//    signing on the credential-free unsigned path this repo deliberately supports.
//    It therefore lives in release.yml, where nothing else in `npm test` can see it —
//    hence the workflow assertions below.

const ELECTRON_DIR = __dirname
const REPO_ROOT = path.join(ELECTRON_DIR, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'))
const schema = require('app-builder-lib/scheme.json')

/** Resolve a schema node to the definition objects it can be, following $ref/anyOf/allOf/oneOf. */
function resolveNodes(node, seen = new Set()) {
  if (node == null || typeof node !== 'object') return []
  if (node.$ref) {
    const name = node.$ref.split('/').pop()
    if (seen.has(name)) return []
    seen.add(name)
    return resolveNodes(schema.definitions[name], seen)
  }
  const branches = [...(node.anyOf ?? []), ...(node.allOf ?? []), ...(node.oneOf ?? [])]
  if (branches.length > 0) return branches.flatMap((b) => resolveNodes(b, seen))
  return node.properties || node.additionalProperties !== undefined ? [node] : []
}

/**
 * Keys of `value` that the schema node forbids.
 *
 * Only reports a key when EVERY resolved definition is closed (additionalProperties
 * false) and none declares it — so an unresolvable or open definition is skipped
 * rather than guessed at. This fails exactly where electron-builder itself fails.
 */
function unknownKeys(value, node, trail) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return []
  const nodes = resolveNodes(node).filter((n) => n.properties)
  if (nodes.length === 0) return []
  const closed = nodes.filter((n) => n.additionalProperties === false)
  const declared = new Set(nodes.flatMap((n) => Object.keys(n.properties)))

  const found = []
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) {
      if (closed.length === nodes.length) found.push(`${trail}${key}`)
      continue
    }
    for (const n of nodes) {
      if (n.properties[key]) found.push(...unknownKeys(value[key], n.properties[key], `${trail}${key}.`))
    }
  }
  return [...new Set(found)]
}

test('build config contains no key the installed electron-builder rejects', () => {
  const bad = unknownKeys(pkg.build, schema, 'build.').sort()
  assert.deepEqual(
    bad,
    [],
    `These keys are not in app-builder-lib@${require('app-builder-lib/package.json').version}'s ` +
      `schema, and the enclosing definitions are closed (additionalProperties: false), so ` +
      `electron-builder will FAIL config validation mid-release: ${bad.join(', ')}`
  )
})

test('win.publisherName has not come back to package.json', () => {
  // Removed in v26. Re-adding it fails the build; adding an azureSignOptions block here
  // instead would be worse — it would silently engage Azure signing on the unsigned path.
  assert.equal(pkg.build.win.publisherName, undefined, 'win.publisherName was removed in electron-builder 26')
  assert.equal(
    pkg.build.win.azureSignOptions,
    undefined,
    'azureSignOptions must stay in release.yml — its mere presence selects the Azure signing manager'
  )
})

test('verifyUpdateCodeSignature is not disabled', () => {
  // PublishManager only writes the computed publisher into app-update.yml when
  // `isForceCodeSigningVerification` is true, and that getter is exactly
  // `verifyUpdateCodeSignature !== false`. Turning it off drops publisherName from the
  // shipped manifest as a side effect, which reads as unrelated.
  assert.notEqual(
    pkg.build.win.verifyUpdateCodeSignature,
    false,
    'setting this false also strips publisherName from app-update.yml, disabling update signature verification'
  )
})

test('the Mac app declares its macOS floor, as a version the update feed can carry (#1118)', () => {
  // Electron 44's own Info.plist says 13.0, but the backend's numpy/scipy are macOS 14
  // builds, so the floor is set here and the release's macos-floor step proves it against
  // every binary. darwinForMacos throws on anything the feed cannot express.
  const { darwinForMacos } = require('./scripts/macos-floor.js')
  const declared = pkg.build.mac.minimumSystemVersion
  assert.equal(typeof declared, 'string', 'build.mac.minimumSystemVersion is not set')
  assert.match(darwinForMacos(declared), /^\d+\.\d+\.\d+$/)
})

// --- the half that lives in the release workflow -------------------------------------

const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows')
const releaseYml = fs.readFileSync(path.join(WORKFLOWS_DIR, 'release.yml'), 'utf8')
const ciYml = fs.readFileSync(path.join(WORKFLOWS_DIR, 'ci.yml'), 'utf8')

test('every workflow job names its machine — no `-latest` label (#1097, #1119)', () => {
  // A `-latest` label is a build machine someone else chooses. ubuntu-latest moving to 26.04
  // would silently re-anchor the R oracles (R 4.5.2) and raise the AppImage's glibc floor;
  // the mac runner decides which wheels pip picks, and so the app's macOS floor (#1118).
  //
  // ⚠️ The workflow SET differs between the two repos: the public sync strips docs.yml (a
  // private-only gate), and naming it here failed the public CI on 2026-10-04 while the private
  // one was green. So read whatever workflows exist, and require only the two that ship.
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))
  for (const required of ['ci.yml', 'release.yml']) assert.ok(files.includes(required), `${required} is missing`)
  const labels = []
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8').split('\n')) {
      const m = /^\s*(?:runs-on|- os):\s*(\S+)/.exec(line.replace(/\s+#.*$/, ''))
      if (!m || m[1].startsWith('${{')) continue
      labels.push(`${name}: ${m[1]}`)
    }
  }
  // Population check: a pattern that matched nothing would pass any workflow. ci.yml has three
  // jobs and release.yml five labels (verify, three package legs, finalize), in both repos.
  assert.ok(labels.length >= 8, `found only ${labels.length} runner labels: ${labels.join(', ')}`)
  const floating = labels.filter((l) => !/: (ubuntu|macos|windows)-\d/.test(l) || /latest/.test(l))
  assert.deepEqual(floating, [], `pin these to a versioned image (a label change is a pipeline change, RELEASING §3b)`)
})

test('both workflows that install R assert the 4.3.3 anchor (#1097)', () => {
  const assertion = `Rscript -e 'v <- getRversion(); if (v != "4.3.3") stop("R ", v, " is installed; the R oracles are anchored to 4.3.3")'`
  for (const [name, text] of [['ci.yml', ciYml], ['release.yml', releaseYml]]) {
    assert.ok(text.includes(assertion), `${name} installs R without asserting its version`)
    assert.ok(
      text.indexOf(assertion) < text.indexOf('install.packages("irr"'),
      `${name}: assert the version before anything is built against it`,
    )
  }
})

test('the release workflow proves the macOS floor, stamps the feed, checks it, and reads the fuses', () => {
  // Each is the only guard of its kind; a refactor that drops one leaves every gate green.
  for (const [what, needle] of [
    ['the floor check on the built .app (#1118)', 'node scripts/macos-floor.js check "$APP"'],
    ['the feed stamp from that check (#1100)', 'node scripts/update-manifest.js min-os release/latest-mac.yml "$DARWIN"'],
    ['the merged feed assertion (#1100)', 'node electron/scripts/update-manifest.js check-min-os "$WORK/latest-mac.yml"'],
    ['the packaged fuse read-back (#1100)', 'node scripts/check-fuses.js "$TARGET"'],
    ["Electron's own advisories against the locked runtime (#1094)", 'run: node scripts/electron-advisories.js'],
    ["Electron's and Chromium's licence notices in what each leg built (#1122)", 'node scripts/check-notices.js "$TARGET"'],
    ["the update zip unpacked as Squirrel.Mac unpacks it (#1122)", 'env -i DITTOABORT=1 /usr/bin/ditto -xk'],
    ['the unpacked update compared with the built app (#1122)', 'node scripts/bundle-tree.js compare "$APP" "$NEW"'],
    ['the comparison held to a zip that follows symlinks (#1122)', '/usr/bin/zip -qr0 "$W/ctl-deref.zip"'],
    ["Squirrel's signature check against the last published release (#1122)", 'codesign --verify --deep --strict --all-architectures -R "=$DR" "$NEW"'],
  ]) {
    assert.ok(releaseYml.includes(needle), `release.yml no longer runs ${what}`)
  }
  // The stamp must precede the per-arch upload that publishes it.
  assert.ok(
    releaseYml.indexOf('update-manifest.js min-os') < releaseYml.indexOf('cp release/latest-mac.yml "latest-mac-'),
    'the feed is uploaded before it is stamped',
  )
  // The zip check must precede that upload too: failing there leaves the draft with no mac
  // manifest, so finalize-mac-manifest fails and the draft cannot be shipped.
  assert.ok(
    releaseYml.indexOf('node scripts/bundle-tree.js compare') < releaseYml.indexOf('cp release/latest-mac.yml "latest-mac-'),
    'the mac manifest is uploaded before the update zip is checked',
  )
})

test('every ticket-service call in release.yml goes through scripts/stapler.js, self-tested before publishing (#1293)', () => {
  // `xcrun stapler` asks Apple's ticket service about the file. At the v1.5.7 cut one dropped call
  // failed the mac leg three times, on three different calls, and two of them sent stapler's
  // output to /dev/null. The helper retries a drop and prints a failure. A bare call is the old shape.
  // (electron-builder's own staple of the .app happens inside the tool, not in this file.)
  const code = releaseYml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(code, /\bxcrun\s+stapler\b/, 'call stapler as `node scripts/stapler.js <staple|validate> <file>`')
  // Population: the five calls the mac leg makes, so a rename cannot pass this vacuously.
  for (const call of [
    /node scripts\/stapler\.js staple "\$DMG"/,
    /node scripts\/stapler\.js validate "\$DMG"/,
    /if node scripts\/stapler\.js validate "\$NEW"; then/,
    /ticket "stapler validate \(\.app notarization\)"\s+"\$APP"/,
    /ticket "stapler validate \(\.dmg\)" "\$DMG"/,
  ]) {
    assert.match(code, call, 'release.yml no longer makes this ticket call through the helper')
  }
  assert.match(code, /ticket\(\) \{[^\n]*\n\s+node scripts\/stapler\.js validate "\$2"\n/, 'ticket() no longer calls the helper')
  // The Gatekeeper gate prints a failing check's output instead of discarding it.
  const gate = releaseYml.slice(releaseYml.indexOf('- name: Verify — codesign + notarization + Gatekeeper (macOS)'))
  const gateBody = gate.slice(0, gate.indexOf('\n      - name:', 1))
  assert.doesNotMatch(gateBody, /\/dev\/null/, 'the Gatekeeper gate discards a check\'s output again')
  // The self-test runs on the mac leg before anything reaches the draft.
  const selfTest = code.indexOf('run: node scripts/stapler.js --self-test')
  assert.notEqual(selfTest, -1, 'the mac leg no longer self-tests the retry')
  assert.ok(selfTest < code.indexOf('- name: Package & publish'), 'the retry self-test must run before anything is published')
})

test('the licence-notice check runs on every leg, not only the mac one (#1122)', () => {
  // The step reads the .app on mac and <target>-unpacked elsewhere; an `if:` added to it would
  // silently drop Windows and Linux.
  const step = releaseYml.slice(releaseYml.indexOf("- name: Verify — the app carries Electron's and Chromium's licence notices"))
  const body = step.slice(0, step.indexOf('\n      - name:', 1))
  assert.ok(body.includes('node scripts/check-notices.js "$TARGET"'), 'the notice step no longer runs the check')
  assert.doesNotMatch(body, /^\s+if:/m, 'the notice step must run on every leg')
})

test('release.yml supplies publisherName on the signed Windows path', () => {
  assert.match(
    releaseYml,
    /--config\.win\.azureSignOptions\.publisherName=/,
    'without this, app-update.yml ships no publisherName and electron-updater silently ' +
      'stops verifying Windows update signatures — a downgrade no fresh install can surface'
  )
})

test('release.yml uses the timestamp keys electron-builder 26 actually reads', () => {
  // v25 had no timestamp default and passed CAPITALISED keys through its extraSigningArgs
  // spread. v26 destructures lowercase timestampRfc3161/timestampDigest out of that spread
  // and then overwrites the spread values with its own defaults — so a capitalised key is
  // discarded, and only coincidentally-identical defaults made it look like it worked.
  assert.match(releaseYml, /--config\.win\.azureSignOptions\.timestampRfc3161=/, 'must be lowercase for v26')
  assert.match(releaseYml, /--config\.win\.azureSignOptions\.timestampDigest=/, 'must be lowercase for v26')
  assert.doesNotMatch(
    releaseYml,
    /--config\.win\.azureSignOptions\.Timestamp(Rfc3161|Digest)=/,
    'the capitalised v25 spelling lands in extraSigningArgs and is then overwritten by v26 defaults'
  )
})

// --- #1610: the two aggregating mac steps run every check under GitHub's own invocation ------
//
// GitHub runs `shell: bash` (the package job's default) as `bash --noprofile --norc -eo pipefail`,
// and `set -uo pipefail` does not clear the -e. So a step that says "NOT -e: run every check,
// aggregate, decide at the end" exited at its first failed check, before printing it: on the
// unsigned path with nothing after the header line, on the signed path without the failing
// check's output. Both steps now turn errexit off first. The Gatekeeper step is RUN here, the way
// GitHub runs it, with stand-in tools; the update-zip step (ditto, plutil, zip, gh) is held by the
// static check only. Not a skip when bash is missing: a skip is green.

/** Every step of a workflow text, as { name, body } — `body` is the `run: |` block, de-indented. */
function workflowSteps(text) {
  return text.split('\n      - name: ').slice(1).map((chunk) => {
    const lines = chunk.split('\n')
    const name = lines[0].trim()
    const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l))
    if (at === -1) return { name, body: null }
    const first = lines.slice(at + 1).find((l) => l.trim() !== '')
    const indent = first.match(/^\s*/)[0]
    const body = []
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === '') body.push('')
      else if (l.startsWith(indent)) body.push(l.slice(indent.length))
      else break
    }
    return { name, body: body.join('\n') }
  })
}

/** The steps that promise "NOT -e", and those of them whose first command does not turn errexit off. */
function errexitPromises(text) {
  const named = workflowSteps(text).filter((s) => s.body?.includes('NOT -e'))
  const broken = named.filter((s) => {
    const firstCommand = s.body.split('\n').find((l) => l.trim() !== '' && !/^\s*#/.test(l))
    return firstCommand?.trim() !== 'set +e'
  })
  return { named: named.map((s) => s.name), broken: broken.map((s) => s.name) }
}

const GATEKEEPER_STEP = 'Verify — codesign + notarization + Gatekeeper (macOS)'
const UPDATE_ZIP_STEP = 'Verify — the update zip unpacks to the built app, as Squirrel.Mac unpacks it (macOS)'

/**
 * Run a step body as GitHub runs it, in a scratch folder holding release/Mixed Measures.app and
 * .dmg, with stand-in codesign, spctl and stapler (scripts/stapler.js, through a stand-in node).
 * stdout and stderr share one file, so the lines keep the order the step printed them in.
 */
function runMacStep(body, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-1610-'))
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(path.join(dir, 'release', 'Mixed Measures.app'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'release', 'Mixed Measures.dmg'), '')
    fs.mkdirSync(bin)
    const tool = (name, script) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 })
    tool('codesign', [
      'case "$1" in',
      '  --verify) if [ -n "${UNSIGNED:-}" ]; then echo "stand-in codesign --verify: not signed" >&2; exit 1; fi ;;',
      '  --display) if [ -n "${UNSIGNED:-}" ]; then echo "stand-in codesign --display: not signed" >&2; exit 1; fi',
      '    echo "Executable=/stand-in" >&2',
      '    printf "Authority=%s\\n" "${AUTH1:-Developer ID Application: Stand-in (TEAM)}" "${AUTH2:-Developer ID Certification Authority}" "Apple Root CA" >&2',
      '    echo "TeamIdentifier=TEAM" >&2 ;;',
      '  *) echo "stand-in codesign: unexpected $*" >&2; exit 99 ;;',
      'esac',
    ].join('\n'))
    tool('spctl', 'if [ -n "${FAIL_SPCTL:-}" ]; then echo "stand-in spctl: rejected"; exit 3; fi')
    tool('node', [
      'if [ "$1" = "scripts/stapler.js" ]; then',
      '  if [ -n "${FAIL_STAPLER:-}" ]; then echo "stand-in stapler: no ticket for $3"; exit 65; fi',
      '  echo "stand-in stapler: $3 validated"; exit 0',
      'fi',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
    ].join('\n'))
    const script = path.join(dir, 'step.sh')
    fs.writeFileSync(script, body)
    const outFile = path.join(dir, 'out.txt')
    const fd = fs.openSync(outFile, 'w')
    let r
    try {
      r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
        cwd: dir,
        stdio: ['ignore', fd, fd],
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
        timeout: 30_000,
      })
    } finally {
      fs.closeSync(fd)
    }
    assert.ifError(r.error) // no bash → this FAILS, with the reason; it never skips
    return { status: r.status, lines: fs.readFileSync(outFile, 'utf8').trimEnd().split('\n') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const UNSIGNED_NOTE = '  — expected on the unsigned path (no signing creds)'
const MUST_PASS = '  (signed build MUST pass)'
const header = (signed) => `app: release/Mixed Measures.app   dmg: release/Mixed Measures.dmg   signed=${signed}`

test('the Gatekeeper step runs every check and prints each failure, under GitHub\'s `bash -eo pipefail` (#1610)', () => {
  const body = workflowSteps(releaseYml).find((s) => s.name === GATEKEEPER_STEP)?.body
  assert.ok(body, `release.yml has no step "${GATEKEEPER_STEP}"`)
  const app = 'release/Mixed Measures.app'
  const dmg = 'release/Mixed Measures.dmg'
  for (const { scenario, env, status, lines } of [
    {
      scenario: 'unsigned, every check fails — each prints, warns, and the gate is informational',
      env: { SIGNED: 'false', UNSIGNED: '1', FAIL_SPCTL: '1', FAIL_STAPLER: '1' },
      status: 0,
      lines: [
        header('false'),
        'stand-in codesign --verify: not signed',
        `⚠️  codesign --verify --deep --strict${UNSIGNED_NOTE}`,
        'stand-in codesign --display: not signed',
        `⚠️  signature is Developer ID Application${UNSIGNED_NOTE}`,
        'stand-in spctl: rejected',
        `⚠️  spctl Gatekeeper assess (execute)${UNSIGNED_NOTE}`,
        `stand-in stapler: no ticket for ${app}`,
        `⚠️  stapler validate (.app notarization)${UNSIGNED_NOTE}`,
        `stand-in stapler: no ticket for ${dmg}`,
        `⚠️  stapler validate (.dmg)${UNSIGNED_NOTE}`,
        'GATEKEEPER GATE: ✅ PASS (unsigned — informational)',
      ],
    },
    {
      scenario: 'signed, only spctl fails — its output and verdict print, the ticket checks still run',
      env: { SIGNED: 'true', FAIL_SPCTL: '1' },
      status: 1,
      lines: [
        header('true'),
        '✅ codesign --verify --deep --strict',
        '✅ signature is Developer ID Application',
        'stand-in spctl: rejected',
        `❌ spctl Gatekeeper assess (execute)${MUST_PASS}`,
        `stand-in stapler: ${app} validated`,
        '✅ stapler validate (.app notarization)',
        `stand-in stapler: ${dmg} validated`,
        '✅ stapler validate (.dmg)',
        'GATEKEEPER GATE: ❌ FAIL',
      ],
    },
    {
      scenario: 'signed with a certificate that is not Developer ID — the check prints the signature\'s authorities',
      env: { SIGNED: 'true', AUTH1: 'Apple Development: Stand-in (TEAM)', AUTH2: 'Apple Worldwide Developer Relations Certification Authority' },
      status: 1,
      lines: [
        header('true'),
        '✅ codesign --verify --deep --strict',
        'Authority=Apple Development: Stand-in (TEAM)',
        'Authority=Apple Worldwide Developer Relations Certification Authority',
        'Authority=Apple Root CA',
        `❌ signature is Developer ID Application${MUST_PASS}`,
        '✅ spctl Gatekeeper assess (execute)',
        `stand-in stapler: ${app} validated`,
        '✅ stapler validate (.app notarization)',
        `stand-in stapler: ${dmg} validated`,
        '✅ stapler validate (.dmg)',
        'GATEKEEPER GATE: ❌ FAIL',
      ],
    },
    {
      scenario: 'signed, everything passes — quiet checks, the enforced pass',
      env: { SIGNED: 'true' },
      status: 0,
      lines: [
        header('true'),
        '✅ codesign --verify --deep --strict',
        '✅ signature is Developer ID Application',
        '✅ spctl Gatekeeper assess (execute)',
        `stand-in stapler: ${app} validated`,
        '✅ stapler validate (.app notarization)',
        `stand-in stapler: ${dmg} validated`,
        '✅ stapler validate (.dmg)',
        'GATEKEEPER GATE: ✅ PASS (signed — enforced)',
      ],
    },
  ]) {
    const got = runMacStep(body, env)
    assert.deepEqual(got.lines, lines, scenario)
    assert.equal(got.status, status, `${scenario}: exit code`)
  }
})

test('control: without `set +e` the same harness reproduces #1610 — the step exits before its second verdict', () => {
  // Proof the harness above can fail: the defect it guards against must reproduce in it.
  const body = workflowSteps(releaseYml).find((s) => s.name === GATEKEEPER_STEP)?.body
  assert.ok(body, `release.yml has no step "${GATEKEEPER_STEP}"`)
  const withoutFix = body.replace(/^set \+e\n/m, '')
  assert.notEqual(withoutFix, body, 'the Gatekeeper step has no `set +e` line to remove')
  const got = runMacStep(withoutFix, { SIGNED: 'false', UNSIGNED: '1', FAIL_SPCTL: '1', FAIL_STAPLER: '1' })
  const verdicts = got.lines.filter((l) => /^(✅|⚠️|❌) /.test(l))
  assert.notEqual(got.status, 0, 'without `set +e` the unsigned path should exit non-zero under -e')
  assert.ok(verdicts.length < 2, `without \`set +e\` the step still reached ${verdicts.length} verdicts: ${got.lines.join(' | ')}`)
  assert.ok(!got.lines.some((l) => l.startsWith('GATEKEEPER GATE:')), 'without `set +e` the step still reached its summary')
})

test('every release.yml step that says "NOT -e" turns errexit off before its first command (#1610)', () => {
  const { named, broken } = errexitPromises(releaseYml)
  // Population: the Gatekeeper and update-zip steps both promise it, so a rename or a
  // reformat that hides them from the scan cannot pass vacuously.
  assert.ok(named.includes(GATEKEEPER_STEP) && named.includes(UPDATE_ZIP_STEP), `the scan found only: ${named.join('; ')}`)
  assert.ok(named.length >= 2)
  assert.deepEqual(broken, [], 'these steps keep GitHub\'s -e: put `set +e` first')
  // Falsifier: remove each `set +e` line in turn, and the scan must name exactly its step.
  const lines = releaseYml.split('\n')
  const at = lines.flatMap((l, i) => (/^\s+set \+e$/.test(l) ? [i] : []))
  assert.ok(at.length >= 2, `release.yml has ${at.length} \`set +e\` lines`)
  const seen = []
  for (const i of at) {
    const without = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n')
    const { broken: b } = errexitPromises(without)
    // A `set +e` in a step that promises nothing breaks nothing; one in a promising step, exactly it.
    assert.ok(b.length <= 1, `removing line ${i + 1} broke more than one step: ${b.join('; ')}`)
    seen.push(...b)
  }
  assert.deepEqual(seen.sort(), [...named].sort(), 'each promising step is caught when its own `set +e` goes')
})
