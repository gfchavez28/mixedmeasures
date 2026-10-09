// Is the locked Electron runtime named by one of Electron's OWN security advisories? (#1094)
//
// `electron` is a devDependency, so every `npm audit --omit=dev` gate skips it by
// construction, and on 2026-09-28 all six advisories electron/electron had published on
// 08-29 also returned 404 from GitHub's global advisory database — so the full-tree audit
// and Dependabot saw nothing either, while four of them named the 42.8.1 that v1.5.3 and
// v1.5.4 shipped (#1093). Electron publishes them on its own repository, with npm-style
// ranges, and anyone can read that list. This reads it and fails when the locked version
// falls inside a range nobody has reviewed.
//
//   node scripts/electron-advisories.js
//     GITHUB_TOKEN is used when set (CI); without it the call is anonymous (60 an hour).
//
// What it cannot see: a Chromium fix Electron has not backported yet, which has no Electron
// advisory at all (#1093's two KEV bugs). The /security-audit skill's release-notes and
// crbug check stays the detector for those.

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Advisories that name the locked version but do not reach this app, each with the
 * precondition it needs and why that is absent here. Reviewed against electron/main.js.
 * An entry whose advisory no longer names the locked version FAILS the check as stale, so
 * the list empties itself on the next runtime bump rather than excusing a future version.
 * Model: pip-audit's --ignore-vuln, with the reason written down.
 */
const REVIEWED = Object.freeze({
  // Reviewed 2026-10-06, on 44.5.1. Electron's repository copy lists an OPEN range,
  // '>= 40.0.0-alpha.1' with no patched version, which names every version since 40. GitHub's
  // curated copy of the same advisory reads '>= 40.0.0-alpha.1, < 41.10.5', and the
  // advisory's own text names the fixed versions 42.0.0-beta.2, 41.10.5 and 39.8.10. So the
  // open range is a slip for the 40 line. The app DOES ship Squirrel.Mac (electron-updater's
  // MacUpdater), so this entry stands only while 44.x descends from 42's fix.
  'GHSA-vv43-5jgx-7qv8': "the repository copy's open range '>= 40.0.0-alpha.1' is a slip: GitHub's curated copy reads " +
    "'< 41.10.5' for that line and the advisory names 42.0.0-beta.2 as fixed, which 44.x descends from",
})

/** Floors for a fetch that silently comes back empty or changes shape (61 published, 10-06). */
const MIN_ADVISORIES = 20
const MIN_ELECTRON_RANGES = 20

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text) {
  const m = VERSION.exec(String(text).trim())
  if (!m) throw new Error(`not a version: ${JSON.stringify(text)}`)
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: -1, 0 or 1. A pre-release sorts BEFORE its release (44.0.0-beta.5 < 44.0.0). */
function compare(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1
    if (i >= y.pre.length) return 1
    const [p, q] = [x.pre[i], y.pre[i]]
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

const OPS = {
  '>=': (c) => c >= 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '<': (c) => c < 0, '=': (c) => c === 0,
}

const TOKEN = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/

/**
 * One comparator, with npm's partial versions desugared the way `semver` does with
 * includePrerelease: '<= 8' is '< 9.0.0-0', '> 8' is '>= 9.0.0-0', '< 7' is '< 7.0.0-0',
 * a bare '8' is the whole 8.x line.
 */
function comparators(token, range) {
  const m = TOKEN.exec(token)
  if (!m) throw new Error(`cannot read ${JSON.stringify(token)} in ${JSON.stringify(range)}`)
  const [, op = '', major, minor, patch, pre] = m
  const at = (a, b, c, p) => parseVersion(`${a}.${b}.${c}${p ? `-${p}` : ''}`)
  if (patch !== undefined) return [{ op: op || '=', v: at(major, minor, patch, pre) }]
  if (pre) throw new Error(`a partial version cannot carry a pre-release: ${JSON.stringify(token)} in ${JSON.stringify(range)}`)
  const lo = minor === undefined ? at(major, 0, 0, '0') : at(major, minor, 0, '0')
  const hi = minor === undefined ? at(Number(major) + 1, 0, 0, '0') : at(major, Number(minor) + 1, 0, '0')
  if (op === '>=') return [{ op: '>=', v: lo }]
  if (op === '>') return [{ op: '>=', v: hi }]
  if (op === '<') return [{ op: '<', v: lo }]
  if (op === '<=') return [{ op: '<', v: hi }]
  return [{ op: '>=', v: lo }, { op: '<', v: hi }]
}

/**
 * A GitHub advisory range, in every form electron/electron has published (all 61, read
 * 2026-10-06): comparators ANDed, separated by ", " or by spaces ('>= 42.0.0-alpha.1, < 42.9.2',
 * '>=14.0.0-beta.1 < 14.2.4'); alternatives ORed with '||'; partial versions ('<= 8'); one typo,
 * '< =7.2.3'; and once (GHSA-q6m5-f73j-m9mc) a bare list of exact versions, ORed: '42.3.1,42.3.2'.
 * Anything else THROWS: a range this cannot read is a range it would otherwise call safe, which
 * is how electron-updater's own minimum-OS check fails open (#1118).
 */
function inRange(version, range) {
  if (typeof range !== 'string' || !range.trim()) throw new Error(`empty range ${JSON.stringify(range)}`)
  const v = parseVersion(version)
  const alternatives = range.split('||').map((alt) => {
    const tokens = alt.replace(/([<>])\s+=/g, '$1=').replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/[\s,]+/).filter(Boolean)
    if (!tokens.length) throw new Error(`empty alternative in ${JSON.stringify(range)}`)
    return tokens
  })
  const bareList = alternatives.length === 1 && alternatives[0].length > 1 &&
    alternatives[0].every((t) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t))
  if (bareList) return alternatives[0].some((t) => compare(v, t) === 0)
  return alternatives.some((tokens) =>
    tokens.flatMap((t) => comparators(t, range)).every((c) => OPS[c.op](compare(v, c.v))))
}

