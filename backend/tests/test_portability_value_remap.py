"""#994 — the dataset-value remap is PARTIAL, and these are what make that safe.

`import_project` used to build `remap["dataset_values"]` for EVERY imported value:
3,633,552 entries on the GSS corpus, of which zero were read, because that project
codes no dataset cells. It now collects the ids something downstream will ask for
(`_referenced_dataset_value_ids`) and resolves only those.

🔴 **THE FAILURE THAT REPLACES THE MEMORY IS SILENT.** A consumer whose carrier is
not declared in `_VALUE_REF_FK_ENTITIES` / `_VALUE_REF_JSON_FIELDS` looks up an id
that was never resolved, gets `None`, and imports an excerpt, a note or a coding
pointing at nothing — with no error. So the population is GATED rather than
remembered: the scan below fails, with instructions, on a reader these do not
cover.

⚠️ **The filed entry said there were THREE readers and there are FOUR.** It missed
`text_coding_config.starred_value_ids` — the JSON-id class `backend-invariants.md`
§6 warns about, where an id inside a JSON column is invisible both to the
relational FK pass and to a grep for the FK's name. That is the exact shape this
scan exists to catch next time.
"""
import ast
import io
import json
import zipfile
from pathlib import Path

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.note import Note
from app.models.project import Project
from app.models.text_coding_config import TextCodingConfig
from app.services import project_portability as pp

MODULE = Path(pp.__file__)

# The four readers, each named by the SECTION it lives in. A fifth must be added
# here AND covered by the collector; the scan below checks the first and the
# round-trip test checks the second.
KNOWN_READERS = {
    "excerpts": "p. Excerpts",
    "code_applications": "q. CodeApplications",
    "notes": "r. Notes",
    "text_coding_config": "cc. TextCodingConfig (starred_value_ids)",
}


def _remap_reader_count() -> int:
    """How many call sites ask `remap` about `"dataset_values"`.

    Parsed rather than grepped: the module's own prose names the key a dozen
    times, and a guard that reads its documentation as code is #772's phantom
    class — which this repo has produced twice inside guards written to prevent it.
    """
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    count = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id not in ("_remap_id", "_remap_json_id_array"):
            continue
        for arg in node.args:
            if isinstance(arg, ast.Constant) and arg.value == "dataset_values":
                count += 1
                break
    return count


class TestEveryReaderOfTheValueRemapIsDeclared:
    def test_the_scan_can_see_the_calls_it_counts(self):
        """Population self-check (#730): a walk that resolves to nothing passes
        an `== expected` assertion whenever `expected` is empty too."""
        assert _remap_reader_count() > 0, (
            "the AST walk found no `_remap_id(remap, 'dataset_values', …)` calls at all — "
            "has the helper been renamed? A scan that sees nothing passes by finding nothing."
        )

    def test_the_predicate_would_fire_on_a_new_reader(self):
        """Falsifier: prove the matcher recognises the shape it is looking for."""
        planted = ast.parse('_remap_id(remap, "dataset_values", item.get("dataset_value_id"))')
        call = planted.body[0].value
        assert isinstance(call, ast.Call) and call.func.id == "_remap_id"
        assert any(
            isinstance(a, ast.Constant) and a.value == "dataset_values" for a in call.args
        )

    def test_no_reader_exists_that_the_collector_does_not_cover(self):
        assert _remap_reader_count() == len(KNOWN_READERS), (
            f"{MODULE.name} now has {_remap_reader_count()} readers of "
            f"remap['dataset_values'], and this guard knows {len(KNOWN_READERS)}:\n"
            f"  {json.dumps(KNOWN_READERS, indent=2)}\n"
            "🔴 The remap is PARTIAL (#994): it holds only the ids collected by "
            "`_referenced_dataset_value_ids` BEFORE the insert loop. A reader whose "
            "carrier is not declared in `_VALUE_REF_FK_ENTITIES` or "
            "`_VALUE_REF_JSON_FIELDS` silently resolves to None and imports a row "
            "pointing at nothing.\n"
            "Add the carrier to one of those tuples, add the reader here, and extend "
            "`TestEveryDeclaredCarrierSurvivesARoundTrip` so it is proven rather than "
            "assumed."
        )

    def test_the_collector_declares_the_carrier_for_every_known_reader(self):
        declared = set(pp._VALUE_REF_FK_ENTITIES) | {k for k, _ in pp._VALUE_REF_JSON_FIELDS}
        assert declared == set(KNOWN_READERS), (
            f"declared carriers {sorted(declared)} != known readers "
            f"{sorted(KNOWN_READERS)}"
        )


# ── The behavioural half: every declared carrier resolves after a round trip ──


