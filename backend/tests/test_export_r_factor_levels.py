"""#765 / #583 — an R factor's `levels` must live in the same space as the CSV cell.

`factor()` matches `levels` against the cell VERBATIM and returns **NA** for
anything unmatched — silently, with no error, so the script runs green and the
variable is simply absent from every downstream analysis. Two spaces were being
mixed:

* **#765** — a value-labelled NOMINAL column writes `value_text` (the LABEL,
  per #494) while the script declared the numeric CODES. Every such column —
  every labelled `.sav` nominal, i.e. gender / region / site / condition —
  exported as 100% NA.
* **#583** — an ordinal with a REVERSE primary writes the REFLECTED score while
  the script declared the FORWARD codes. On a contiguous scale the code SET
  survives reflection, so only the labels were inverted; on a GAPPED scale the
  reflected values leave the set and become NA.

⚠️ **The structural tests below assert our own belief about the emitted shape.
`test_every_observed_value_survives_the_factor_in_R` is the one that can see the
defect** — a levels/cell mismatch is invisible to any assertion that only reads
the script text, which is exactly how this shipped. It is R-gated (#642: a skip
reports green, so CI sets `MM_REQUIRE_R=1`).

⚠️ The fixtures are deliberately non-degenerate, per `backend/tests/the internal design notes:
the reverse scale is GAPPED (1, 2, 5 — a contiguous scale reflects onto itself
and cannot distinguish the fix from the bug) and the nominal carries an
UNDECLARED observed code (7) alongside its declared ones.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import csv
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.dataset import (
    Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType,
)
from app.models.project import Project
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.models.user import User
from app.routers.export_r import export_r_data
from app.services.recode import recompute_primary_value_numeric
from app.services.value_labels import apply_value_labels
from tests import r_support

PID = 7650

# Forward codes with a GAP: reflection about min+max = 6 sends 2 -> 4, which is
# NOT in {1, 2, 5}. A 1..5 scale cannot fail this test — it is symmetric.
# "Prefer not to say" is a declared point nobody chose (#577) that the
# recognized-N/A defaults treat as MISSING. It is what makes the offset's SOURCE
# testable: `effective_reverse_offset` excludes the null set and reflects about
# 1+5=6, while a re-derived `min + max` over the raw mapping would use 1+99=100
# and put every level somewhere the data never goes (#600).
REVERSE_FORWARD = {"Never": 1, "Sometimes": 2, "Always": 5, "Prefer not to say": 99}
REVERSE_RESPONSES = ["Never", "Sometimes", "Always", "Never", "Sometimes", "Always"]
REGION_CODES = [1, 2, 3, 7, 1, 2]          # 7 is observed but never declared
GENDERS = ["Male", "Female", "Male", "Female", "Male", "Female"]


async def _export_bytes(pid, user, db) -> bytes:
    resp = export_r_data(project_id=pid, user=user, db=db)
    chunks = [c async for c in resp.body_iterator]
    return b"".join(chunks if isinstance(chunks[0], bytes)
                    else [c.encode() for c in chunks])


def _seed(db):
    """Three columns, one per space the emitter has to get right."""
    user = db.query(User).filter(User.id == 1).first()
    db.add(Project(id=PID, name="Factor levels", user_id=1)); db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="Survey")); db.flush()

    region = DatasetColumn(  # labelled nominal, via apply_value_labels
        id=7651, dataset_id=PID, column_code="Region", column_name="Region",
        column_text="Region", column_type=ColumnType.NOMINAL,
        sequence_order=1, display_order=1)
    gender = DatasetColumn(  # labelled nominal, .sav shape: metadata, no recode
        id=7652, dataset_id=PID, column_code="Gender", column_name="Gender",
        column_text="Gender", column_type=ColumnType.NOMINAL,
        sequence_order=2, display_order=2,
        scale_labels=json.dumps(["Male", "Female"]),
        scale_values=json.dumps([1, 2]))
    item = DatasetColumn(  # ordinal, gapped scale, reverse primary
        id=7653, dataset_id=PID, column_code="Item", column_name="Item",
        column_text="Item", column_type=ColumnType.ORDINAL,
        sequence_order=3, display_order=3)
    db.add_all([region, gender, item]); db.flush()

    rows = [DatasetRow(dataset_id=PID) for _ in range(6)]
    db.add_all(rows); db.flush()
    for r, code, g, resp in zip(rows, REGION_CODES, GENDERS, REVERSE_RESPONSES):
        db.add(DatasetValue(row_id=r.id, column_id=region.id,
                            value_text=str(code), value_numeric=float(code)))
        db.add(DatasetValue(row_id=r.id, column_id=gender.id,
                            value_text=g, value_numeric=None))
        db.add(DatasetValue(row_id=r.id, column_id=item.id, value_text=resp,
                            value_numeric=float(REVERSE_FORWARD[resp])))
    db.flush()

    apply_value_labels(db, region, [(1.0, "North"), (2.0, "South"), (3.0, "East")],
                       ColumnType.NOMINAL)
    rev = RecodeDefinition(
        column_id=item.id, name="Reversed", recode_type=RecodeType.REVERSE,
        output_type=OutputType.NUMERIC, mapping=json.dumps(REVERSE_FORWARD),
        is_primary=True, is_auto_detected=False, sequence_order=0)
    db.add(rev); db.flush()
    recompute_primary_value_numeric(db, rev, item.id)
    db.flush()
    return user


_FACTOR_RE = re.compile(
    r"data\$(\w+) <- factor\(data\$\w+,\s*\n\s*levels = c\(([^)]*)\)"
    r"(?:,\s*\n\s*labels = c\(([^)]*)\))?")


def _factors(script: str) -> dict[str, tuple[str, str | None]]:
    return {m.group(1): (m.group(2).strip(), m.group(3)) for m in _FACTOR_RE.finditer(script)}


def _items(c_args: str) -> list[str]:
    """`"North", "South", 7` -> ['North', 'South', '7'] — quoting stripped so a
    test can assert the exact list without caring how a value was rendered."""
    return [v.strip().strip('"') for v in c_args.split(",") if v.strip()]


def _registry(script: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip()
            for m in re.finditer(r"`(\w+)` = c\(([^)]*)\)", script)}


@pytest.fixture
def bundle(db_session):
    """(script_text, csv_rows, db) for one export of the seeded project."""
    user = _seed(db_session)
    raw = asyncio.run(_export_bytes(PID, user, db_session))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode("utf-8")
        csv_name = next(n for n in zf.namelist() if n.endswith("_data.csv"))
        rows = list(csv.reader(io.StringIO(zf.read(csv_name).decode("utf-8-sig"))))
    return script, rows, db_session, raw


class TestLevelsMatchTheCellSpace:
    def test_labelled_nominal_levels_are_the_labels(self, bundle):
        """#765: the cell is the LABEL, so the level must be too.

        ⚠️ Asserts the EXACT list, not membership. A membership assertion
        (`'"North"' in levels`) survives a mutant that emits the codes AND the
        labels — measured: reverting this branch to the codes leaves the labels
        in place via the observed-extras pass, so four of these six tests still
        passed. A superset is a different defect, not a pass.
        """
        script, _, _, _ = bundle
        levels, labels = _factors(script)["region"]
        assert _items(levels) == ["North", "South", "East", "7"], levels
        assert labels is not None and _items(labels) == ["North", "South", "East", "7"]

    def test_sav_shape_nominal_without_a_recode_gets_text_levels_too(self, bundle):
        """The priority-2 branch (scale metadata, no recode) is the .sav shape —
        a separate code path from the labelled-via-dialog one, and equally wrong
        before the fix."""
        script, _, _, _ = bundle
        levels, _ = _factors(script)["gender"]
        assert _items(levels) == ["Male", "Female"], levels

    def test_reverse_ordinal_levels_are_the_reflected_scores(self, bundle):
        """#583: value_numeric holds `offset - code`, so the levels must too —
        and on this GAPPED scale 4 is a reflected score that is not a forward
        code, which is what makes the two spaces distinguishable at all."""
        script, _, _, _ = bundle
        levels, labels = _factors(script)["item"]
        assert _items(levels) == ["1", "4", "5"], (
            f"expected the reflected scores 1, 4, 5 (forward codes were 1, 2, 5): {levels}")
        # Ascending by STORED score, so `ordered = TRUE` reads the way the data does.
        assert _items(labels) == ["Always", "Sometimes", "Never"]

    def test_undeclared_observed_value_joins_as_a_level(self, bundle):
        """An observed code nobody declared is a real category everywhere else
        in the app (frequency, cross-tab). Dropping it here would replace one
        silent-NA class with another."""
        script, _, _, _ = bundle
        levels, _ = _factors(script)["region"]
        assert "7" in _items(levels), levels

    def test_registry_carries_the_CODES_even_for_a_text_level_factor(self, bundle):
        """#537's `.mm_scale_codes` is what keeps a text-level factor usable
        numerically — `.mm_num` must recover 1/2, not the 1..K positions."""
        script, _, _, _ = bundle
        reg = _registry(script)
        assert reg["gender"].replace(" ", "") == "1,2", reg.get("gender")
        # The undeclared "7" parses, so it registers as itself rather than NA.
        assert reg["region"].replace(" ", "") == "1,2,3,7", reg.get("region")
        # A reverse column's stored number IS the reflected score.
        assert reg["item"].replace(" ", "") == "1,4,5", reg.get("item")


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
class TestTheFactorActuallyMatchesInR:
    """The only assertions that can SEE a levels/cell mismatch.

    Everything above reads the script we just wrote; R is what reads the script
    against the data. Expected values are derived from the DATABASE, never from
    the script, so this cannot become the bug comparing itself.
    """

    def test_every_observed_value_survives_the_factor_in_R(self, bundle):
        script, rows, db, _ = bundle
        stored = {
            "item": [v.value_numeric for v in db.query(DatasetValue)
                     .filter(DatasetValue.column_id == 7653)
                     .order_by(DatasetValue.row_id).all()],
            "region": [v.value_numeric for v in db.query(DatasetValue)
                       .filter(DatasetValue.column_id == 7651)
                       .order_by(DatasetValue.row_id).all()],
        }
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            (wd / "setup.R").write_text(script, encoding="utf-8")
            # The CSV must sit beside the script under the name it reads.
            _, _, _, raw = bundle
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for n in zf.namelist():
                    (wd / Path(n).name).write_bytes(zf.read(n))
            (wd / "runner.R").write_text(
                'source("setup.R")\n'
                'for (nm in c("region","gender","item")) {\n'
                '  v <- data[[nm]]\n'
                '  cat("NA", nm, sum(is.na(v)), "\\n")\n'
                '  cat("NLEV", nm, nlevels(v), "\\n")\n'
                '  cat("NUM", nm, paste(.mm_num(v, nm), collapse=","), "\\n")\n'
                '  cat("LAB", nm, paste(as.character(v), collapse=","), "\\n")\n'
                '}\n', encoding="utf-8")
            proc = subprocess.run([r_support.RSCRIPT, "runner.R"], cwd=str(wd),
                                  capture_output=True, text=True, timeout=300)
        assert proc.returncode == 0, f"script failed in R:\n{proc.stderr}"
        out = {}
        for line in proc.stdout.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3:
                out[(parts[0], parts[1])] = parts[2].strip()

        # A phantom level is the other half of the same defect: a superset that
        # happens to contain the right values still reports 0 NA. Measured — a
        # mutant emitting BOTH spaces passed the NA check and was only caught
        # here (R silently MERGES duplicate labels, so it looks healthy).
        for nm, expected in (("region", "4"), ("gender", "2"), ("item", "3")):
            assert out[("NLEV", nm)] == expected, (
                f"{nm}: {out[('NLEV', nm)]} levels, expected {expected} — "
                "levels from two different spaces were emitted")

        for nm in ("region", "gender", "item"):
            assert out[("NA", nm)] == "0", (
                f"{nm}: {out[('NA', nm)]} of 6 values did not match any factor level — "
                "the levels are in a different space from the cells")

        # .mm_num must reproduce what the tool itself stores, or every R number
        # computed from this column diverges from the app's (#537).
        for nm in ("item", "region"):
            got = [float(x) for x in out[("NUM", nm)].split(",")]
            assert got == pytest.approx(stored[nm]), (
                f"{nm}: .mm_num gave {got}, the tool stores {stored[nm]}")

        # And the label must be the respondent's OWN answer, not its opposite:
        # row 1 answered "Never" (forward 1), which reverse-scores to 5.
        assert out[("LAB", "item")].split(",")[0] == "Never", out[("LAB", "item")]