/** The electron version the lockfile resolves, i.e. what `npm ci` installs and the build ships. */
function lockedVersion(lock) {
  const entry = lock.packages && lock.packages['node_modules/electron']
  if (!entry || !entry.version) throw new Error('package-lock.json has no node_modules/electron entry')
  return entry.version
}

/**
 * Judge every advisory against one version.
 * -> { hits, reviewed, unreadable, stale, ranges } where hits are unreviewed advisories that
 *    name the version, and stale are REVIEWED ids that no longer do.
 */
function evaluate(advisories, version, reviewed = REVIEWED) {
  const hits = []
  const excused = []
  const unreadable = []
  let ranges = 0
  const named = new Set()
  for (const adv of advisories) {
    for (const vuln of adv.vulnerabilities || []) {
      const pkg = vuln.package || {}
      if (pkg.ecosystem !== 'npm' || pkg.name !== 'electron') continue
      ranges++
      let hit
      try {
        hit = inRange(version, vuln.vulnerable_version_range)
      } catch (err) {
        if (!reviewed[adv.ghsa_id]) unreadable.push({ id: adv.ghsa_id, why: err.message })
        continue
      }
      if (!hit) continue
      named.add(adv.ghsa_id)
      const row = {
        id: adv.ghsa_id, severity: adv.severity, summary: adv.summary,
        range: vuln.vulnerable_version_range, patched: vuln.patched_versions, url: adv.html_url,
      }
      if (reviewed[adv.ghsa_id]) excused.push({ ...row, reason: reviewed[adv.ghsa_id] })
      else hits.push(row)
    }
  }
  const stale = Object.keys(reviewed).filter((id) => !named.has(id))
  return { hits: dedupe(hits), reviewed: dedupe(excused), unreadable, stale, ranges }
}

function dedupe(rows) {
  const seen = new Set()
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)))
}

/** Every published advisory on electron/electron, following the cursor pagination. */
async function fetchAdvisories({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com'
  let url = `${base}/repos/electron/electron/security-advisories?state=published&per_page=100`
  const all = []
  let anonymous = !token
  for (let page = 0; url && page < 20; page++) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    if (!anonymous) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(url, { headers })
    // A workflow token is scoped to its own repository; if GitHub refuses it for another
    // repository's PUBLIC advisories, the same request anonymously is allowed (60 an hour).
    if (!anonymous && (res.status === 401 || res.status === 403)) {
      anonymous = true
      page--
      continue
    }
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining')
      throw new Error(`GitHub answered ${res.status} for ${url}` + (remaining === '0' ? ' (rate limit spent)' : ''))
    }
    const body = await res.json()
    if (!Array.isArray(body)) throw new Error(`expected a list of advisories, got ${typeof body}`)
    all.push(...body)
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')
    url = next ? next[1] : null
  }
  return all
}

async function main({ lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8')),
  fetch: fetchList = fetchAdvisories, reviewed = REVIEWED, log = console.log, error = console.error } = {}) {
  const version = lockedVersion(lock)
  const advisories = await fetchList()
  const result = evaluate(advisories, version, reviewed)
  const problems = []
  if (advisories.length < MIN_ADVISORIES || result.ranges < MIN_ELECTRON_RANGES) {
    problems.push(`only ${advisories.length} advisories / ${result.ranges} electron ranges came back ` +
      `(floors ${MIN_ADVISORIES} / ${MIN_ELECTRON_RANGES}) — the list or its shape changed, so silence here means nothing`)
  }
  for (const h of result.hits) {
    problems.push(`${h.id} (${h.severity}) names electron ${version}: ${h.summary}\n` +
      `      vulnerable ${h.range} · patched ${h.patched || 'none listed'} · ${h.url}\n` +
      `      Move the runtime past it, or, if it cannot reach this app, add it to REVIEWED with the reason.`)
  }
  for (const u of result.unreadable) problems.push(`${u.id}: ${u.why} — review it by hand`)
  for (const id of result.stale) problems.push(`REVIEWED lists ${id}, which no longer names electron ${version} — remove it`)
  for (const r of result.reviewed) log(`electron-advisories: ${r.id} names ${version}, reviewed: ${r.reason}`)
  if (problems.length) {
    error(`electron-advisories: electron ${version} against ${advisories.length} published Electron advisories:`)
    for (const p of problems) error(`  ${p}`)
    return 1
  }
  log(`electron-advisories: no unreviewed advisory names electron ${version} ` +
    `(${advisories.length} published, ${result.ranges} ranges read` +
    (result.reviewed.length ? `; ${result.reviewed.length} reviewed above` : '') + ')')
  return 0
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code },
    (err) => {
      console.error(`electron-advisories: ${err.message}`)
      process.exitCode = 1
    },
  )
}

module.exports = { REVIEWED, parseVersion, compare, inRange, lockedVersion, evaluate, fetchAdvisories, main }
