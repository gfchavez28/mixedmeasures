"""Decision D slab 0 — the convertibility sweep reports what it claims to.

🔴 **Why this test exists at all.** The sweep's first run against the dev corpus
answered "no definition needs a repair path" — which is exactly the answer a
sweep gives when its walk resolves to nothing, its predicate never matches, or
its join silently drops every row (#729). A clean result is only evidence if the
scan can be shown to produce a DIRTY one, so every verdict is planted here and
watched to fire.

The database is built from the app's OWN metadata rather than hand-written
CREATE TABLEs, so the sweep is exercised against the real schema and a column
rename cannot leave this test passing against a shape that no longer exists.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
import sqlite3
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetValue
from app.models.recode import RecodeDefinition, RecodeType, OutputType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import sweep_recode_convertibility as sweep_mod  # noqa: E402


@pytest.fixture
def swept(tmp_path):
    """Build a corpus containing every verdict, then sweep it read-only."""
    db_path = tmp_path / "corpus.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    session.add(User(id=1, username="t", password_hash="x"))
    session.add(Project(id=1, name="Sweep Corpus", user_id=1))
    session.flush()
    ds = Dataset(id=1, project_id=1, name="Survey")
    session.add(ds)
    session.flush()

    rows = []
    for row_id in range(1, 6):
        from app.models.dataset import DatasetRow
        r = DatasetRow(id=row_id, dataset_id=1)
        session.add(r)
        rows.append(r)
    session.flush()

    def cells(column_id, texts):
        for i, t in enumerate(texts):
            session.add(DatasetValue(row_id=rows[i].id, column_id=column_id, value_text=t))

    # 1. bare-code column, keys parse → CONVERTIBLE
    session.add(DatasetColumn(id=10, dataset_id=1, column_name="Bare", column_text="Bare",
                              column_type="ordinal", sequence_order=1, display_order=1))
    # 2. labelled column, keys are labels → CONVERTIBLE
    session.add(DatasetColumn(id=11, dataset_id=1, column_name="Labelled", column_text="Labelled",
                              column_type="ordinal", sequence_order=2, display_order=2,
                              scale_labels=json.dumps(["Low", "High"]),
                              scale_values=json.dumps([1.0, 2.0])))
    # 3. code-less column (free text) → NOT-APPLICABLE, by design
    session.add(DatasetColumn(id=12, dataset_id=1, column_name="Free", column_text="Free",
                              column_type="nominal", sequence_order=3, display_order=3))
    # 4. a RELABELLED column whose old mapping matches nothing → DEAD.
    #    ⚠️ The first draft of this fixture made it a bare-code column with text
    #    cells, which the classifier correctly called CODE-LESS — modelling the
    #    wrong thing entirely. `apply_value_labels` WRITES scale metadata when it
    #    relabels, so a relabelled column is LABELLED and its pre-relabel
    #    mappings (still keyed on the old codes) are what go dead. That is #584's
    #    actual mechanism, and it is the case slab 0 exists to count.
    session.add(DatasetColumn(id=13, dataset_id=1, column_name="Relabelled", column_text="Relabelled",
                              column_type="ordinal", sequence_order=4, display_order=4,
                              scale_labels=json.dumps(["Agree", "Disagree"]),
                              scale_values=json.dumps([1.0, 2.0])))
    # 5. labelled column, mapping half-resolves → PARTIAL
    session.add(DatasetColumn(id=14, dataset_id=1, column_name="Half", column_text="Half",
                              column_type="ordinal", sequence_order=5, display_order=5,
                              scale_labels=json.dumps(["Yes"]), scale_values=json.dumps([1.0]))),
    # 6. column with NO stored values → UNJUDGEABLE (an artefact, not a finding)
    session.add(DatasetColumn(id=15, dataset_id=1, column_name="Empty", column_text="Empty",
                              column_type="ordinal", sequence_order=6, display_order=6))
    session.flush()

    cells(10, ["1", "2", "3"])
    cells(11, ["Low", "High"])
    cells(12, ["strongly agree", "it varies a lot"])
    cells(13, ["Agree", "Disagree"])      # relabelled out from under its mapping
    cells(14, ["Yes", "No"])
    session.flush()

    def defn(def_id, column_id, name, mapping, rtype=RecodeType.SCALE_MAP, excludes=None):
        session.add(RecodeDefinition(
            id=def_id, column_id=column_id, name=name, recode_type=rtype,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            exclude_values=json.dumps(excludes) if excludes else None,
            sequence_order=0,
        ))

    defn(1, 10, "bare keys", {"1": 5, "2": 4, "3": 3})
    defn(2, 11, "label keys", {"Low": 2, "High": 1})
    defn(3, 12, "free text", {"strongly agree": "Positive"}, RecodeType.CATEGORY_GROUP)
    defn(4, 13, "stale", {"1": 5, "2": 4})   # the codes the cells used to hold
    defn(5, 14, "half", {"Yes": 1, "Maybe": 2})
    defn(6, 15, "on an empty column", {"1": 1})
    # `exclude_values` is a PARALLEL list needing the same conversion — a
    # definition whose MAPPING converts cleanly can still strand its null set.
    defn(7, 10, "excludes stranded", {"1": 1}, excludes=["Prefer not to say"])
    session.commit()
    session.close()
    engine.dispose()

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield sweep_mod.sweep(conn)
    finally:
        conn.close()


def _verdict(result, def_name):
    for f in result["findings"]:
        if f["definition"] == def_name:
            return f["verdict"]
    return None


def test_the_sweep_actually_walked_the_corpus(swept):
    """#729's population self-check: a scan that found nothing passes by finding
    nothing, so assert it saw every definition before trusting any verdict."""
    assert swept["definitions"] == 7
    assert swept["columns_with_definitions"] == 6


def test_it_recognises_all_three_column_states(swept):
    classes = swept["column_classes"]
    assert classes[sweep_mod.COL_BARE_CODES] == 1
    assert classes[sweep_mod.COL_LABELLED] == 3
    # The class D deliberately does NOT convert — reported, never silently
    # folded in with the convertible ones.
    assert classes[sweep_mod.COL_CODE_LESS] == 1
    assert classes[sweep_mod.COL_EMPTY] == 1


def test_a_clean_mapping_is_convertible_and_raises_nothing(swept):
    counts = swept["per_project"]["Sweep Corpus"]
    assert counts[sweep_mod.V_CONVERTIBLE] >= 2
    # Convertible definitions are counted, not listed — the findings list is the
    # things that need a decision.
    assert _verdict(swept, "bare keys") is None
    assert _verdict(swept, "label keys") is None


def test_a_code_less_column_keeps_the_text_join_and_is_not_a_finding(swept):
    """§2 — a `category_group` over free text has no code to join on and no bug.
    Reporting it would make the migration look bigger than it is."""
    counts = swept["per_project"]["Sweep Corpus"]
    assert counts[sweep_mod.V_NOT_APPLICABLE] == 1
    assert _verdict(swept, "free text") is None


def test_a_dead_definition_is_reported_as_unconvertible(swept):
    """The answer slab 0 exists to get: a mapping matching no stored cell cannot
    be rewritten into codes, so the migration needs a manual-repair path."""
    assert _verdict(swept, "stale") == sweep_mod.V_DEAD


def test_a_half_resolving_mapping_is_reported_as_PARTIAL(swept):
    """The dangerous one: a migration would convert some keys and strand the
    rest, leaving a definition that is mostly-converted and silently wrong."""
    assert _verdict(swept, "half") == sweep_mod.V_PARTIAL
    finding = next(f for f in swept["findings"] if f["definition"] == "half")
    assert finding["unresolved_keys"] == ["Maybe"]


def test_an_empty_column_is_unjudgeable_rather_than_dead(swept):
    """A column with no stored values makes every definition look dead. That is
    an artefact of having no data, and calling it a finding would send someone
    repairing a mapping that is fine (`dead_definitions_for_column`'s guard)."""
    counts = swept["per_project"]["Sweep Corpus"]
    assert counts[sweep_mod.V_UNJUDGEABLE] == 1
    assert _verdict(swept, "on an empty column") is None


def test_stranded_exclude_values_are_reported_even_when_the_mapping_converts(swept):
    """⚠️ The named trap: `exclude_values` is a parallel list of TEXTS. Converting
    the mapping and forgetting it leaves the null set keyed on the old spelling —
    and the definition looks converted."""
    finding = next(f for f in swept["findings"] if f["definition"] == "excludes stranded")
    assert finding["verdict"] == sweep_mod.V_CONVERTIBLE
    assert finding["unresolved_excludes"] == ["Prefer not to say"]
