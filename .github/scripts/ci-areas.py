#!/usr/bin/env python3
"""Which test areas a CI run needs, and the guard that keeps the answer honest (#1095).

CI ran every test on every push. The trigger never changed, but the cost of a push tripled
between June and October as the suites grew (7 -> ~21 billed minutes), and the private
repository's 2,000 free minutes ran out on 2026-09-28. A third of September's pushes changed
notes only, and 44% of all minutes tested an area the push did not touch. So `ci.yml` now
starts with a `plan` job that runs this script, and each area job runs only when the plan
says so.

**The rule, in one sentence: a run tests every area with a change since that area last
PASSED on this branch.** Not "since the previous push". That difference is what keeps three
things true which a plain per-push filter breaks:

  - A failure stays visible. If the backend failed at push A and push B touches only the
    frontend, B runs the backend again, because nothing has passed since the change.
  - A cancelled run loses nothing. When push B cancels push A's run (the workflow's
    `cancel-in-progress`), A's areas never passed, so B covers them.
  - "The latest CI run is green" still means every area passed on a tree no different, in
    that area's files, from the one being looked at. The run's summary names, for each area
    it skipped, the commit and run where that area last passed.

**What each area depends on is NOT just its own folder.** Measured 2026-10-06: 21 backend
test files read the client's sources (contract mirrors; two scan all of `frontend/src`),
two read Electron modules, one reads the CHANGELOG, CITATION.cff and both lockfiles (the
version sites), one reads the workflow files; three
frontend tests read a backend schema, a backend fixture and an Electron module; the
Electron suite reads every workflow file. `AREAS` lists them, and `check` (Doc gates,
every push) fails when a test reads a file outside its area that `AREAS` does not cover.
That scan is the only thing that notices a NEW cross-area test, so it carries a population
floor and a self-test (`--self-test`) proving it can fail.

**Fail-safe direction: when in doubt, test.** Any failure to decide (no token, an API
error, a commit missing from history, an unknown event, a scan finding an uncovered read)
plans EVERY area. `ci.yml`'s area jobs run unless the plan says exactly `false`, so a crash
of this script also runs everything. Every such fallback writes a warning naming why.

Always every area: `workflow_dispatch` (the hand-started full run RELEASING asks for before
a release), `schedule` (the weekly run, via `ci-weekly.yml`, private only), a change to the
CI machinery itself, and the public repository, whose minutes are free and whose pushes are
releases.

Dependabot's security-update pull requests on the PRIVATE repository plan nothing: fixes are
applied by hand (`dependency-security.md` §5), the PRs are never merged, and their runs cost
133 minutes in September.

    python3 .github/scripts/ci-areas.py plan          # ci.yml's plan job (reads GITHUB_* env)
    python3 .github/scripts/ci-areas.py check         # Doc gates: the cross-area guard
    python3 .github/scripts/ci-areas.py explain A B   # what a push from commit A to B would run
    python3 .github/scripts/ci-areas.py --self-test   # prove the matcher and the scan can fail

Standard library only: it runs on the runner's own python3 before anything is installed.
"""
from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ── what each area's job depends on ──────────────────────────────────────────────────────
# GitHub path-filter syntax, a deliberately small subset: `*` (not across `/`) and `**`.
# `ci.yml`'s push and pull_request `paths:` lists are the UNION of these plus ALWAYS_ALL,
# and `check` fails when they disagree. Every non-own entry says which tests read it.
AREAS: dict[str, tuple[str, ...]] = {
    "backend": (
        "backend/**",
        "frontend/src/**",              # 21 test files read the client's mirrors; two scan all of src
        "frontend/package.json",        # test_version_agreement: the nine version sites, which include
        "frontend/package-lock.json",   #   both lockfiles' own version fields and CITATION.cff
        "electron/*.js",                # test_backup_snapshot, test_startup_fatal read the shell's modules
        "electron/package.json",
        "electron/package-lock.json",
        "CHANGELOG.md",                 # test_version_agreement
        "CITATION.cff",
        ".github/workflows/**",         # test_r_oracle_availability reads ci.yml and release.yml by a
                                        # name the scan cannot see (a loop variable), so the folder
    ),
    "frontend": (
        "frontend/**",
        "backend/app/schemas/scratchpad.py",                # scratchpad-context.test.ts
        "backend/tests/fixtures/recode_range_cases.json",   # recode-ranges.test.ts
        "electron/zoom.js",                                 # zoom.test.ts
    ),
    "electron": (
        "electron/**",
        ".github/workflows/**",         # build-config.test.js reads every workflow file
    ),
}

# A change here re-plans everything: the machinery deciding what runs is itself under test.
ALWAYS_ALL: tuple[str, ...] = (".github/workflows/ci.yml", ".github/scripts/ci-areas.py")

# Where each area's tests live — the population the cross-area scan reads.
TEST_FILES: dict[str, tuple[str, ...]] = {
    "backend": ("backend/tests/**/*.py",),
    "frontend": ("frontend/src/**/*.test.ts", "frontend/src/**/*.test.tsx", "frontend/src/test-support/*.ts"),
    "electron": ("electron/*.test.js", "electron/**/*.test.js"),
}

