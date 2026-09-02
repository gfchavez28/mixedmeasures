"""#842/#844 — the `.mmproject` export bound, and the join-backs that replaced
the project-wide id lists.

Three claims, three shapes of guard:

1. **Structural** — the dataset-scaled entities are never reached through a Python
   id list handed to `.in_()`. A FIXTURE cannot carry this: the boundary is SQLite's
   `SQLITE_MAX_VARIABLE_NUMBER` at 250,000, and building a 250,000-value project
   takes ~7 s and ~870 MB (measured, #842 depth pass). The portability suite next
   door creates THREE `DatasetValue` rows and its largest loop is `range(10)` —
   five orders of magnitude below the boundary, which is exactly why nothing caught
   this. So the guard reads the SOURCE.
2. **Behavioural** — the join-backs return what the id lists returned. ⚠️ The fixture
   must carry a dataset-value excerpt, note AND code application: `dev.db` has NONE
   of the first two anywhere, so an equivalence check against real data would have
   been degenerate for two of the three arms and passed by finding nothing.
3. **Behavioural** — the bound refuses, with a message, through a DISTINCT exception
   type, at all three of `export_project`'s callers.
"""

import ast
import os
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models import (
    Code, CodeApplication, Dataset, DatasetColumn, DatasetRow, DatasetValue,
    Excerpt, Note, Project,
)
from app.models.dataset import ColumnType
from app.services import project_portability as pp
from app.services.project_portability import (
    MAX_PROJECT_EXPORT_VALUES,
    ProjectTooLargeError,
    assert_project_exportable,
    project_export_size_error,
)

APP_DIR = Path(pp.__file__).resolve().parent.parent


# ── 1. Structural: no dataset-scaled id list reaches `.in_()` ───────────────
#
# The predicate is deliberately NARROW and its narrowness is the honest part.
# Most `.in_()` arguments in `export_project` are id lists and are FINE —
# `conv_ids`, `doc_ids`, `domain_ids`, `metric_ids`, `canvas_ids` are all bounded
# by a count the researcher chooses one at a time. What may never be a list is a
# collection scaled by DATASET SIZE: rows and values. So the scan asks "is this
# name bound to a comprehension over a dataset-scaled collection?", not "is this
# name a list?" — a broader rule would have to allowlist almost every call.

DATASET_SCALED_SOURCES = {"dataset_values", "dataset_rows", "rows", "values"}

# ⚠️ #844 CHANGED THE PREMISE FOR ONE OF THESE FUNCTIONS, and the entry is
# RE-AIMED rather than deleted.
#
# `list_texts` now serves a PAGE (`limit`, hard-capped at `MAX_TEXT_PAGE_SIZE` =
# 1,000), so the id list it hands to `.in_()` is bounded three orders of
# magnitude under the 250,000 ceiling — and the `scalar_subquery` that fixed
# #842 was deliberately removed, because against a page it re-runs the whole
# filtered scan three extra times per request.
#
# So for that function the invariant is no longer "no id list reaches `.in_()`";
# it is **"the id list is BOUNDED, and the bound is enforced at the signature"**.
# Deleting the parametrize entry would have left nothing watching either
# property — including the case where someone removes the cap and leaves the
# `.in_()` bindings, which is precisely how #842 comes back.
PAGED_BOUND = {
    ("routers/text_coding.py", "list_texts"): "MAX_TEXT_PAGE_SIZE",
}


def _assert_bounded_by_a_capped_page(path: Path, fn_name: str, const: str) -> None:
    """The function pages, and the page size is capped by a module constant.

    ⚠️ **Read STRUCTURALLY, off the `limit` argument's own annotation — never as
    text over the function body.** The first version of this check was
    `f"le={const}" in ast.get_source_segment(...)`, and it PASSED under a mutant
    that deleted the cap from the signature: `list_texts`' body carries a
    comment explaining why the cap is what makes its `.in_()` bindings safe, so
    the scan was reading its own prose (#772, and the tests manual's
    strip-comments rule reached from the other side). An AST walk of the
    annotation cannot be fooled by a comment.
    """
    src = path.read_text()
    fn = _function(path, fn_name)

    assert f"\n{const} = " in src, (
        f"{path.name} no longer defines `{const}`, so the id lists "
        f"{fn_name} binds to `.in_()` are unbounded again (#842)."
    )
    limit_arg = next(
        (a for a in fn.args.args + fn.args.kwonlyargs if a.arg == "limit"), None,
    )
    assert limit_arg is not None, (
        f"{fn_name} no longer takes `limit`, so it does not page — its "
        f"`.in_()` bindings are dataset-scaled again (#844)."
    )
    capped = any(
        isinstance(node, ast.keyword)
        and node.arg == "le"
        and isinstance(node.value, ast.Name)
        and node.value.id == const
        for node in ast.walk(limit_arg.annotation)
    ) if limit_arg.annotation is not None else False
    assert capped, (
        f"{fn_name}'s `limit` is not capped by `{const}` in its own annotation. "
        f"The cap is what keeps its `.in_()` bindings under SQLite's 250,000-"
        f"parameter ceiling; without it a caller may ask for the whole corpus "
        f"and #842 returns."
    )


