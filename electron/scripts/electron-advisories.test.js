const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  REVIEWED, parseVersion, compare, inRange, lockedVersion, evaluate, fetchAdvisories, main,
} = require('./electron-advisories.js')

// One of every range FORM electron/electron has published (all 61 read 2026-10-06), verbatim:
// ", "-joined, space-joined, '||' alternatives, partial versions ('<= 8', '<7'), the '< =7.2.3'
// typo, an open upper end, and the one bare list of versions, which is ORed.
const LIVE_RANGES = [
  '< 41.10.6',
  '>= 42.0.0-alpha.1, < 42.9.2',
  '>= 44.0.0-alpha.1, < 44.0.0-beta.5',
  '>= 42.3.3, < 42.10.0',
  '42.3.1,42.3.2',
  '>= 40.0.0-alpha.1',
  '< 18.3.7, >= 19.0.0-beta.1 < 19.0.11, >= 20.0.0-beta.1 < 20.0.1',
  '< 13.6.6 || >=14.0.0-beta.1 < 14.2.4 || >=15.0.0-beta.1 <15.3.5 || >=16.0.0-beta.1 <16.0.6 || >=17.0.0-alpha.1 <17.0.0-alpha.6',
  '>=9.0.0-beta.0 < 9.4.0 || >= 10.0.0-beta.0 < 10.2.0 || >= 11.0.0-beta.0 < 11.1.0 || >= 12.0.0-beta.0 < 12.0.0-beta.9 || <= 8',
  '>=11.0.0-beta.0 <=11.0.0-beta.5 || >=10.0.0-beta.0 <=10.1.1 || >=9.0.0-beta.0 <=9.3.0 || >=8.0.0-beta.0 <=8.5.1 <= 8',
  '>=9.0.0-beta.0 <=9.0.0-beta.20 || >=8.0.0-beta.0 <=8.2.3 || >= 7.0.0-beta < =7.2.3 || <7',
]

function advisory(id, range, extra = {}) {
  return {
    ghsa_id: id, severity: 'high', summary: `summary of ${id}`, html_url: `https://example/${id}`,
    vulnerabilities: [{ package: { ecosystem: 'npm', name: 'electron' }, vulnerable_version_range: range, patched_versions: 'x' }],
    ...extra,
  }
}

test('version precedence follows semver, pre-releases before their release', () => {
  assert.equal(compare('44.0.0-beta.5', '44.0.0'), -1)
  assert.equal(compare('44.0.0-alpha.1', '44.0.0-beta.1'), -1)
  assert.equal(compare('44.0.0-beta.2', '44.0.0-beta.10'), -1, 'numeric identifiers compare as numbers')
  assert.equal(compare('42.10.0', '42.9.2'), 1, 'minor 10 is above 9, not below it as a string')
  assert.equal(compare('44.5.1', '44.5.1'), 0)
  assert.throws(() => parseVersion('44.5'), /not a version/)
})

test('agrees with the semver package on every live range form (an independent oracle)', () => {
  // semver ships in this tree with electron-updater; it is used here only as the ORACLE, so a
  // matcher written from memory cannot agree with itself. GHSA's ", " is npm's AND (a space);
  // the bare list is npm's ||.
  const semver = require('semver')
  const toNpm = (r) => (/[<>=]/.test(r) ? r.replace(/([<>])\s+=/g, '$1=').replace(/,\s*/g, ' ') : r.split(',').join(' || '))
  const versions = ['6.1.10', '6.9.9', '7.0.0-beta', '7.2.3', '7.2.4', '8.0.0', '8.2.3', '8.5.1', '8.9.9', '9.0.0-beta.20',
    '9.0.0', '9.3.9', '10.1.1', '12.0.0-beta.8', '13.6.5', '14.2.3', '17.0.0-alpha.5', '18.3.6', '19.0.10', '20.0.0',
    '41.10.5', '41.10.6', '42.0.0-alpha.1', '42.0.0', '42.3.1', '42.3.2', '42.3.3', '42.9.1', '42.9.2',
    '42.10.0', '42.11.8', '43.4.1', '44.0.0-alpha.1', '44.0.0-beta.4', '44.0.0-beta.5', '44.0.0', '44.5.1', '45.0.0']
  let disagreements = []
  let hitsSeen = 0
  for (const range of LIVE_RANGES) {
    for (const v of versions) {
      const ours = inRange(v, range)
      const theirs = semver.satisfies(v, toNpm(range), { includePrerelease: true })
      if (ours) hitsSeen++
      if (ours !== theirs) disagreements.push(`${v} in "${range}": ours ${ours}, semver ${theirs}`)
    }
  }
  assert.deepEqual(disagreements, [])
  // Discrimination: a matcher answering "never" agrees with nothing above only if no version is in.
  assert.ok(hitsSeen >= 40, `the matrix must contain versions INSIDE ranges (found ${hitsSeen})`)
})