# A path a test NAMES but never reads, with the reason. A stale entry fails `check`.
EXEMPT: dict[tuple[str, str, str], str] = {}

# Population floors for the scan (measured 2026-10-06: backend 249 test files, frontend 349,
# electron 14; 37 outside references). Far below today's values, so ordinary change never
# trips them, while a glob or a parser that rots to nothing does.
FLOOR_FILES = {"backend": 200, "frontend": 200, "electron": 8}
FLOOR_REFERENCES = 15

API_RUNS_TO_WALK = 40   # how far back to look for an area's last pass before giving up (= run it)


# ── GitHub path-filter matching ──────────────────────────────────────────────────────────
def _pattern_regex(pattern: str) -> re.Pattern[str]:
    """`*` matches within one path segment, `**` across segments; everything else literal.

    Refuses the rest of GitHub's syntax (`?`, `[`, `!`, `+`) rather than guess at it: `?`
    there means "zero or one of the preceding character", not one character, so a matcher
    written from memory would disagree with the runner silently.
    """
    if any(c in pattern for c in "?[]!+") or pattern.startswith("/"):
        raise ValueError(f"unsupported path-filter syntax in {pattern!r}")
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")      # zero or more directories: `**/README.md` matches README.md
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def matches(path: str, patterns) -> bool:
    return any(_pattern_regex(p).match(path) for p in patterns)


def covered(path: str, patterns) -> bool:
    """A file is covered when a pattern matches it; a directory, when one matches a file IN it."""
    return matches(path, patterns) or matches(path.rstrip("/") + "/x", patterns)


def union_patterns() -> list[str]:
    seen: dict[str, None] = {}
    for p in (*ALWAYS_ALL, *(p for pats in AREAS.values() for p in pats)):
        seen.setdefault(p, None)
    return list(seen)


def areas_for(files) -> dict[str, list[str]]:
    """area -> the changed files that make it run (empty = it need not run)."""
    files = list(files)
    machinery = [f for f in files if matches(f, ALWAYS_ALL)]
    return {
        area: machinery or [f for f in files if matches(f, pats)]
        for area, pats in AREAS.items()
    }


# ── the cross-area scan ──────────────────────────────────────────────────────────────────
_OUTSIDE_DIRS = ("backend", "frontend", "electron", ".github")


def _heads(area: str, root_files) -> set[str]:
    return {d for d in _OUTSIDE_DIRS if d != area} | set(root_files)


def _candidate(parts: list[str], area: str, root_files) -> str | None:
    """Join path segments into a repo-relative path if they reach outside `area`."""
    segs: list[str] = []
    for p in parts:
        segs.extend(s for s in p.split("/") if s)
    while segs and segs[0] in ("..", "."):
        segs.pop(0)
    if not segs or segs[0] not in _heads(area, root_files):
        return None
    if segs[0] in root_files and len(segs) > 1:
        return None
    return "/".join(segs)


def _py_references(src: str, area: str, root_files) -> set[str]:
    tree = ast.parse(src)
    docstrings = {
        id(node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
    }
    found: set[str] = set()

    def chain(node) -> list:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return chain(node.left) + chain(node.right)
        return [node]

    inner = {
        id(child)
        for node in ast.walk(tree)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)
        for child in (node.left, node.right)
        if isinstance(child, ast.BinOp) and isinstance(child.op, ast.Div)
    }
    in_chain: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) and id(node) not in inner:
            operands = chain(node)
            run: list[str] = []
            for op in operands + [None]:
                if isinstance(op, ast.Constant) and isinstance(op.value, str):
                    run.append(op.value)
                    in_chain.add(id(op))
                    continue
                if run:
                    c = _candidate(run, area, root_files)
                    if c:
                        found.add(c)
                run = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings and id(node) not in in_chain):
            s = node.value
            if "://" in s or any(ch.isspace() for ch in s) or len(s) > 200:
                continue
            if "/" in s or s in root_files:
                c = _candidate([s], area, root_files)
                if c:
                    found.add(c)
    return found


_JS_TOKEN = re.compile(
    r"""//[^\n]*|/\*.*?\*/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`""",
    re.S,
)


def _js_references(src: str, area: str, root_files) -> set[str]:
    """String literals, comments skipped, grouped into runs of comma-separated arguments.

    `join(dir, '..', '..', 'backend', 'app', 'x.py')` is one run and names
    `backend/app/x.py`; `join('/proj', 'backend', ...)` starts at an absolute path, which is
    not a repo path, and names nothing.
    """
    lits: list[tuple[int, int, str]] = []
    for m in _JS_TOKEN.finditer(src):
        tok = m.group(0)
        if tok.startswith("//") or tok.startswith("/*"):
            continue
        if tok.startswith("`") and "${" in tok:
            continue
        lits.append((m.start(), m.end(), tok[1:-1]))
    found: set[str] = set()
    run: list[str] = []
    prev_end = None
    for start, end, value in lits + [(None, None, None)]:
        joined = start is not None and prev_end is not None and re.fullmatch(r"\s*,\s*", src[prev_end:start])
        if not joined and run:
            c = _candidate(run, area, root_files)
            if c:
                found.add(c)
            for s in run:
                if "/" in s and "://" not in s and not any(ch.isspace() for ch in s):
                    c = _candidate([s], area, root_files)
                    if c:
                        found.add(c)
            run = []
        if value is not None:
            run.append(value)
        prev_end = end
    return found


