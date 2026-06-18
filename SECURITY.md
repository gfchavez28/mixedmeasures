# Security Policy

Mixed Measures is a local-first desktop research tool. It is maintained part-time by
a single author, so this policy aims to be realistic about scope and response times
while taking the security of researchers' data seriously.

## Reporting a vulnerability

**Please report security issues privately — do not open a public GitHub issue for a
suspected vulnerability.**

Two private channels:

1. **GitHub private vulnerability reporting** (preferred) — use the repository's
   **Security → Report a vulnerability** form (GitHub Security Advisories).
2. **Email** — `contact@mixedmeasures.com` with a subject line beginning
   `[SECURITY]`.

Please include, as far as you can:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (a minimal proof of concept is ideal).
- The version / commit you tested, and your OS.
- Whether the issue is already public anywhere.

**What to expect** (best-effort, single part-time maintainer):

- Acknowledgement within **7 days**.
- An initial assessment (confirmed / needs-info / not-applicable) within **30 days**.
- For confirmed issues, coordinated disclosure: a fix or mitigation, then a public
  advisory crediting you (unless you prefer to remain anonymous). Please allow a
  reasonable embargo window before public disclosure.

## Supported versions

Until the first stable release, only the latest `main` is supported. After v1.0,
security fixes target the most recent released minor version.

| Version | Supported |
|---------|-----------|
| `main` (pre-release) | ✅ |
| Latest released `1.x` (after v1.0) | ✅ |
| Older releases | ❌ — please upgrade |

## Threat model & security posture

Understanding what the tool does and does not protect is the most important part of
this document.

**The design:** Mixed Measures runs entirely on the user's own machine. It makes no
outbound network connections — no telemetry, analytics, update checks, or external
content. The backend serves only to the local frontend, with a content-security
policy locked to same-origin and standard security headers
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`).

**Sessions** are local-first: the desktop app auto-provisions a single local
researcher (no login screen — your operating-system account is the boundary), with
server-side sessions in HttpOnly cookies, CSRF tokens on all state-changing
requests, loopback-only Host validation, and an optional inactivity timeout.
Project access is owner-scoped and enforced on every project endpoint.

**At-rest encryption (v1.0) and its limits:**

- **The database is encrypted at rest.** In packaged desktop builds the SQLite
  database is encrypted with SQLCipher (AES-256). The key is a random per-install
  value held in your operating system's keychain (macOS Keychain / Windows DPAPI /
  Linux Secret Service), so another OS user cannot open the database file directly,
  and a copied or synced file is unreadable without that key. If the OS keychain is
  unavailable, the app tells you and runs unencrypted rather than storing a key
  insecurely. Development builds run from source use a plaintext database for
  inspectability.
- **It does not defend against your own OS user.** At-rest encryption protects
  against *another* OS account or a copied file — not an attacker already running as
  you. Full-disk encryption (FileVault / BitLocker) is the honest answer there.
- **`.mmbackup` archives are machine-local and only partially encrypted.** The
  database inside a backup is ciphertext, but the documents and media files in the
  archive are stored unencrypted, and the archive can only be restored on the
  machine that created it (its key lives in that machine's keychain). Treat a
  `.mmbackup` as sensitive and keep it on a trusted machine; full-archive encryption
  is planned for a future release. A one-time recovery-key export covers keychain loss.
- **Move projects between machines with `.mmproject`, not `.mmbackup`.** The
  `.mmproject` export is a database-agnostic JSON + files bundle and is the supported
  cross-machine path; it is unaffected by database encryption.

**Other known limitations — by design in v1.0 (not vulnerabilities):**
- **No multi-tenant isolation guarantees.** The tool is single-user/local. It is not
  designed or hardened to be exposed to untrusted networks or run as a shared
  multi-tenant server. Do not deploy the backend on a public interface.
- **Local trust assumption.** Anyone with file-system access to the data directory
  can read or modify project data, independent of application login.
- **A running app is reachable by other accounts on the same machine.** While the
  app is open, its backend listens on a local (loopback) port — and loopback is
  shared by every OS account on the machine, not just yours. Because the desktop
  app signs you in automatically, another account on the same machine could connect
  to that port while the app is running and read or modify project data. At-rest
  encryption does not help here: a running app serves decrypted data. On shared or
  lab machines, quit the app when you step away. A per-launch secret between the
  desktop shell and the backend is planned to close this gap.

## In scope

Issues that would let one user access another user's project through the
application, authentication/session/CSRF bypasses, injection via imported files
(CSV/DOCX/PDF/XML/audio parsing, including formula injection in exports), path
traversal / zip-slip in import/backup/restore, and similar application-layer flaws.

The project already hardens several of these (defused XML parsing, CSV/Excel formula
defanging, zip-slip checks and integrity verification on restore, upload size
limits, a pinned security floor for a transitive CVE); reports of gaps in these
defenses are welcome.

## Out of scope

- The same-OS-user and partial-`.mmbackup` limitations of at-rest encryption, and
  the local-trust limitations described above.
- Anything requiring an attacker to already have OS-level access to the user's files.
- Vulnerabilities in third-party dependencies that are already publicly tracked —
  unless you can show Mixed Measures uses the affected code path. (We monitor
  dependency advisories via Dependabot, `npm audit`, and `pip-audit`.)
- Findings from automated scanners without a demonstrated, exploitable impact.
- Social engineering, physical access, and denial of service against a single user's
  own local instance.

## Dependency & supply-chain practices

- Frontend installs use `npm ci` against a committed lockfile, with
  `ignore-scripts=true` to block install-time script execution.
- Production dependencies are version-pinned; transitive CVEs get an explicit
  security-floor pin documented with the CVE in `requirements.txt`.
- All shipping dependencies are permissive / Apache-compatible licenses.

Thank you for helping keep researchers' data safe.