def _seed_all_four_carriers(db):
    """A project whose dataset cell is referenced by ALL FOUR carriers at once.

    ⚠️ **One cell, four references, deliberately.** A fixture giving each carrier
    its own cell passes even if the collector drops three of the four sources —
    every cell would still be referenced by SOMETHING. Sharing one cell means the
    round trip proves the ids were collected, not merely that some were.

    ⚠️ **A SECOND, UNREFERENCED cell is the negative control.** Without it the
    test cannot tell "resolved the referenced ones" from "resolved everything",
    which is the behaviour being removed.
    """
    db.add(Project(id=700, name="Remap", user_id=1))
    db.flush()
    db.add(Dataset(id=700, project_id=700, name="ds"))
    db.flush()
    db.add(DatasetColumn(id=7001, dataset_id=700, column_code="q1", column_name="q1",
                         column_text="q1", column_type="open_text",
                         sequence_order=0, display_order=0))
    db.flush()
    db.add_all([DatasetRow(id=7010, dataset_id=700), DatasetRow(id=7011, dataset_id=700)])
    db.flush()
    db.add_all([
        DatasetValue(id=7100, row_id=7010, column_id=7001, value_text="referenced"),
        DatasetValue(id=7101, row_id=7011, column_id=7001, value_text="unreferenced"),
    ])
    db.flush()
    db.add(Conversation(id=700, project_id=700, name="c"))
    db.add(Code(id=7200, project_id=700, name="Theme", numeric_id=1,
                is_active=True, is_universal=False))
    db.flush()
    # (1) excerpt  (2) note  (3) code application  (4) starred_value_ids
    db.add(Excerpt(id=7300, project_id=700, dataset_value_id=7100))
    db.add(Note(id=7400, dataset_value_id=7100, content="n", sequence_number=1))
    db.add(CodeApplication(code_id=7200, user_id=1, dataset_value_id=7100))
    # A JSON STRING: the column is `Text` and the router `json.dumps` into it.
    db.add(TextCodingConfig(project_id=700, starred_value_ids=json.dumps([7100])))
    db.flush()
    return 700


def _roundtrip(db, tmp_path):
    docs = tmp_path / "docs"
    media = tmp_path / "media"
    docs.mkdir(exist_ok=True)
    media.mkdir(exist_ok=True)
    buf = pp.export_project(db, 700, docs, media, include_media=False)
    archive = tmp_path / "p.mmproject"
    archive.write_bytes(buf.getvalue())
    new_pid, _ = pp.import_project(db, archive, docs, media, user_id=1)
    db.flush()
    return new_pid


class TestEveryDeclaredCarrierSurvivesARoundTrip:
    def test_all_four_carriers_land_on_the_imported_cell(self, db_session, tmp_path):
        db = db_session
        _seed_all_four_carriers(db)
        new_pid = _roundtrip(db, tmp_path)

        imported_values = (
            db.query(DatasetValue)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .join(Dataset, DatasetRow.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_pid)
            .all()
        )
        by_text = {v.value_text: v.id for v in imported_values}
        assert set(by_text) == {"referenced", "unreferenced"}
        target = by_text["referenced"]

        excerpt = db.query(Excerpt).filter(
            Excerpt.dataset_value_id.in_([v.id for v in imported_values])
        ).one()
        assert excerpt.dataset_value_id == target, "the excerpt lost its cell"

        note = db.query(Note).filter(
            Note.dataset_value_id.in_([v.id for v in imported_values])
        ).one()
        assert note.dataset_value_id == target, "the note lost its cell"

        app = db.query(CodeApplication).join(Code).filter(
            Code.project_id == new_pid, CodeApplication.dataset_value_id.isnot(None)
        ).one()
        assert app.dataset_value_id == target, "the coding lost its cell"

        cfg = db.query(TextCodingConfig).filter(
            TextCodingConfig.project_id == new_pid
        ).one()
        assert json.loads(cfg.starred_value_ids) == [target], (
            "starred_value_ids did not remap — this is the FOURTH carrier, the one the "
            "filed entry missed, and it is a JSON array rather than an FK column"
        )

    def test_the_resolution_loop_skips_what_nothing_references(self):
        """🔴 **STRUCTURAL, and the reason is the finding.**

        A planted mutant that DELETED this guard — i.e. reverted the loop to
        resolving every value again — **passed all twelve behavioural tests.**
        That is correct and not a hole in them: an entry in the remap that nothing
        reads changes no imported row, so the partiality is a MEMORY property with
        no observable behaviour. It is the whole point of #994 (1,235.9 MB →
        100.9 MB on GSS) and it cannot be asserted by importing anything.

        So it is pinned in the only channel it lives in — the source — and the
        measurement is recorded beside the code. ⚠️ **Do not "upgrade" this to a
        behavioural assertion**: there is nothing to observe, and a test that
        appears to check it would be checking something else.
        """
        src = MODULE.read_text(encoding="utf-8")
        assert "if original_id not in referenced_value_ids:" in src, (
            "the resolution loop no longer skips unreferenced values — #994's entire "
            "saving is that loop body not running. A mutant deleting this line passes "
            "every behavioural test in this file; only this assertion fails."
        )

    def test_the_remap_is_partial_and_the_negative_control_proves_it(
        self, db_session, tmp_path, monkeypatch
    ):
        """The point of #994: an unreferenced value gets NO remap entry.

        Without this the suite cannot tell the new behaviour from the old one —
        every assertion above passes against a remap that still holds everything.
        """
        db = db_session
        _seed_all_four_carriers(db)
        captured: dict = {}
        real = pp._referenced_dataset_value_ids

        def _spy(data):
            result = real(data)
            captured["wanted"] = set(result)
            captured["values_in_file"] = sum(1 for _ in (data.get("dataset_values") or ()))
            return result

        monkeypatch.setattr(pp, "_referenced_dataset_value_ids", _spy)
        _roundtrip(db, tmp_path)

        assert captured["values_in_file"] == 2, "fixture must export both cells"
        assert captured["wanted"] == {7100}, (
            f"the collector should want ONLY the referenced cell; got {captured['wanted']}"
        )