def _comprehension_bound_names(fn: ast.FunctionDef) -> dict[str, str]:
    """Names assigned from a comprehension, mapped to the collection iterated."""
    found: dict[str, str] = {}
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if not isinstance(node.value, (ast.ListComp, ast.SetComp)):
            continue
        for gen in node.value.generators:
            if isinstance(gen.iter, ast.Name):
                found[target.id] = gen.iter.id
    return found


def _in_call_arg_names(fn: ast.FunctionDef) -> list[str]:
    """Every bare NAME passed to a `.in_(...)` call inside `fn`."""
    names = []
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "in_"
            and node.args
            and isinstance(node.args[0], ast.Name)
        ):
            names.append(node.args[0].id)
    return names


def _function(path: Path, name: str) -> ast.FunctionDef:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(
        f"{name} not found in {path.name} — the scan has gone blind and would "
        f"otherwise pass by finding nothing (#729)."
    )


@pytest.mark.parametrize(
    "rel,fn_name",
    [
        ("services/project_portability.py", "export_project"),
        ("routers/text_coding.py", "list_texts"),
    ],
)
def test_no_dataset_scaled_id_list_reaches_in_(rel, fn_name):
    path = APP_DIR / rel
    const = PAGED_BOUND.get((rel, fn_name))
    if const:
        # This function is allowed a bounded id list — see PAGED_BOUND. The
        # assertion moves to the bound itself rather than disappearing.
        _assert_bounded_by_a_capped_page(path, fn_name, const)
        return
    fn = _function(path, fn_name)
    bound = _comprehension_bound_names(fn)
    offenders = [
        f"{name} (built from `{bound[name]}`)"
        for name in _in_call_arg_names(fn)
        if bound.get(name) in DATASET_SCALED_SOURCES
    ]
    assert offenders == [], (
        f"{fn_name} passes a dataset-scaled id list to `.in_()`: {offenders}. "
        "SQLAlchemy renders ONE BIND PARAMETER PER ELEMENT and SQLite's "
        "SQLITE_MAX_VARIABLE_NUMBER is 250,000, so this raises a raw "
        "OperationalError on a real survey (#842/#844). Join back to the dataset, "
        "or pass a scalar subquery — never a Python list."
    )


def test_the_scan_is_not_blind():
    """POPULATION self-check (#730): a scan whose expected result is `[]` passes by
    finding nothing, including when its own walk has rotted."""
    fn = _function(APP_DIR / "services" / "project_portability.py", "export_project")
    in_names = _in_call_arg_names(fn)
    bound = _comprehension_bound_names(fn)
    assert len(in_names) >= 8, (
        f"expected export_project to still contain many `.in_(name)` calls, found "
        f"{len(in_names)} — the walk is not reaching the function body."
    )
    assert len(bound) >= 5, (
        f"expected export_project to still bind several id lists by comprehension, "
        f"found {len(bound)} — the assignment matcher is not firing."
    )


def test_the_predicate_actually_fires():
    """PREDICATE falsifier (#729): prove the matcher catches the shape it exists for,
    rather than passing because it matches nothing at all."""
    bad = ast.parse(
        "def export_project(db, pid):\n"
        "    dataset_values = q.all()\n"
        "    value_ids = [v.id for v in dataset_values]\n"
        "    return db.query(X).filter(X.dataset_value_id.in_(value_ids)).all()\n"
    ).body[0]
    bound = _comprehension_bound_names(bad)
    offenders = [n for n in _in_call_arg_names(bad) if bound.get(n) in DATASET_SCALED_SOURCES]
    assert offenders == ["value_ids"], (
        "the scan failed to flag the exact pre-#842 source shape; it is not "
        "protecting anything."
    )


# ── 2. Behavioural: the join-backs are equivalent ───────────────────────────

