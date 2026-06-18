# Contributing to Mixed Measures

Thanks for your interest in Mixed Measures. It's a local-first, mixed-methods
research tool maintained part-time by a single author, so contributions are welcome
but please read this guide first — a little alignment up front saves everyone time.

## Before you start

- **Open an issue first** for anything beyond a small fix. Describe the problem or
  the proposed change and wait for a thumbs-up before investing in a large PR. The
  roadmap is opinionated, and not every good idea fits v1.0's scope.
- **Scope guardrails.** Two things are deliberately *out* of the shipping product
  and PRs adding them won't be merged:
  - **AI / LLM features.** The shipping product currently has no AI, and that's
    deliberate for v1.0 — don't add model calls or AI-assisted behavior to product
    code or copy in a PR. If AI is ever added it'll be a maintainer-led roadmap
    decision (opt-in and audit-trailed by design), not an unsolicited contribution.
  - **Outbound network calls.** The app is fully local and offline (no telemetry,
    analytics, update checks, or external CDNs). Don't introduce code that phones
    home or fetches remote resources at runtime.
- **Be honest about correctness.** This tool computes statistics researchers rely
  on. Changes to the statistical, metric, export, or data-import code must come with
  tests, and must not silently change numbers.

## Project layout

```
backend/    FastAPI + SQLAlchemy app, Alembic migrations, pytest suite
frontend/   React 19 + Vite + TypeScript app, vitest suite
```

The backend serves a JSON API under `/api`; the frontend is a single-page app that
talks to it. In development the Vite server proxies `/api` to the backend.

## Development setup

**Prerequisites:** Python 3.12+ and Node.js 20+ (current LTS).

**Backend:**

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements-dev.txt               # includes pytest + pip-audit
alembic upgrade head                              # build/migrate the local SQLite DB
uvicorn app.main:app --reload --port 8000
```

**Frontend:**

```bash
cd frontend
npm ci          # use `npm ci`, not `npm install`
npm run dev
```

Then open http://localhost:5173.

## Running the checks

Run these before opening a PR; a contribution should leave them all green.

| Check | Command (from) | Notes |
|-------|----------------|-------|
| Backend tests | `python -m pytest tests/` (`backend/`, venv active) | The full suite takes a few minutes. |
| Frontend tests | `npm test` (`frontend/`) | Vitest, one-shot. |
| Frontend lint | `npm run lint` (`frontend/`) | ESLint flat config; should pass clean. |
| Frontend typecheck/build | `npm run build` (`frontend/`) | `tsc` gates the build — a type error fails it. |

Single backend test file:

```bash
python -m pytest tests/test_metrics_compute.py -v
```

## Database migrations

The schema is managed by Alembic. Never edit a shipped migration; add a new one.

```bash
cd backend
alembic revision --autogenerate -m "short description"   # generate
# review and edit the generated file by hand — autogenerate is a starting point
alembic upgrade head                                     # apply
alembic downgrade -1                                     # roll back one
```

SQLite has migration quirks (enum case, in-place `ALTER` limitations); review the
generated migration carefully and prefer batch operations for column changes.
Migrations should be additive and preserve existing data wherever possible.

## Dependencies

Adding a dependency is a real decision — please keep the footprint small and the
supply chain tight.

- **License compatibility is mandatory.** The project is Apache-2.0; every shipping
  dependency must be permissive / Apache-compatible. **No GPL or AGPL dependencies**
  in production code — they would impose copyleft on the distributed application.
  Verify a new dependency's license before adding it.
- **Pin it.** Backend production deps are pinned with `==` or a bounded
  `>=x,<y` range in `requirements.txt`. Frontend deps go through `package-lock.json`
  (committed); high-risk small-maintainer packages are pinned to exact versions.
- **Security floors.** If a transitive dependency carries a CVE, add an explicit
  pinned floor with a comment naming the CVE and the declaring parent.
- **Don't bulk-upgrade.** Upgrade deliberately: security patches promptly; minor and
  major bumps one area at a time, with the test suite green after each, and only
  after the new version has had time to be vetted by the community.
- `frontend/.npmrc` sets `ignore-scripts=true` to block install-time script
  execution; keep it.
- Untrusted input parsing (imported XML/CSV/DOCX/PDF) must stay hardened — use
  `defusedxml` for XML, and keep CSV/Excel export fields defanged against formula
  injection.

## Code style & conventions

- **Match the surrounding code.** Follow the existing patterns, naming, and comment
  density in the file you're editing rather than introducing a new style.
- **Backend:** ownership is enforced through shared helpers — never query a project
  directly; go through the ownership helpers so access control isn't bypassed.
  Business logic lives in `services/`, HTTP wiring in `routers/`.
- **Frontend:** server state goes through TanStack Query with the established query
  keys; prefer the existing shared components and hooks over new one-offs.
- Keep changes focused — one logical change per PR.

## Commit messages & pull requests

- Use clear, conventional-style commit subjects where it fits
  (`fix(import): …`, `feat(canvas): …`, `docs: …`, `test: …`,
  `refactor: …`, `chore: …`).
- Write the subject in the imperative mood and explain *why* in the body when the
  change isn't obvious.
- In the PR description, link the issue, summarize the change, and note how you
  tested it. Include before/after detail for any change that affects computed
  numbers, exports, or the data model.
- Keep PRs reviewable — large mechanical diffs and behavioral changes should be
  separate PRs where possible.

## Reporting bugs & security issues

- **Bugs / feature requests:** open a GitHub issue with steps to reproduce, what you
  expected, and what happened.
- **Security vulnerabilities:** do **not** open a public issue — follow
  [SECURITY.md](SECURITY.md).

## License of contributions

By contributing, you agree that your contributions are licensed under the project's
**Apache License, Version 2.0**. Don't submit code you don't have the right to
contribute, and don't paste in code under an incompatible (e.g. GPL/AGPL) license.
