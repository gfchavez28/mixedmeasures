const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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

// --- the half that lives in the release workflow -------------------------------------

const releaseYml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')

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