def references(path: str, src: str, area: str, root_files) -> set[str]:
    if path.endswith(".py"):
        return _py_references(src, area, root_files)
    return _js_references(src, area, root_files)


def _tracked_files() -> list[str]:
    out = subprocess.run(["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=True)
    return out.stdout.splitlines()


def scan(tracked: list[str], read) -> tuple[dict, dict, list[str]]:
    """-> (files scanned per area, {(area, file, ref)}, problems)."""
    root_files = {f for f in tracked if "/" not in f}
    counts: dict[str, int] = {}
    refs: dict[tuple[str, str, str], bool] = {}
    for area, globs in TEST_FILES.items():
        files = [f for f in tracked if matches(f, globs) and "/node_modules/" not in f]
        counts[area] = len(files)
        for f in files:
            for ref in references(f, read(f), area, root_files):
                refs[(area, f, ref)] = covered(ref, (*AREAS[area], *ALWAYS_ALL))
    problems = []
    for (area, f, ref), ok in sorted(refs.items()):
        if not ok and (area, f, ref) not in EXEMPT:
            problems.append(
                f"{f} reads {ref}, which is outside the {area} area and not in AREAS[{area!r}] "
                f"— a push changing it would skip these tests. Add a pattern (with the reason), "
                f"or, if the test only NAMES the path, an EXEMPT entry saying so."
            )
    for key in EXEMPT:
        if key not in refs:
            problems.append(f"stale EXEMPT entry {key}: the scan no longer finds that reference")
    return counts, refs, problems


# ── the workflow file ────────────────────────────────────────────────────────────────────
def yaml_block_list(text: str, keys: tuple[str, ...]) -> list[str] | None:
    """The `- item` list under a nested key path, for the block-style YAML ci.yml uses."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    depth, indent, i = 0, -1, 0
    while i < len(lines) and depth < len(keys):
        ln = lines[i]
        ind = len(ln) - len(ln.lstrip())
        if ind <= indent and depth:
            return None
        if ind > indent and re.fullmatch(rf"\s*{re.escape(keys[depth])}:\s*", ln):
            depth, indent = depth + 1, ind
        i += 1
    if depth < len(keys):
        return None
    items = []
    while i < len(lines):
        ln = lines[i]
        ind = len(ln) - len(ln.lstrip())
        if ind <= indent:
            break
        m = re.fullmatch(r"\s*-\s*(['\"]?)(.*?)\1\s*(#.*)?", ln)
        if not m:
            break
        items.append(m.group(2))
        i += 1
    return items


def _representative(pattern: str) -> str:
    """A concrete path the pattern matches, to ask whether another pattern list reaches it."""
    return pattern.replace("**/", "x/").replace("**", "x/y").replace("*", "x")


def check_workflow(text: str) -> list[str]:
    """ci.yml's trigger lists start the run at all, so they must reach every area pattern.

    Each list may be shorter than the union (`frontend/**` already covers `frontend/src/**`),
    but every entry must BE one of the patterns — an unrelated entry (say `docs/**`) would
    start a plan run, and spend a minute, on pushes no area reads.
    """
    problems = []
    want = union_patterns()
    for event in ("push", "pull_request"):
        got = yaml_block_list(text, ("on", event, "paths"))
        if got is None:
            problems.append(f"ci.yml: no `on.{event}.paths` list found")
            continue
        extra = [g for g in got if g not in want]
        if extra:
            problems.append(f"ci.yml `on.{event}.paths` lists {extra}, which no area reads — "
                            f"add it to AREAS with its reason, or remove it")
        missed = [w for w in want if not matches(_representative(w), got)]
        if missed:
            problems.append(f"ci.yml `on.{event}.paths` does not reach {missed} — a push changing "
                            f"only that would start no run, and its area's tests would not run")
    for area in AREAS:
        block = re.search(rf"(?ms)^  {area}:\n(.*?)(?=^  \S|\Z)", text)
        if not block:
            problems.append(f"ci.yml has no `{area}` job")
            continue
        body = block.group(1)
        if not re.search(r"(?m)^    needs:\s*plan\s*$", body):
            problems.append(f"ci.yml `{area}` job does not `needs: plan`")
        cond = re.search(r"(?m)^    if:\s*(.+)$", body)
        want_cond = f"needs.plan.outputs.{area} != 'false'"
        if not cond or want_cond not in cond.group(1) or "!cancelled()" not in cond.group(1):
            problems.append(
                f"ci.yml `{area}` job must run unless the plan says exactly false: "
                f"`if: ${{{{ !cancelled() && {want_cond} }}}}` (a crashed plan then tests everything)"
            )
    if not re.search(r"(?m)^  plan:\s*$", text):
        problems.append("ci.yml has no `plan` job")
    return problems


# ── where an area last passed ────────────────────────────────────────────────────────────
class PlanError(Exception):
    """Cannot decide — the caller plans every area."""


def _api(path: str, token: str) -> dict:
    base = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    req = urllib.request.Request(f"{base}{path}", headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise PlanError(f"GitHub API {path}: {e}") from e


def last_passes(repo: str, branch: str, token: str, current_run: str, get=_api, log=print) -> dict[str, dict | None]:
    """area -> {'sha', 'run'} of the newest completed CI run where its job SUCCEEDED, or a
    dict with 'blocked' when the newest run that ran it did not succeed, or None if none found.

    Skipped jobs are stepped over (the area was not needed there); the first run in which the
    area's job did anything decides.

    ⚠️ The run list is fetched UNFILTERED and filtered and ordered HERE. The first version asked
    GitHub to filter (`branch=` + `status=completed`): on its first real run (2026-10-06, run
    37488610286) it answered "last passed at bd08fa4" for all three areas, a commit 83 runs
    back, while the same query from a developer's token answered the newest run. The cause was
    never reproduced; the filtered listing is the suspect, so nothing depends on it now. Every
    run examined is logged, so a wrong answer can be read off the job log.
    """
    result: dict[str, dict | None] = {a: None for a in AREAS}
    pending = set(AREAS)
    runs: list[dict] = []
    for page in range(1, 6):        # up to 250 runs of this workflow, newest first
        data = get(f"/repos/{repo}/actions/workflows/ci.yml/runs?per_page=50&page={page}", token)
        batch = data.get("workflow_runs", [])
        runs += [r for r in batch
                 if r.get("head_branch") == branch and r.get("status") == "completed"
                 and r.get("event") in ("push", "workflow_dispatch") and str(r.get("id")) != str(current_run)]
        if len(runs) >= API_RUNS_TO_WALK or len(batch) < 50:
            break
    runs.sort(key=lambda r: (r.get("created_at") or "", r.get("id") or 0), reverse=True)
    for run in runs[:API_RUNS_TO_WALK]:
        if not pending:
            break
        jobs = get(f"/repos/{repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page=50", token)
        seen = {}
        for job in jobs.get("jobs", []):
            area = job.get("name")
            if area not in AREAS:
                continue
            seen[area] = job.get("conclusion") or job.get("status")
            if area not in pending or job.get("conclusion") == "skipped":
                continue
            pending.discard(area)
            if job.get("conclusion") == "success":
                result[area] = {"sha": run["head_sha"], "run": run.get("html_url", run["id"])}
            else:
                result[area] = {"blocked": job.get("conclusion") or job.get("status"),
                                "sha": run["head_sha"], "run": run.get("html_url", run["id"])}
        log(f"ci-areas: run {run['id']} {run['head_sha'][:7]} {run.get('created_at', '')} {run.get('event')}: "
            + (", ".join(f"{a}={c}" for a, c in sorted(seen.items())) or "no area jobs"))
    return result


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def changed_in_pr(base: str, head: str) -> list[str]:
    """GitHub's own pull-request semantics: the branch's changes since it left the base."""
    out = _git("diff", "--name-only", f"{base}...{head}")
    if out.returncode != 0:
        raise PlanError(f"git diff {base[:12]}...{head[:12]}: {out.stderr.strip()}")
    return out.stdout.split()


def changed_since(base: str, head: str) -> list[str]:
    if _git("merge-base", "--is-ancestor", base, head).returncode != 0:
        raise PlanError(f"{base[:12]} is not an ancestor of {head[:12]} in this checkout")
    out = _git("diff", "--name-only", base, head)
    if out.returncode != 0:
        raise PlanError(f"git diff {base[:12]} {head[:12]}: {out.stderr.strip()}")
    return out.stdout.split()


# ── plan ─────────────────────────────────────────────────────────────────────────────────
def decide(env: dict, event: dict, last_pass=last_passes, changed=changed_since,
           changed_pr=changed_in_pr) -> tuple[dict, dict, list]:
    """-> (area -> bool, area -> reason, warnings). Pure apart from the two injected lookups."""
    every = lambda why: ({a: True for a in AREAS}, {a: why for a in AREAS})  # noqa: E731
    warnings: list[str] = []
    name = env.get("GITHUB_EVENT_NAME", "")
    repo_private = (event.get("repository") or {}).get("private")

    if repo_private is not True:
        return (*every("the public repository tests everything (its minutes are free; its pushes are releases)"), warnings)
    if name in ("workflow_dispatch", "schedule"):
        return (*every(f"a {name} run is a full run"), warnings)
    if name == "pull_request":
        pr = event.get("pull_request") or {}
        if (pr.get("user") or {}).get("login") == "dependabot[bot]":
            return ({a: False for a in AREAS},
                    {a: "a Dependabot pull request — its fixes are applied by hand, never merged (dependency-security.md §5)"
                     for a in AREAS}, warnings)
        try:
            files = changed_pr(pr["base"]["sha"], pr["head"]["sha"])
        except (PlanError, KeyError, TypeError) as e:
            warnings.append(f"could not diff the pull request ({e}); testing everything")
            return (*every("the diff could not be read"), warnings)
        hits = areas_for(files)
        return ({a: bool(h) for a, h in hits.items()},
                {a: (f"the pull request changes {_few(h)}" if h else "the pull request changes nothing it reads")
                 for a, h in hits.items()}, warnings)
    if name != "push":
        warnings.append(f"unknown event {name!r}; testing everything")
        return (*every(f"an unrecognised event ({name})"), warnings)

    head = env.get("GITHUB_SHA", "")
    token = env.get("GITHUB_TOKEN", "")
    if not token:
        warnings.append("no GITHUB_TOKEN; cannot find where each area last passed — testing everything")
        return (*every("no token to read earlier runs"), warnings)
    try:
        passes = last_pass(env["GITHUB_REPOSITORY"], env.get("GITHUB_REF_NAME", "main"), token, env.get("GITHUB_RUN_ID", ""))
    except (PlanError, KeyError) as e:
        warnings.append(f"could not read earlier runs ({e}); testing everything")
        return (*every("earlier runs could not be read"), warnings)

    run, why = {}, {}
    for area, last in passes.items():
        if last is None:
            run[area], why[area] = True, f"no passing run in the last {API_RUNS_TO_WALK} CI runs"
            continue
        if "blocked" in last:
            run[area], why[area] = True, f"its last run ({last['sha'][:7]}) ended `{last['blocked']}` — {last['run']}"
            continue
        try:
            files = changed(last["sha"], head)
        except PlanError as e:
            warnings.append(f"{area}: {e}; testing it")
            run[area], why[area] = True, f"could not diff against its last pass ({last['sha'][:7]})"
            continue
        hit = areas_for(files)[area]
        run[area] = bool(hit)
        why[area] = (f"changed since it last passed at {last['sha'][:7]}: {_few(hit)}" if hit
                     else f"unchanged since it last passed at {last['sha'][:7]} — {last['run']}")
    return run, why, warnings


def _few(files, n=3) -> str:
    files = list(files)
    shown = ", ".join(f"`{f}`" for f in files[:n])
    return shown + (f" and {len(files) - n} more" if len(files) > n else "")


def force_on_problems(run: dict, why: dict, warnings: list, problems: list) -> tuple[dict, dict]:
    """An uncovered cross-area read means a skip could hide a failure: plan everything, say why."""
    if problems and not all(run.values()):
        warnings.append("a test reads a file outside its area that AREAS does not cover — testing everything")
        warnings.extend(problems)
        return {a: True for a in AREAS}, {a: "an uncovered cross-area read (see the warnings)" for a in AREAS}
    return run, why


def plan_main() -> int:
    env = dict(os.environ)
    try:
        event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    except (KeyError, OSError, json.JSONDecodeError) as e:
        event = {}
        print(f"::warning::ci-areas: could not read the event payload ({e}); testing everything")
    run, why, warnings = decide(env, event)

    # The guard, again, on the tree being tested: an uncovered cross-area read means a skip
    # could hide a failure, so plan everything and say why. (`check` in Doc gates FAILS on it.)
    try:
        _, _, problems = scan(_tracked_files(), lambda f: (ROOT / f).read_text(encoding="utf-8", errors="replace"))
    except Exception as e:  # noqa: BLE001 — any scan failure is a reason to test more, not less
        problems = [f"the cross-area scan failed: {e}"]
    run, why = force_on_problems(run, why, warnings, problems)

    for w in warnings:
        print(f"::warning::ci-areas: {w}")
    out = env.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            for a, v in run.items():
                fh.write(f"{a}={'true' if v else 'false'}\n")
    lines = ["### Which areas this run tests (#1095)", "",
             "A run tests every area with a change since that area last passed on this branch.", "",
             "| Area | Runs | Why |", "|---|---|---|"]
    lines += [f"| {a} | {'yes' if run[a] else 'no'} | {why[a]} |" for a in AREAS]
    summary = env.get("GITHUB_STEP_SUMMARY")
    text = "\n".join(lines) + "\n"
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return 0


def check_main() -> int:
    tracked = _tracked_files()
    counts, refs, problems = scan(tracked, lambda f: (ROOT / f).read_text(encoding="utf-8", errors="replace"))
    for area, floor in FLOOR_FILES.items():
        if counts.get(area, 0) < floor:
            problems.append(f"population: only {counts.get(area, 0)} {area} test files found (floor {floor}) "
                            f"— TEST_FILES no longer matches where the tests live")
    if len(refs) < FLOOR_REFERENCES:
        problems.append(f"population: only {len(refs)} cross-area references found (floor {FLOOR_REFERENCES}) "
                        f"— the scan has gone blind")
    problems += check_workflow((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    for pats in (*AREAS.values(), ALWAYS_ALL):
        for p in pats:
            try:
                _pattern_regex(p)
            except ValueError as e:
                problems.append(str(e))
    print(f"ci-areas: scanned {counts} test files; {len(refs)} cross-area references, "
          f"{sum(1 for ok in refs.values() if ok)} covered")
    for p in problems:
        print(f"ERROR: {p}")
    return 1 if problems else 0


def explain_main(base: str, head: str) -> int:
    files = changed_since(base, head)
    for area, hit in areas_for(files).items():
        print(f"{area:9s} {'RUN ' if hit else 'skip'} {_few(hit) if hit else ''}")
    return 0


# ── self-test ────────────────────────────────────────────────────────────────────────────
def self_test() -> int:
    failures = []

    def expect(cond, what):
        if not cond:
            failures.append(what)

    # The matcher, against GitHub's documented semantics (workflow-syntax, filter cheat sheet).
    expect(matches("frontend/src/a/b/c.ts", ["frontend/src/**"]), "`**` must cross directories")
    expect(not matches("frontend/src", ["frontend/src/**"]), "`dir/**` names files inside, not the dir")
    expect(not matches("electron/scripts/x.js", ["electron/*.js"]), "`*` must not cross `/`")
    expect(matches("electron/zoom.js", ["electron/*.js"]), "`*` within a segment")
    expect(not matches("backend/app.py", ["backend"]), "a bare name is a whole path, not a prefix")
    expect(matches("CHANGELOG.md", ["CHANGELOG.md"]) and not matches("x/CHANGELOG.md", ["CHANGELOG.md"]),
           "patterns start at the repository root")
    for bad in ("backend/?.py", "!backend/**", "[ab]/x"):
        try:
            _pattern_regex(bad)
            failures.append(f"unsupported syntax accepted: {bad}")
        except ValueError:
            pass
    expect(covered(".github/workflows", [".github/workflows/**"]), "a directory read is covered by dir/**")
    expect(matches("README.md", ["**/README.md"]) and matches("a/b/README.md", ["**/README.md"]),
           "`**/` matches zero or more directories (GitHub's documented `**/README.md`)")
    expect(matches("docs/x.md", ["docs/**/*.md"]) and matches("docs/a/x.md", ["docs/**/*.md"]),
           "`docs/**/*.md` includes the directory's own files")

    # The plan: machinery changes run everything; notes alone run nothing.
    expect(all(areas_for([".github/scripts/ci-areas.py"]).values()), "a planner change must run every area")
    expect(not any(areas_for(["ISSUES.md", "docs/x.md"]).values()), "notes alone must run no area")
    hits = areas_for(["frontend/vite.config.ts"])
    expect(hits["frontend"] and not hits["backend"] and not hits["electron"],
           "a frontend build-config change runs the frontend only")
    hits = areas_for(["frontend/package-lock.json"])
    expect(hits["frontend"] and hits["backend"] and not hits["electron"],
           "a frontend lockfile change also runs the backend (test_version_agreement reads it)")
    hits = areas_for(["backend/app/routers/x.py"])
    expect(hits["backend"] and not hits["frontend"] and not hits["electron"],
           "a backend change runs the backend only")
    expect(areas_for(["frontend/src/lib/x.ts"])["backend"], "a client source change runs the backend contracts")
    expect(areas_for(["electron/zoom.js"])["frontend"], "electron/zoom.js runs the frontend (zoom.test.ts)")

    # The scan: a predicate falsifier per language, plus the shapes it must NOT report.
    roots = {"CHANGELOG.md", "README.md"}
    py = (
        '"""Docstring naming frontend/src/lib/x.ts must not count."""\n'
        'from pathlib import Path\n'
        'R = Path(__file__).resolve().parents[2]\n'
        'A = R / "frontend" / "src" / "lib" / "mirror.ts"\n'
        'A2 = R / "frontend" / "src"\n'
        'B = R / "electron" / "secret.js"\n'
        'C = (R / "CHANGELOG.md").read_text()\n'
        'D = ["frontend/package.json"]\n'
        'E = "see https://example.com/frontend/x"\n'
        # A docstring with no spaces escapes the whitespace rule; only the docstring rule skips it.
        'def f():\n'
        '    """frontend/src/lib/bare-path-docstring.ts"""\n'
    )
    got = _py_references(py, "backend", roots)
    expect(got == {"frontend/src/lib/mirror.ts", "frontend/src", "electron/secret.js", "CHANGELOG.md",
                   "frontend/package.json"},
           f"python scan found {sorted(got)}")
    js = (
        "// a comment naming '../../backend/app/x.py' must not count\n"
        "//../../backend/no-space-comment.py\n"
        "/* nor 'electron/y.js' */\n"
        "const a = readFileSync(join(SRC, '..', '..', 'backend', 'app', 'schemas', 's.py'), 'utf8')\n"
        "const b = readFileSync(join(__dirname, '../../../backend/tests/fixtures/f.json'))\n"
        "const c = path.join('/proj', 'backend', 'dist', 'mm-backend')\n"
        "const d = join(ROOT, '.github/workflows')\n"
        "const e = join(SRC, '..', 'package.json')\n"
        "const f = `${x}/backend/z.py`\n"
    )
    got = _js_references(js, "frontend", roots)
    expect(got == {"backend/app/schemas/s.py", "backend/tests/fixtures/f.json", ".github/workflows"},
           f"js scan found {sorted(got)}")

    # check_workflow: a job that would skip on a crashed plan must be reported.
    minimal = ["backend/**", "frontend/**", "electron/**", ".github/workflows/**", ".github/scripts/ci-areas.py",
               "CHANGELOG.md", "CITATION.cff"]
    wf = ("on:\n  push:\n    branches: [main]\n    paths:\n" + "".join(f"      - '{p}'\n" for p in minimal)
          + "  pull_request:\n    paths:\n" + "".join(f"      - '{p}'  # why\n" for p in minimal)
          + "jobs:\n  plan:\n    runs-on: x\n"
          + "".join(f"  {a}:\n    needs: plan\n    if: ${{{{ !cancelled() && needs.plan.outputs.{a} != 'false' }}}}\n"
                    for a in AREAS))
    expect(check_workflow(wf) == [], f"a correct workflow was reported: {check_workflow(wf)}")
    broken = wf.replace("needs.plan.outputs.backend != 'false'", "needs.plan.outputs.backend == 'true'")
    expect(any("backend" in p for p in check_workflow(broken)), "a fail-closed area condition went unreported")
    short = wf.replace("      - 'CHANGELOG.md'\n", "", 1)
    expect(any("CHANGELOG.md" in p for p in check_workflow(short)), "a missing union pattern went unreported")
    extra = wf.replace("      - 'CITATION.cff'\n", "      - 'CITATION.cff'\n      - 'docs/**'\n", 1)
    expect(any("docs/**" in p for p in check_workflow(extra)), "an unrelated trigger pattern went unreported")
    nocancel = wf.replace("!cancelled() && needs.plan.outputs.frontend", "needs.plan.outputs.frontend")
    expect(any("frontend" in p for p in check_workflow(nocancel)), "an area job without !cancelled() went unreported")
    narrow = wf.replace("      - 'electron/**'\n", "      - 'electron/*.js'\n", 1)
    expect(any("electron/**" in p for p in check_workflow(narrow)), "a trigger list too narrow went unreported")

    # decide(): the fail-safe direction, and since-last-PASS rather than since-last-push.
    priv = {"repository": {"private": True}}
    env = {"GITHUB_EVENT_NAME": "push", "GITHUB_SHA": "h" * 40, "GITHUB_TOKEN": "t",
           "GITHUB_REPOSITORY": "o/r", "GITHUB_REF_NAME": "main", "GITHUB_RUN_ID": "9"}
    run, _, _ = decide(env, {"repository": {"private": False}})
    expect(all(run.values()), "the public repository must test everything")
    # Isolated from the network and from every later fallback: history says nothing changed, so
    # only the payload rule can make this run anything.
    quiet = {"last_pass": lambda *a: {x: {"sha": "d" * 40, "run": 4} for x in AREAS},
             "changed": lambda b, h: []}
    run, _, _ = decide(env, {"repository": {"private": True}}, **quiet)
    expect(not any(run.values()), "a private push with nothing changed since every last pass runs nothing")
    run, _, _ = decide(env, {}, **quiet)
    expect(all(run.values()), "an unreadable event payload must test everything, whatever the history says")
    run, _, _ = decide({**env, "GITHUB_EVENT_NAME": "workflow_dispatch"}, priv)
    expect(all(run.values()), "a hand-started run must test everything")
    run, _, w = decide({**env, "GITHUB_TOKEN": ""}, priv)
    expect(all(run.values()) and w, "no token must test everything, with a warning")

    def boom(*a, **k):
        raise PlanError("api down")
    run, _, w = decide(env, priv, last_pass=boom)
    expect(all(run.values()) and w, "an API failure must test everything, with a warning")

    passes = {"backend": {"blocked": "failure", "sha": "a" * 40, "run": 1},
              "frontend": {"sha": "b" * 40, "run": 2},
              "electron": None}
    run, why, _ = decide(env, priv, last_pass=lambda *a: passes, changed=lambda base, head: ["docs/x.md"])
    expect(run == {"backend": True, "frontend": False, "electron": True},
           f"a failed area must rerun, an unchanged one skip, an unknown one run: {run}")
    run, _, _ = decide(env, priv, last_pass=lambda *a: {**passes, "backend": {"sha": "a" * 40, "run": 1}},
                       changed=lambda base, head: ["frontend/src/x.tsx"])
    expect(run["backend"] and run["frontend"], "a client source change since the last pass runs both")

    def not_ancestor(base, head):
        raise PlanError("not an ancestor")
    run, _, w = decide(env, priv, last_pass=lambda *a: {a: {"sha": "c" * 40, "run": 3} for a in AREAS},
                       changed=not_ancestor)
    expect(all(run.values()) and w, "a last pass outside this history must test everything")
    run, _, _ = decide({**env, "GITHUB_EVENT_NAME": "pull_request"},
                       {**priv, "pull_request": {"user": {"login": "dependabot[bot]"}}})
    expect(not any(run.values()), "a Dependabot PR on the private repo plans nothing")
    pr = {**priv, "pull_request": {"user": {"login": "someone"}, "base": {"sha": "b"}, "head": {"sha": "h"}}}
    run, _, _ = decide({**env, "GITHUB_EVENT_NAME": "pull_request"}, pr,
                       changed_pr=lambda b, h: ["electron/main.js"])
    expect(run == {"backend": True, "frontend": False, "electron": True},
           f"a pull request runs what its own diff reaches: {run}")
    run, _, w = decide({**env, "GITHUB_EVENT_NAME": "pull_request"}, pr, changed_pr=boom)
    expect(all(run.values()) and w, "an unreadable pull-request diff must test everything")

    # last_passes(): skipped jobs are stepped over; the first job that ran decides. The list
    # arrives UNORDERED and unfiltered, as the API might send it: the walk filters and sorts.
    def r(i, event, when, branch="main", status="completed"):
        return {"id": i, "event": event, "head_sha": str(i) * 40, "created_at": f"2026-10-0{when}T00:00:00Z",
                "head_branch": branch, "status": status}
    runs_page = {"workflow_runs": [
        r(6, "workflow_dispatch", 1),
        r(9, "push", 4),                               # the current run: ignored
        r(5, "push", 5, status="in_progress"),          # not finished: ignored
        r(4, "push", 6, branch="feature"),              # another branch: ignored
        r(8, "pull_request", 3),                        # a PR run: ignored
        r(7, "push", 2),
    ]}
    jobs = {7: [{"name": "plan", "conclusion": "success"}, {"name": "backend", "conclusion": "skipped"},
                {"name": "frontend", "conclusion": "cancelled"}, {"name": "electron", "conclusion": "skipped"}],
            6: [{"name": "backend", "conclusion": "success"}, {"name": "frontend", "conclusion": "success"},
                {"name": "electron", "conclusion": "success"}]}
    jobs.update({k: [{"name": a, "conclusion": "success"} for a in AREAS] for k in (4, 5, 8, 9)})

    def fake_get(path, token):
        if "/actions/workflows/" in path:
            return runs_page if "page=1" in path else {"workflow_runs": []}
        return {"jobs": jobs[int(path.split("/runs/")[1].split("/")[0])]}
    traced: list = []
    got = last_passes("o/r", "main", "t", "9", get=fake_get, log=traced.append)
    expect(len(traced) == 2 and " 7777777 " in traced[0],
           f"the walk must examine run 7 then 6, newest first, and log each: {traced}")
    expect(got["backend"] == {"sha": "6" * 40, "run": 6}, f"backend should pass at run 6: {got['backend']}")
    expect(got["frontend"].get("blocked") == "cancelled", f"a cancelled frontend must block: {got['frontend']}")
    expect(got["electron"] == {"sha": "6" * 40, "run": 6}, f"electron should pass at run 6: {got['electron']}")

    # scan(): the coverage judgment, a stale exemption, and the plan's response to a problem.
    corpus = {
        "backend/tests/test_a.py": 'from pathlib import Path\nX = Path(__file__).parents[2] / "frontend" / "src" / "lib" / "m.ts"\n',
        "backend/tests/test_b.py": 'from pathlib import Path\nY = (Path(__file__).parents[2] / "README.md").read_text()\n',
        "frontend/src/lib/c.test.ts": "readFileSync(join(__dirname, '..', '..', '..', 'electron', 'zoom.js'))\n",
        "electron/d.test.js": "require('node:test')\n",
    }
    tracked = [*corpus, "README.md", "CHANGELOG.md"]
    global EXEMPT
    saved, EXEMPT = EXEMPT, {("electron", "electron/gone.test.js", "backend/x"): "a reason"}
    try:
        _, refs, problems = scan(tracked, corpus.__getitem__)
    finally:
        EXEMPT = saved
    expect(refs.get(("backend", "backend/tests/test_a.py", "frontend/src/lib/m.ts")) is True,
           "a covered read must be judged covered")
    expect(any("README.md" in p for p in problems), "an uncovered read (README.md) must be a problem")
    expect(any("stale EXEMPT" in p for p in problems), "a stale exemption must be a problem")
    expect(not any("zoom.js" in p for p in problems), "electron/zoom.js is covered for the frontend")
    w: list = []
    run, _ = force_on_problems({"backend": True, "frontend": False, "electron": False}, {}, w, ["x"])
    expect(all(run.values()) and w, "the plan must test everything when the scan reports a problem")

    for f in failures:
        print(f"SELF-TEST FAILED: {f}")
    print("ci-areas self-test:", "FAILED" if failures else "ok")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--self-test"]:
        return self_test()
    if argv[:1] == ["plan"]:
        return plan_main()
    if argv[:1] == ["check"]:
        return check_main()
    if argv[:1] == ["explain"] and len(argv) == 3:
        return explain_main(argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