def _project_with_dataset_annotations(db: Session) -> tuple[Project, list[int]]:
    """A project whose dataset values carry an excerpt, a note AND a coding.

    ⚠️ All three arms are seeded on purpose. `dev.db` holds dataset-value code
    applications but ZERO dataset-value excerpts and ZERO dataset-value notes, so a
    check against real data agrees for two arms by finding nothing on both sides.
    """
    project = Project(name="Join-back fixture", user_id=1)
    db.add(project)
    db.flush()

    dataset = Dataset(project_id=project.id, name="Survey")
    db.add(dataset)
    db.flush()

    column = DatasetColumn(
        dataset_id=dataset.id, column_text="Comments",
        column_type=ColumnType.OPEN_TEXT, sequence_order=1,
    )
    db.add(column)
    db.flush()

    code = Code(project_id=project.id, name="Theme A", numeric_id=1)
    db.add(code)
    db.flush()

    value_ids = []
    for i in range(4):
        row = DatasetRow(dataset_id=dataset.id, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        value = DatasetValue(row_id=row.id, column_id=column.id, value_text=f"answer {i}")
        db.add(value)
        db.flush()
        value_ids.append(value.id)
        db.add(Excerpt(project_id=project.id, dataset_value_id=value.id))
        db.add(Note(dataset_value_id=value.id, content=f"note {i}", sequence_number=1))
        db.add(CodeApplication(dataset_value_id=value.id, code_id=code.id, user_id=1))
    db.flush()
    return project, value_ids


def test_join_back_export_carries_dataset_value_children(db_session, tmp_path):
    """The three arms the id lists used to reach must all still travel."""
    project, value_ids = _project_with_dataset_annotations(db_session)
    db_session.commit()

    buf = pp.export_project(db_session, project.id, tmp_path / "docs", tmp_path / "media")

    import json, zipfile
    with zipfile.ZipFile(buf) as zf:
        data = json.loads(zf.read("project.json"))

    assert len(data["dataset_values"]) == 4
    assert len(data["code_applications"]) == 4, (
        "the dataset-value arm of code_applications was dropped by the join-back"
    )
    assert len(data["notes"]) == 4, "the dataset-value arm of notes was dropped"
    assert len(data["excerpts"]) == 4


def test_export_reaches_values_through_rows_not_an_id_list(db_session, tmp_path):
    """A value whose row belongs to ANOTHER project must not travel — the join-back
    widened the FROM clause, so this pins that it did not widen the RESULT."""
    project, _ = _project_with_dataset_annotations(db_session)
    other, _ = _project_with_dataset_annotations(db_session)
    db_session.commit()

    import json, zipfile
    buf = pp.export_project(db_session, project.id, tmp_path / "docs", tmp_path / "media")
    with zipfile.ZipFile(buf) as zf:
        data = json.loads(zf.read("project.json"))

    assert len(data["dataset_values"]) == 4, "the export leaked another project's values"
    assert len(data["code_applications"]) == 4
    assert len(data["notes"]) == 4


# ── 3. Behavioural: the bound ──────────────────────────────────────────────

def test_message_is_none_at_and_below_the_bound():
    assert project_export_size_error(0) is None
    assert project_export_size_error(MAX_PROJECT_EXPORT_VALUES) is None, (
        "the bound must be inclusive — a project exactly at the limit exports"
    )


def test_message_fires_one_value_over_and_says_what_to_do():
    message = project_export_size_error(MAX_PROJECT_EXPORT_VALUES + 1)
    assert message is not None
    assert f"{MAX_PROJECT_EXPORT_VALUES:,}" in message, "the limit must be NAMED"
    assert "Backup" in message, (
        "the message must say backups are unaffected — 'export is broken' reads as "
        "'my data is unprotected', and that is not the case (#842)"
    )
    assert "include_media" not in message and "media" not in message.lower(), (
        "media is not counted by this bound, so offering a media-less export as a "
        "workaround is advice that does not work"
    )


def test_refusal_is_a_distinct_type_not_a_bare_value_error():
    """#797's defect, which a shared exception type would reintroduce silently:
    `export_project_endpoint` maps `ValueError` to **404**, so a bare ValueError
    would tell the researcher their project was not found."""
    assert issubclass(ProjectTooLargeError, ValueError)
    assert ProjectTooLargeError is not ValueError


def test_assert_project_exportable_counts_only_this_project(db_session, monkeypatch):
    project, _ = _project_with_dataset_annotations(db_session)
    _other, _ = _project_with_dataset_annotations(db_session)
    db_session.commit()

    # Under the real bound both projects pass.
    assert_project_exportable(db_session, project.id)

    # Drop the bound below this project's own 4 values; it must refuse on its OWN
    # count, not the instance-wide 8.
    monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", 3)
    with pytest.raises(ProjectTooLargeError):
        assert_project_exportable(db_session, project.id)
    monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", 4)
    assert_project_exportable(db_session, project.id)


def test_export_project_refuses_before_gathering(db_session, tmp_path, monkeypatch):
    """The refusal is in the SERVICE, not at a router — `export_project` has three
    callers and a router guard is not a guard on the operation (#589)."""
    project, _ = _project_with_dataset_annotations(db_session)
    db_session.commit()
    monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", 1)
    with pytest.raises(ProjectTooLargeError) as exc:
        pp.export_project(db_session, project.id, tmp_path / "docs", tmp_path / "media")
    assert "4 dataset values" in str(exc.value)


def test_overwrite_safety_backup_reports_the_size_reason(db_session, tmp_path, monkeypatch):
    """The abort is correct; the REASON has to survive the generic wrapper."""
    project, _ = _project_with_dataset_annotations(db_session)
    db_session.commit()
    monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", 1)
    monkeypatch.setattr(pp, "get_backup_dir", lambda: tmp_path)
    with pytest.raises(ProjectTooLargeError) as exc:
        pp._safety_export_before_overwrite(
            db_session, project, tmp_path / "docs", tmp_path / "media",
        )
    message = str(exc.value)
    assert "too large" in message
    assert "too many SQL variables" not in message
    assert "Could not create a safety backup" not in message, (
        "the generic wrapper swallowed the size reason"
    )
