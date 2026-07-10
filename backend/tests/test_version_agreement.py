"""The app version is duplicated across shipping files; assert they never drift.

RELEASING.md carries a "bump the version — all must match" checklist. A checklist
is prose: nothing fails when step 5 of 8 is skipped, and the mismatch surfaces
later as a wrong `About` string, a wrong `.mmbackup` manifest, or an installer
whose filename disagrees with the app inside it. This is the fail-closed guard,
in the same spirit as the source scans in `test_datetime_wire_format.py` and
`test_codeapplication_grain_sweep.py`.

Deliberately NOT covered: `backend/tests/test_backup.py`'s
`assert manifest["app_version"] == "x.y.z"`. That line is its own tripwire (it
fails on its own when `backup.APP_VERSION` moves), and regex-reading an assertion
out of a test file would break on a harmless reformat. Bumping the version means
editing that file too — see the RELEASING.md checklist.

When adding a NEW file that hardcodes the version, add it here AND to RELEASING.md.
"""

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _json_version(rel_path: str, *keys: str) -> str:
    """Read a nested version out of a JSON file. `keys` walks down to the object."""
    data = json.loads((REPO_ROOT / rel_path).read_text(encoding="utf-8"))
    for key in keys:
        data = data[key]
    return data["version"]


def _regex_version(rel_path: str, pattern: str) -> str:
    src = (REPO_ROOT / rel_path).read_text(encoding="utf-8")
    match = re.search(pattern, src, re.MULTILINE)
    assert match, f"no version found in {rel_path} (pattern: {pattern!r})"
    return match.group(1)


def _collect_versions() -> dict[str, str]:
    """Every shipping site that hardcodes the app version, keyed by a readable label."""
    return {
        "electron/package.json": _json_version("electron/package.json"),
        "electron/package-lock.json (root)": _json_version("electron/package-lock.json"),
        "electron/package-lock.json (packages[''])": _json_version(
            "electron/package-lock.json", "packages", ""
        ),
        "frontend/package.json": _json_version("frontend/package.json"),
        "frontend/package-lock.json (root)": _json_version("frontend/package-lock.json"),
        "frontend/package-lock.json (packages[''])": _json_version(
            "frontend/package-lock.json", "packages", ""
        ),
        # FastAPI app declaration: version="1.1.1"
        "backend/app/main.py": _regex_version(
            "backend/app/main.py", r'^\s*version="([^"]+)",'
        ),
        # Backup manifest stamp: APP_VERSION = "1.1.1"
        "backend/app/services/backup.py": _regex_version(
            "backend/app/services/backup.py", r'^APP_VERSION = "([^"]+)"'
        ),
        # CFF is flat YAML; regex-read it rather than depend on PyYAML, which is
        # importable in the dev venv but is not a declared requirement.
        "CITATION.cff": _regex_version("CITATION.cff", r"^version: (.+)$"),
    }


def test_all_version_sites_agree():
    versions = _collect_versions()
    distinct = set(versions.values())
    assert len(distinct) == 1, (
        "app version has drifted across shipping files — bump every site "
        f"(see RELEASING.md):\n"
        + "\n".join(f"  {site:44} {version}" for site, version in versions.items())
    )


@pytest.mark.parametrize("site", sorted(_collect_versions()))
def test_version_site_is_semver(site):
    version = _collect_versions()[site]
    assert SEMVER.match(version), f"{site} carries a non-semver version: {version!r}"


def test_citation_cff_release_date_is_iso():
    """A CFF consumer (GitHub's "Cite this repository", cffconvert) needs a real date."""
    released = _regex_version("CITATION.cff", r"^date-released: (.+)$")
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", released), (
        f"CITATION.cff date-released must be YYYY-MM-DD, got {released!r}"
    )


def test_changelog_anchors_version_to_release_date():
    """The date guard is fail-open without an independent anchor (#545).

    Bumping every version site while forgetting BOTH date mirrors passes the
    mirror-agreement test below — the mirrors go stale *together*, which is
    exactly what the plausible human error produces (the bump mental model is
    "version", not "date"). The CHANGELOG's `## [x.y.z] - YYYY-MM-DD` heading
    ties the CURRENT version to its release date, so a stale date OR a missing
    CHANGELOG entry fails here. Holds mid-cycle too: the released heading stays
    in the file while work accumulates under [Unreleased].
    """
    version = _regex_version("CITATION.cff", r"^version: (.+)$")
    released = _regex_version("CITATION.cff", r"^date-released: (.+)$")
    changelog = (REPO_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    heading = f"## [{version}] - {released}"
    assert heading in changelog, (
        f"CHANGELOG.md has no {heading!r} heading — either the release entry is "
        "missing, or CITATION.cff/frontend/package.json carry a stale release "
        "date (bump-version-forget-the-dates is exactly the drift this guards; "
        "see RELEASING.md)"
    )


def test_pyproject_declares_no_version():
    """backend/pyproject.toml hosts pytest config, not packaging metadata (#545).

    Its `[project] version` sat two releases stale OUTSIDE this guard (and
    `backend/` is on the public sync SHIP list), so the table was removed. If
    packaging metadata is ever reintroduced, the version becomes a shipping
    site: add it to `_collect_versions()` AND the RELEASING.md table — do not
    just delete this test.
    """
    src = (REPO_ROOT / "backend/pyproject.toml").read_text(encoding="utf-8")
    assert not re.search(r"^version\s*=", src, re.MULTILINE), (
        "backend/pyproject.toml declares a version again — wire it into "
        "_collect_versions() + the RELEASING.md table, or it WILL drift"
    )


def test_release_date_mirrors_agree():
    """`frontend/package.json` mirrors CITATION.cff's release date; assert they agree.

    The frontend can't read CITATION.cff at build time — `frontend/Dockerfile` builds
    with a `./frontend` docker-compose context, so the repo root isn't there. So the
    date is mirrored into package.json (where Vite reads it for the in-app citation
    year) and guarded here, the same mirror + agreement-test shape used by
    `lib/media-constants.ts` / `lib/dataset-constants.ts`.
    """
    cff_date = _regex_version("CITATION.cff", r"^date-released: (.+)$")
    pkg = json.loads((REPO_ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    pkg_date = pkg.get("releaseDate")
    assert pkg_date, 'frontend/package.json is missing "releaseDate" (the citation year)'
    assert pkg_date == cff_date, (
        "release date has drifted (see RELEASING.md):\n"
        f"  CITATION.cff date-released  {cff_date}\n"
        f"  frontend/package.json       {pkg_date}"
    )