class TestTheCollectorItself:
    def test_it_reads_all_four_carriers(self):
        wanted = pp._referenced_dataset_value_ids({
            "excerpts": [{"dataset_value_id": 1}],
            "notes": [{"dataset_value_id": 2}],
            "code_applications": [{"dataset_value_id": 3}, {"dataset_value_id": None}],
            "text_coding_config": {"starred_value_ids": json.dumps([4, 5])},
        })
        assert wanted == {1, 2, 3, 4, 5}

    def test_a_missing_or_empty_carrier_is_not_an_error(self):
        assert pp._referenced_dataset_value_ids({}) == set()
        assert pp._referenced_dataset_value_ids({
            "excerpts": [], "notes": None, "code_applications": [],
            "text_coding_config": None,
        }) == set()

    def test_a_segment_targeted_application_contributes_nothing(self):
        """`ck_code_application_exactly_one_target` — on a transcript-only project
        every application carries a NULL `dataset_value_id`, which is why the BES
        corpus collects zero ids from 1.4 M rows."""
        assert pp._referenced_dataset_value_ids({
            "code_applications": [{"segment_id": 9, "dataset_value_id": None}],
        }) == set()

    def test_the_json_field_is_read_as_a_STRING_not_a_list(self):
        """The archive carries `"[1]"`, and iterating that as a list yields
        CHARACTERS — not ints — so a list-shaped reader silently collects nothing
        and every starred cell keeps its SOURCE id (`_remap_json_id_array` falls
        back to the original when the remap misses). Found by running it."""
        assert pp._referenced_dataset_value_ids({
            "text_coding_config": {"starred_value_ids": "[11, 12]"},
        }) == {11, 12}
        assert pp._referenced_dataset_value_ids({
            "text_coding_config": {"starred_value_ids": "not json"},
        }) == set()

    def test_a_bool_is_not_an_id(self):
        """`isinstance(True, int)` is True in Python, and `json.dumps(True)` is
        `true` — the same trap `in_id_set` refuses for the same reason."""
        assert pp._referenced_dataset_value_ids({
            "excerpts": [{"dataset_value_id": True}],
        }) == set()


class TestTheArchiveEntryIsReadTwice:
    """#994 adds a pass over `code_applications`, and `_ArchiveRows` must survive it.

    🔴 A one-shot generator would yield the ids on the collector's pass and NOTHING
    on section q's — importing every dataset-cell coding with a null target, silently.
    That is the exact failure `_ArchiveRows`' docstring exists to prevent, and this
    change is the first to make the entry's SECOND reader a different function.
    """

    def test_code_applications_can_be_iterated_twice(self, tmp_path):
        payload = [{"_original_id": 1, "dataset_value_id": 5}]
        path = tmp_path / "a.zip"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("code_applications.jsonl",
                        "".join(json.dumps(r) + "\n" for r in payload))
        with zipfile.ZipFile(path) as zf:
            rows = pp._ArchiveRows(zf, "code_applications.jsonl")
            first = [r["dataset_value_id"] for r in rows]
            second = [r["dataset_value_id"] for r in rows]
        assert first == second == [5]