test('a bare list is exact versions ORed; a range it cannot read throws rather than passing', () => {
  assert.equal(inRange('42.3.2', '42.3.1,42.3.2'), true)
  assert.equal(inRange('42.3.3', '42.3.1,42.3.2'), false)
  assert.equal(inRange('44.5.1', '>= 40.0.0-alpha.1'), true, 'an open upper end names every later version')
  assert.equal(inRange('8.9.9', '<= 8'), true, "'<= 8' is the whole 8 line")
  assert.equal(inRange('9.0.0-alpha.1', '<= 8'), false)
  for (const bad of ['', '*', '~42.3.0', '^42.3.0', '42.x', '>= 42.0-beta', 'latest', '||']) {
    assert.throws(() => inRange('42.3.1', bad), undefined, `should refuse ${JSON.stringify(bad)}`)
  }
})

test('the locked version is read from the lockfile, which is what npm ci installs', () => {
  const lock = require(path.join(__dirname, '..', 'package-lock.json'))
  assert.match(lockedVersion(lock), /^\d+\.\d+\.\d+$/)
  assert.equal(lockedVersion(lock), require('electron/package.json').version, 'the installed electron is the locked one')
  assert.throws(() => lockedVersion({ packages: {} }), /no node_modules\/electron/)
})

test('evaluate: a hit, a reviewed hit, a stale review, an unreadable range, other packages ignored', () => {
  const advisories = [
    advisory('GHSA-hit', '>= 44.0.0, < 44.6.0'),
    advisory('GHSA-ok', '< 44.0.0'),
    advisory('GHSA-reviewed', '>= 44.5.0, < 44.5.2'),
    advisory('GHSA-weird', 'whatever'),
    { ghsa_id: 'GHSA-other', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'not-electron' }, vulnerable_version_range: '< 99.0.0' }] },
  ]
  const r = evaluate(advisories, '44.5.1', { 'GHSA-reviewed': 'cannot reach us', 'GHSA-gone': 'old reason' })
  assert.deepEqual(r.hits.map((h) => h.id), ['GHSA-hit'])
  assert.deepEqual(r.reviewed.map((h) => h.id), ['GHSA-reviewed'])
  assert.deepEqual(r.stale, ['GHSA-gone'])
  assert.deepEqual(r.unreadable.map((u) => u.id), ['GHSA-weird'])
  assert.equal(r.ranges, 4, 'only electron ranges count toward the population')
})

test('one advisory listing several ranges for the version is reported once', () => {
  const adv = advisory('GHSA-twice', '< 45.0.0')
  adv.vulnerabilities.push({ ...adv.vulnerabilities[0], vulnerable_version_range: '>= 44.0.0, < 44.9.0' })
  assert.equal(evaluate([adv], '44.5.1', {}).hits.length, 1)
})

test('REVIEWED entries carry a reason', () => {
  for (const [id, reason] of Object.entries(REVIEWED)) {
    assert.match(id, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/)
    assert.ok(typeof reason === 'string' && reason.length > 20, `${id} needs its reason`)
  }
})

function fakeResponse(status, body, headers = {}) {
  const h = new Map(Object.entries(headers))
  return { status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: (k) => h.get(k.toLowerCase()) ?? null } }
}

test('fetch follows the cursor pagination and retries anonymously when the token is refused', async () => {
  const seen = []
  const fetchImpl = async (url, { headers }) => {
    seen.push([url, Boolean(headers.Authorization)])
    if (headers.Authorization) return fakeResponse(403, { message: 'Resource not accessible by integration' })
    if (!url.includes('after=')) {
      return fakeResponse(200, [advisory('GHSA-1', '< 1.0.0')], { link: '<https://api.github.com/x?after=abc>; rel="next"' })
    }
    return fakeResponse(200, [advisory('GHSA-2', '< 1.0.0')])
  }
  const all = await fetchAdvisories({ token: 't', fetchImpl })
  assert.deepEqual(all.map((a) => a.ghsa_id), ['GHSA-1', 'GHSA-2'])
  assert.deepEqual(seen.map(([, auth]) => auth), [true, false, false], 'token first, then anonymous for every page')
})

test('fetch fails loudly on a refusal it cannot get around, naming a spent rate limit', async () => {
  const fetchImpl = async () => fakeResponse(403, {}, { 'x-ratelimit-remaining': '0' })
  await assert.rejects(fetchAdvisories({ token: '', fetchImpl }), /403.*rate limit spent/)
})

test('main: exit 1 on an unreviewed hit, 0 when clear, 1 when the list comes back too small', async () => {
  const lock = { packages: { 'node_modules/electron': { version: '44.5.1' } } }
  const quiet = { log: () => {}, error: () => {} }
  const many = Array.from({ length: 25 }, (_, i) => advisory(`GHSA-old${i}`, '< 40.0.0'))
  assert.equal(await main({ lock, fetch: async () => many, reviewed: {}, ...quiet }), 0)
  assert.equal(await main({ lock, fetch: async () => [...many, advisory('GHSA-new', '>= 44.5.0, < 44.5.2')], reviewed: {}, ...quiet }), 1)
  assert.equal(await main({ lock, fetch: async () => [...many, advisory('GHSA-new', '>= 44.5.0, < 44.5.2')],
    reviewed: { 'GHSA-new': 'a reason long enough to count as one' }, ...quiet }), 0)
  assert.equal(await main({ lock, fetch: async () => [], reviewed: {}, ...quiet }), 1, 'an empty list is not a clean bill')
})
