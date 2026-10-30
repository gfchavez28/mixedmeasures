"""#1320 — the withdrawal CENSUS: plant a sentinel everywhere a person's data can
sit, withdraw them, and look in EVERY text column and EVERY export.

## Why a census and not a list

The filed defect (DI-03) was a hand-written sweep: `apply_withdrawal` reached the
places someone had thought of, and a merged turn, a canvas quote, a snapshot, an
audit entry's details and a stale computed result kept the person's words — on the
one feature whose purpose is that they are gone. A second hand-written list would
be the same defect waiting for the next column. So this file pins RELATIONSHIPS,
not places (#515/#676):

- (a) **Positive control.** Every sentinel is present before the withdrawal — in
  the database and in every export exercised — or the after-scan certifies nothing.
- (b) **Every String/Text/JSON column in `Base.metadata`** is scanned after, row by
  row. The only survivors allowed are the classified by-design ones.
- (c) **Every export** the census exercises is clean afterwards.
- (d) **Population: every text column is CLASSIFIED** (person / researcher /
  structural) or this file fails with instructions; a person column is either
  planted by the fixture or carries a stated residual. Falsifier: a synthetic
  `Table` is reported.
- (e) **Every download route is walked from `app.routes`**, with a floor, and is
  either exercised here or excluded with a reason.

Plus: the report agrees with what the withdrawal did, and a reused id does not
rebind a scrubbed embed or inbox item (#1192).

⚠️ The fixture is built through the real endpoints wherever an endpoint writes an
audit entry or a derived copy, because those copies are what leaked. The backup the
endpoint takes first is stubbed: the census is about the project, and a backup is
a whole-install copy disclosed rather than edited (D12).
"""

from __future__ import annotations

import io
import json
import zipfile
from types import SimpleNamespace

import openpyxl
import pytest
from fastapi.routing import APIRoute
from sqlalchemy import JSON, Column, Integer, MetaData, String, Table, Text, select, text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.canvas import CanvasPendingItem, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.metric import MetricDefinition
from app.models.note import Note
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.routers import participants as participants_router
from app.services.audit import log_action
from app.services.metrics import compute_metric
from app.services.withdrawal_redaction import (
    AUDIT_REDACTION_MARK,
    BLANKED_SEGMENT_TEXT,
    apply_withdrawal,
    combined_speaker_name,
)

#: The withdrawn person's sentinels. Each is planted somewhere a person's data can
#: sit; every one must be gone afterwards (apart from the classified survivors).
IDENTIFIER = "WDR0007"
SENTINELS = (
    "ALPHA",      # a solo turn, quoted on the canvas
    "BRAVO",      # a turn merged with another speaker's; quoted, in the inbox, noted
    "CHARLIE",    # a turn's wording before an edit (the edit's audit entry)
    "DELTA",      # the same turn after the edit
    "ECHO",       # a survey answer before an edit (the edit's audit entry)
    "FOXTROT",    # the same answer after the edit
    "GOLFJOB",    # a unique category answer — in a computed result and a group label
    "HOTEL",      # a turn merged AFTER a speakerless one: the result has NO speaker
    "INDIA",      # a turn merged with another's, then the merge result SPLIT
    "JULIET",     # a quote deleted BEFORE the withdrawal, whose canvas embed stayed
    "KILO",       # a survey answer quoted on the canvas
    "LIMA",       # a turn merged and unmerged (leaves an orphan combined speaker)
    "MIKE",       # a survey answer whose quote was deleted BEFORE, its embed kept (#1473)
    "NOVEMBER",   # an audit entry of an action no list would name
    "Zelenka",    # their name — speaker name, labels, combined speakers
    "ROLESENT",   # their role
    "DEMOSENT",   # their demographics
    IDENTIFIER,   # their identifier — record, dataset row
)
#: Other people's words. They must SURVIVE: a withdrawal that removes too much
#: damages someone else's record to honour this person's request.
#: OTHERSAID stands for their name in someone else's turn — kept by design (the
#: confirm says so); SAMWORDS is the other speaker's half of a merged turn, whose
#: hidden original Unmerge brings back (D7); SAMQUOTE is someone else's quote.
OTHERS = ("OTHERSAID", "SAMWORDS", "SAMQUOTE")


# ── (d) the classification ──────────────────────────────────────────────────

PERSON = "person"            # holds a participant's own words or identity
RESEARCHER = "researcher"    # written by the researcher: out of scope by design
STRUCTURAL = "structural"    # ids, enums, formats, configuration, install state

#: Every String / Text / JSON column of the schema, and what it holds. A new one
#: fails `test_every_text_column_is_classified` until it is decided here.
COLUMN_CLASS: dict[str, str] = {
    "analysis_domain_members.member_type": STRUCTURAL,
    "analysis_domain_members.origin": STRUCTURAL,
    "analysis_domain_members.origin_context": STRUCTURAL,
    "analysis_domains.name": RESEARCHER,
    "analysis_domains.description": RESEARCHER,
    "analysis_domains.color": STRUCTURAL,
    "analysis_domains.origin": STRUCTURAL,
    "analysis_domains.origin_context": STRUCTURAL,
    "audit_entries.action": STRUCTURAL,
    "audit_entries.entity_type": STRUCTURAL,
    "audit_entries.details": PERSON,
    "canvas_pending_items.item_type": STRUCTURAL,
    "canvas_snapshots.name": RESEARCHER,
    "canvas_snapshots.snapshot_data": PERSON,
    "canvas_theme_relationships.relationship_type": STRUCTURAL,
    "canvas_theme_relationships.label": RESEARCHER,
    "canvas_theme_relationships.line_style": STRUCTURAL,
    "canvas_theme_relationships.line_color": STRUCTURAL,
    "canvas_themes.name": RESEARCHER,
    "canvas_themes.section_type": STRUCTURAL,
    "canvas_themes.description": RESEARCHER,
    "canvas_themes.color": STRUCTURAL,
    "canvas_themes.content": PERSON,
    "canvas_themes.searchable_text": PERSON,
    "canvas_themes.referenced_source_ids": STRUCTURAL,
    "canvases.name": RESEARCHER,
    "canvases.introduction": RESEARCHER,
    "code_applications.attribution": RESEARCHER,
    "code_applications.origin": STRUCTURAL,
    "code_applications.origin_context": STRUCTURAL,
    "code_categories.name": RESEARCHER,
    "code_categories.color": STRUCTURAL,
    "code_categories.uuid": STRUCTURAL,
    "code_equivalence_groups.uuid": STRUCTURAL,
    "code_equivalence_groups.label": RESEARCHER,
    "code_equivalence_groups.description": RESEARCHER,
    "code_equivalence_groups.origin": STRUCTURAL,
    "code_equivalence_groups.origin_context": STRUCTURAL,
    "code_sets.uuid": STRUCTURAL,
    "code_sets.label": RESEARCHER,
    "code_sets.description": RESEARCHER,
    "codes.name": RESEARCHER,
    "codes.description": RESEARCHER,
    "codes.color": STRUCTURAL,
    "codes.uuid": STRUCTURAL,
    "codes.magnitude_labels": RESEARCHER,
    "computed_results.group_value": PERSON,
    "computed_results.result_data": PERSON,
    "conversations.name": RESEARCHER,
    "conversations.subject_id": PERSON,
    "conversations.status": STRUCTURAL,
    "conversations.summary": RESEARCHER,
    "conversations.uuid": STRUCTURAL,
    "conversations.media_filename": RESEARCHER,
    "conversations.media_format": STRUCTURAL,
    "conversations.media_type": STRUCTURAL,
    "dataset_columns.column_code": RESEARCHER,
    "dataset_columns.group_code": RESEARCHER,
    "dataset_columns.group_label": RESEARCHER,
    "dataset_columns.column_name": RESEARCHER,
    "dataset_columns.column_text": RESEARCHER,
    "dataset_columns.column_type": STRUCTURAL,
    "dataset_columns.scale_labels": RESEARCHER,
    "dataset_columns.scale_values": STRUCTURAL,
    "dataset_columns.numeric_format": STRUCTURAL,
    "dataset_columns.missing_values": RESEARCHER,
    "dataset_columns.source": STRUCTURAL,
    "dataset_columns.expression": RESEARCHER,
    "dataset_columns.depends_on_column_ids": STRUCTURAL,
    "dataset_columns.derived_via": STRUCTURAL,
    "dataset_columns.managed_spec": STRUCTURAL,
    "dataset_columns.demographic_subtype": STRUCTURAL,
    "dataset_columns.uuid": STRUCTURAL,
    "dataset_rows.row_identifier": PERSON,
    "dataset_rows.import_batch": STRUCTURAL,
    "dataset_rows.uuid": STRUCTURAL,
    "dataset_values.value_text": PERSON,
    "datasets.name": RESEARCHER,
    "datasets.description": RESEARCHER,
    "datasets.source": RESEARCHER,
    "datasets.rater_group": RESEARCHER,
    "datasets.import_config": STRUCTURAL,
    "datasets.color": STRUCTURAL,
    "datasets.managed_kind": STRUCTURAL,
    "datasets.uuid": STRUCTURAL,
    "documents.name": RESEARCHER,
    "documents.description": RESEARCHER,
    "documents.source_filename": RESEARCHER,
    "documents.source_format": STRUCTURAL,
    "documents.segmentation_mode": STRUCTURAL,
    "documents.summary": RESEARCHER,
    "documents.uuid": STRUCTURAL,
    "equivalence_groups.label": RESEARCHER,
    "equivalence_groups.description": RESEARCHER,
    "equivalence_groups.origin": STRUCTURAL,
    "equivalence_groups.origin_context": STRUCTURAL,
    "excerpt.uuid": STRUCTURAL,
    "material_collections.name": RESEARCHER,
    "materials.material_type": STRUCTURAL,
    "materials.config": STRUCTURAL,
    "materials.auto_name": RESEARCHER,
    "materials.custom_name": RESEARCHER,
    "materials.source_tab": STRUCTURAL,
    "memos.entity_type": STRUCTURAL,
    "memos.title": RESEARCHER,
    "memos.content": RESEARCHER,
    "memos.uuid": STRUCTURAL,
    "metric_definitions.name": RESEARCHER,
    "metric_definitions.description": RESEARCHER,
    "metric_definitions.metric_type": STRUCTURAL,
    "metric_definitions.config": STRUCTURAL,
    "metric_definitions.input_source_type": STRUCTURAL,
    "metric_definitions.grouping_mode": STRUCTURAL,
    "metric_definitions.exclude_values": PERSON,
    "metric_definitions.origin": STRUCTURAL,
    "metric_definitions.origin_context": STRUCTURAL,
    "notes.content": RESEARCHER,
    "notes.uuid": STRUCTURAL,
    "observations.name": RESEARCHER,
    "observations.description": RESEARCHER,
    "observations.uuid": STRUCTURAL,
    "observations.media_filename": RESEARCHER,
    "observations.media_format": STRUCTURAL,
    "observations.media_type": STRUCTURAL,
    "participants.identifier": PERSON,
    "participants.display_name": PERSON,
    "participants.role": PERSON,
    "participants.demographics": PERSON,
    "participants.role_auto_filled_from": PERSON,
    "participants.uuid": STRUCTURAL,
    # #1190 — ids and a one-way hash, kept ON PURPOSE after a withdrawal: they are
    # what stops a merge, an import or a link bringing the person back.
    "removal_tombstones.project_uuid": STRUCTURAL,
    "removal_tombstones.entity_type": STRUCTURAL,
    "removal_tombstones.entity_uuid": STRUCTURAL,
    "removal_tombstones.identifier_hash": STRUCTURAL,
    "removal_tombstones.reason": STRUCTURAL,
    "projects.name": RESEARCHER,
    "projects.description": RESEARCHER,
    "projects.status": STRUCTURAL,
    "projects.category_level_names": RESEARCHER,
    "projects.project_uuid": STRUCTURAL,
    "quote_board_configs.custom_orders": STRUCTURAL,
    "recode_definitions.name": RESEARCHER,
    "recode_definitions.recode_type": STRUCTURAL,
    "recode_definitions.output_type": STRUCTURAL,
    "recode_definitions.mapping": PERSON,
    "recode_definitions.ranges": RESEARCHER,
    "recode_definitions.exclude_values": PERSON,
    "scratchpad_entries.content": RESEARCHER,
    "scratchpad_entries.context_hint": RESEARCHER,
    "scratchpad_entries.resolved_into_type": STRUCTURAL,
    "segment_groups.uuid": STRUCTURAL,
    "segments.text": PERSON,
    "segments.original_speaker_label": PERSON,
    "segments.uuid": STRUCTURAL,
    "sessions.id": STRUCTURAL,
    "sessions.csrf_token": STRUCTURAL,
    "speakers.name": PERSON,
    "speakers.original_label": PERSON,
    "speakers.color": STRUCTURAL,
    "speakers.uuid": STRUCTURAL,
    "statistical_tests.test_type": STRUCTURAL,
    "statistical_tests.config": STRUCTURAL,
    "statistical_tests.target_type": STRUCTURAL,
    "statistical_tests.result_data": PERSON,
    "statistical_tests.origin": STRUCTURAL,
    "statistical_tests.origin_context": STRUCTURAL,
    "text_coding_configs.view_mode": STRUCTURAL,
    "text_coding_configs.focal_column_ids": STRUCTURAL,
    "text_coding_configs.dataset_filter_ids": STRUCTURAL,
    "text_coding_configs.context_visibility": STRUCTURAL,
    "text_coding_configs.starred_value_ids": STRUCTURAL,
    "text_coding_configs.treat_as_empty": RESEARCHER,
    "users.username": STRUCTURAL,
    "users.password_hash": STRUCTURAL,
    "users.display_color": STRUCTURAL,
    "users.coder_type": STRUCTURAL,
    "users.machine_provenance": STRUCTURAL,
    "users.uuid": STRUCTURAL,  # #1352 — a coder's identity, minted by the app
}

#: PERSON columns the withdrawal deliberately does NOT reach, and why. Every other
#: PERSON column must be planted by the fixture (asserted), so the after-scan
#: proves it clean.
PERSON_RESIDUAL: dict[str, str] = {
    "conversations.subject_id": (
        "a researcher-typed field that MAY hold an identifier; not linked to the "
        "participant, so not findable — review adjacent finding 12 (#1320's review)"
    ),
    "recode_definitions.mapping": (
        "a recode's keys are answer VALUES and can name a unique answer — adjacent "
        "finding 13, not in #1320's scope"
    ),
    "recode_definitions.exclude_values": "as recode_definitions.mapping (finding 13)",
    "metric_definitions.exclude_values": (
        "researcher-chosen category values to leave out; can name a unique answer "
        "(finding 13)"
    ),
    "statistical_tests.result_data": (
        "a saved test's group labels can be a unique answer (finding 13); the "
        "withdrawal marks the test stale, and its result is recomputed on view"
    ),
}


def text_columns(metadata: MetaData) -> set[str]:
    """Every String / Text / JSON column (Enum is a String) as `table.column`."""
    return {
        f"{t.name}.{c.name}"
        for t in metadata.tables.values()
        for c in t.columns
        if isinstance(c.type, (String, Text, JSON))
    }


def unclassified(metadata: MetaData) -> set[str]:
    return text_columns(metadata) - set(COLUMN_CLASS)


# ── The fixture: a study with the person everywhere, withdrawn over HTTP ────

def _found(blob: str) -> set[str]:
    return {s for s in SENTINELS + OTHERS if s in blob}


def _scan_db() -> tuple[dict[str, set[str]], dict]:
    """Every text column, row by row. The `withdrawn` entry is returned apart —
    it keeps the identifier by decision D9, and nothing else may."""
    hits: dict[str, set[str]] = {}
    kept_entry: dict = {}
    db = SessionLocal()
    try:
        for table in Base.metadata.sorted_tables:
            cols = [c for c in table.columns if isinstance(c.type, (String, Text, JSON))]
            if not cols:
                continue
            for row in db.execute(select(table)).mappings():
                if (
                    table.name == "audit_entries"
                    and row["action"] == "withdrawn"
                    and row["entity_type"] == "participant"
                ):
                    kept_entry = dict(row)
                    continue
                for c in cols:
                    value = row[c.name]
                    if value is None:
                        continue
                    blob = value if isinstance(value, str) else json.dumps(value)
                    found = _found(blob)
                    if found:
                        hits.setdefault(f"{table.name}.{c.name}", set()).update(found)
    finally:
        db.close()
    return hits, kept_entry


def _scan_xlsx(content: bytes) -> set[str]:
    """Cell by cell. A row of the Audit Trail whose action is `withdrawn` keeps
    the identifier (D9) and is checked apart."""
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    found: set[str] = set()
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            cells = [str(v) for v in row if v is not None]
            if "withdrawn" in cells:
                assert _found(" ".join(cells)) <= {IDENTIFIER}, cells
                continue
            found |= _found(" ".join(cells))
    return found


def _scan_zip(content: bytes) -> set[str]:
    found: set[str] = set()
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        for name in z.namelist():
            found |= _found(z.read(name).decode("utf-8", errors="ignore"))
    return found


def _scan_text(content: bytes) -> set[str]:
    return _found(content.decode("utf-8", errors="ignore"))


#: The exports the census exercises: name → (method, path template, scanner).
EXPORTS = {
    "study_excel": ("GET", "/api/projects/{pid}/export/excel", _scan_xlsx),
    "datasets_excel": ("GET", "/api/projects/{pid}/export/datasets-excel", _scan_xlsx),
    "study_csv": ("GET", "/api/projects/{pid}/export/csv", _scan_text),
    "coded_segments_csv": ("GET", "/api/projects/{pid}/export/coded-segments", _scan_text),
    "excerpts_csv": ("GET", "/api/projects/{pid}/excerpts/export", _scan_text),
    "r_data": ("GET", "/api/projects/{pid}/export/r-data", _scan_zip),
    "canvas_docx": ("POST", "/api/projects/{pid}/canvases/{canvas}/export-docx", _scan_zip),
    "mmproject": ("GET", "/api/projects/{pid}/export-project", _scan_zip),
    "code_frequencies_csv": ("GET", "/api/projects/{pid}/export/code-frequencies", _scan_text),
    "code_cooccurrence_csv": ("GET", "/api/projects/{pid}/export/code-cooccurrence", _scan_text),
    "codebook_csv": ("GET", "/api/projects/{pid}/export/codebook", _scan_text),
    "codebook_mmcodebook": ("GET", "/api/projects/{pid}/export-codebook", _scan_text),
}

#: Exports whose BEFORE run carries no sentinel by construction — they hold the
#: codebook or code counts, never a turn or an answer. Exercised anyway: after the
#: withdrawal they must still answer, and still carry none.
EXPORTS_WITHOUT_PERSON_DATA = {
    "code_frequencies_csv", "code_cooccurrence_csv", "codebook_csv", "codebook_mmcodebook",
}


def _export_all(client, headers, ids) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for name, (method, template, scan) in EXPORTS.items():
        url = template.format(pid=ids["pid"], canvas=ids["canvas"])
        resp = (client.post(url, json={}, headers=headers) if method == "POST"
                else client.get(url))
        assert resp.status_code == 200, (name, resp.status_code, resp.text[:300])
        out[name] = scan(resp.content)
    return out


@pytest.fixture(scope="module")
def census():
    Base.metadata.create_all(bind=engine)
    with pytest.MonkeyPatch.context() as mp, TestClient(app) as c:
        # The backup the endpoint takes first is stubbed (see the module docstring).
        mp.setattr(participants_router, "create_backup",
                   lambda *a, **k: SimpleNamespace(filename="pre_withdrawal_census.mmbackup"))
        status = c.get("/api/auth/status")
        assert status.status_code == 200, status.text
        H = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}

        def ok(resp):
            assert resp.status_code < 300, (
                resp.request.method, str(resp.request.url), resp.status_code, resp.text[:400])
            return resp.json() if resp.content else None

        pid = ok(c.post("/api/projects", json={"name": "Census"}, headers=H))["id"]
        maria = ok(c.post(f"/api/projects/{pid}/participants", json={
            "identifier": IDENTIFIER, "display_name": "Maria", "role": "ROLESENT",
            "demographics": json.dumps({"town": "DEMOSENT"}),
        }, headers=H))
        sam = ok(c.post(f"/api/projects/{pid}/participants",
                        json={"identifier": "P08", "display_name": "Sam"}, headers=H))
        mid, sid_ = maria["id"], sam["id"]

        db = SessionLocal()
        db.get(Participant, mid).role_auto_filled_from = f"Census survey · {IDENTIFIER}"
        conv = Conversation(project_id=pid, name="Focus group")
        db.add(conv); db.flush()
        cid = conv.id
        sp_m = Speaker(project_id=pid, name="Maria", original_label="SPEAKER_Zelenka",
                       participant_id=mid, color_index=1)
        sp_s = Speaker(project_id=pid, name="Sam", original_label="SPEAKER_02",
                       participant_id=sid_, color_index=2)
        sp_i = Speaker(project_id=pid, name="Interviewer", is_facilitator=1, color_index=3)
        db.add_all([sp_m, sp_s, sp_i]); db.flush()
        her = "Maria Zelenka"
        plan = [
            (sp_m, "ALPHA I have diabetes, said Maria.", her),               # 0
            (sp_s, "SAMQUOTE Sam talks first.", "Sam"),                      # 1
            (sp_m, "BRAVO my sister works at the clinic.", her),             # 2 ┐ merge
            (sp_s, "Sam responds here SAMWORDS.", "Sam"),                    # 3 ┘
            (sp_m, "CHARLIE original wording.", her),                        # 4 edited
            (sp_i, "Thank you OTHERSAID.", "Interviewer"),                   # 5
            (None, "An unattributed line.", None),                           # 6 ┐ merge,
            (sp_m, "HOTEL private words.", her),                             # 7 ┘ no speaker
            (sp_s, "Sam opens SAMWORDS.", "Sam"),                            # 8 ┐ merge,
            (sp_m, "INDIA first words here.", her),                          # 9 ┘ then split
            (sp_m, "JULIET orphan quote words.", her),                       # 10
            (sp_m, "LIMA words.", her),                                      # 11 ┐ merge,
            (sp_i, "Interviewer asks.", "Interviewer"),                      # 12 ┘ unmerge
        ]
        segs = []
        for i, (sp, words, label) in enumerate(plan):
            s = Segment(conversation_id=cid, speaker_id=sp.id if sp else None,
                        sequence_order=i, text=words, word_count=len(words.split()),
                        original_speaker_label=label)
            db.add(s); db.flush(); segs.append(s.id)
        # Coded turns reach the coded-segments CSV and the Coded Data sheet; the
        # code on turn 2 is carried onto the merge result.
        code = Code(project_id=pid, name="health", numeric_id=1)
        db.add(code); db.flush()
        user_id = status.json()["user"]["id"]
        db.add_all([CodeApplication(segment_id=segs[0], code_id=code.id, user_id=user_id),
                    CodeApplication(segment_id=segs[2], code_id=code.id, user_id=user_id),
                    CodeApplication(segment_id=segs[1], code_id=code.id, user_id=user_id)])
        db.flush()

        ds = Dataset(project_id=pid, name="Census survey"); db.add(ds); db.flush()
        q1 = DatasetColumn(dataset_id=ds.id, column_code="Q1", column_text="Q1", column_name="Q1",
                           column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0,
                           source="manual")
        q2 = DatasetColumn(dataset_id=ds.id, column_code="Q2", column_text="Q2", column_name="Q2",
                           column_type=ColumnType.OPEN_TEXT, sequence_order=1, display_order=1)
        job = DatasetColumn(dataset_id=ds.id, column_code="JOB", column_text="Job", column_name="Job",
                            column_type=ColumnType.NOMINAL, sequence_order=2, display_order=2)
        score = DatasetColumn(dataset_id=ds.id, column_code="SCORE", column_text="Score",
                              column_name="Score", column_type=ColumnType.NUMERIC,
                              sequence_order=3, display_order=3)
        q3 = DatasetColumn(dataset_id=ds.id, column_code="Q3", column_text="Q3", column_name="Q3",
                           column_type=ColumnType.OPEN_TEXT, sequence_order=4, display_order=4)
        db.add_all([q1, q2, job, score, q3]); db.flush()
        r_m = DatasetRow(dataset_id=ds.id, participant_id=mid, row_identifier=IDENTIFIER)
        r_s = DatasetRow(dataset_id=ds.id, participant_id=sid_, row_identifier="P08")
        db.add_all([r_m, r_s]); db.flush()
        v_q1 = DatasetValue(row_id=r_m.id, column_id=q1.id, value_text="ECHO answer")
        v_q2 = DatasetValue(row_id=r_m.id, column_id=q2.id, value_text="KILO thoughts")
        v_q3 = DatasetValue(row_id=r_m.id, column_id=q3.id, value_text="MIKE private answer")
        db.add_all([
            v_q1, v_q2, v_q3,
            DatasetValue(row_id=r_s.id, column_id=q1.id, value_text="Sam answer"),
            DatasetValue(row_id=r_m.id, column_id=job.id, value_text="GOLFJOB pilot"),
            DatasetValue(row_id=r_s.id, column_id=job.id, value_text="Nurse"),
            DatasetValue(row_id=r_m.id, column_id=score.id, value_text="12", value_numeric=12.0),
            DatasetValue(row_id=r_s.id, column_id=score.id, value_text="15", value_numeric=15.0),
        ])
        db.flush()
        # #1473 — a researcher's note and a coding on one of their ANSWERS: deleted
        # with it, so the confirm lists them as removed and the record counts them.
        db.add_all([
            Note(dataset_value_id=v_q2.id, content="Researcher note on an answer.",
                 sequence_number=1),
            CodeApplication(dataset_value_id=v_q2.id, code_id=code.id, user_id=user_id),
        ])
        db.flush()
        freq = MetricDefinition(project_id=pid, name="Job freq", metric_type="frequency_distribution",
                                config="{}", input_source_type="dataset_column",
                                input_source_id=job.id)
        grouped = MetricDefinition(project_id=pid, name="Score by job", metric_type="mean",
                                   config="{}", input_source_type="dataset_column",
                                   input_source_id=score.id, grouping_column_id=job.id)
        db.add_all([freq, grouped]); db.flush()
        compute_metric(db, freq)
        compute_metric(db, grouped)
        # Already stale BEFORE the withdrawal: the marker does not touch it, and
        # its stored result still names them (D10's reach must be measured).
        grouped.stale = True
        # An audit entry of an action no list would name, on one of their turns.
        log_action(db, action="census_annotated", entity_type="segment", entity_id=segs[0],
                   project_id=pid, details={"note": "NOVEMBER", "nested": {"k": ["NOVEMBER"]}})
        log_action(db, action="census_annotated", entity_type="dataset_row", entity_id=r_m.id,
                   project_id=pid, details={"record": IDENTIFIER})
        db.commit()
        ids = {"pid": pid, "cid": cid, "mid": mid, "segs": segs, "v_q1": v_q1.id,
               "v_q2": v_q2.id, "v_q3": v_q3.id, "ds": ds.id, "freq": freq.id, "grouped": grouped.id,
               "speaker": sp_m.id}
        db.close()

        seg_url = f"/api/conversations/{cid}/segments"
        ok(c.patch(f"/api/projects/{pid}/participants/{mid}",
                   json={"display_name": her}, headers=H))
        ok(c.patch(f"{seg_url}/{segs[0]}/speaker", json={"is_facilitator": False}, headers=H))
        ok(c.patch(f"{seg_url}/{segs[4]}", json={"text": "DELTA edited wording."}, headers=H))
        m1 = ok(c.post(f"{seg_url}/merge", json={"segment_ids": [segs[2], segs[3]]},
                       headers=H))["merged_segment"]["id"]
        m2 = ok(c.post(f"{seg_url}/merge", json={"segment_ids": [segs[6], segs[7]]},
                       headers=H))["merged_segment"]
        assert m2["speaker_id"] is None, "the fixture needs a merge result with no speaker"
        m3 = ok(c.post(f"{seg_url}/merge", json={"segment_ids": [segs[8], segs[9]]},
                       headers=H))["merged_segment"]
        # Split so their words land in the SECOND child: a split links only its
        # first child back (`split_into_id`), so this is what needs the siblings.
        cut = m3["text"].index("INDIA")
        children = ok(c.post(f"{seg_url}/split", json={"ranges": [
            {"segment_id": m3["id"], "start_offset": cut, "end_offset": len(m3["text"])}]},
            headers=H))["new_segments"]
        assert "INDIA" not in children[0]["text"] and "INDIA" in children[1]["text"]
        m4 = ok(c.post(f"{seg_url}/merge", json={"segment_ids": [segs[11], segs[12]]},
                       headers=H))["merged_segment"]["id"]
        ok(c.post(f"{seg_url}/{m4}/unmerge", headers=H))
        ok(c.patch(f"/api/projects/{pid}/datasets/{ids['ds']}/values/{ids['v_q1']}",
                   json={"value_text": "FOXTROT new answer"}, headers=H))

        ex = f"/api/projects/{pid}/excerpts"
        e1 = ok(c.post(ex, json={"segment_id": segs[0]}, headers=H))
        e2 = ok(c.post(ex, json={"segment_id": m1, "start_offset": 0, "end_offset": 36},
                       headers=H))
        e_sam = ok(c.post(ex, json={"segment_id": segs[1]}, headers=H))
        e_j = ok(c.post(ex, json={"segment_id": segs[10]}, headers=H))
        e_k = ok(c.post(ex, json={"dataset_value_id": ids["v_q2"]}, headers=H))
        e_m = ok(c.post(ex, json={"dataset_value_id": ids["v_q3"]}, headers=H))
        ok(c.post(f"/api/conversations/{cid}/notes",
                  json={"segment_id": m1, "content": "Researcher note on the merged turn."},
                  headers=H))

        canvas = ok(c.post(f"/api/projects/{pid}/canvases", json={"name": "Findings"},
                           headers=H))["id"]
        theme = ok(c.post(f"/api/projects/{pid}/canvases/{canvas}/themes",
                          json={"name": "Health"}, headers=H))["id"]

        def embed(e, conversation):
            return {"type": "excerpt-embed", "attrs": {
                "excerptId": e["id"], "displayText": e["excerpt_text"],
                "sourceContext": "Focus group", "conversationId": conversation}}

        ok(c.patch(f"/api/projects/{pid}/canvases/{canvas}/themes/{theme}", json={"content": {
            "type": "doc", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Prose by the researcher."}]},
                embed(e1, cid), embed(e2, cid), embed(e_sam, cid), embed(e_j, cid),
                embed(e_k, None), embed(e_m, None),
            ]}}, headers=H))
        ok(c.post(f"/api/projects/{pid}/canvases/{canvas}/pending-items",
                  json={"item_type": "excerpt", "source_id": e2["id"]}, headers=H))
        ok(c.post(f"/api/projects/{pid}/canvases/{canvas}/snapshots",
                  json={"name": "Before"}, headers=H))
        # D8 — the quote is deleted BEFORE the withdrawal; its embed stays. #1473 —
        # the same for a quote of an answer, whose embed names no conversation.
        ok(c.delete(f"{ex}/{e_j['id']}", headers=H))
        ok(c.delete(f"{ex}/{e_m['id']}", headers=H))
        ids.update(canvas=canvas, theme=theme, m1=m1, m2=m2["id"], m3=m3["id"],
                   children=[ch["id"] for ch in children], e_sam=e_sam["id"])

        report = ok(c.get(f"/api/projects/{pid}/participants/{mid}/withdrawal-report"))
        db_before, _ = _scan_db()
        exports_before = _export_all(c, H, ids)

        outcome = ok(c.post(f"/api/projects/{pid}/participants/{mid}/withdraw", headers=H))

        db_after, kept_entry = _scan_db()
        exports_after = _export_all(c, H, ids)
        canvas_after = ok(c.get(f"/api/projects/{pid}/canvases/{canvas}"))
        db = SessionLocal()
        speakers_after = sorted(n for (n,) in db.query(Speaker.name).filter(
            Speaker.project_id == pid))
        db.close()
        yield SimpleNamespace(
            ids=ids, report=report, outcome=outcome, db_before=db_before,
            db_after=db_after, kept_entry=kept_entry, exports_before=exports_before,
            exports_after=exports_after, canvas_after=canvas_after,
            speakers_after=speakers_after,
        )

    db = SessionLocal()
    try:
        for table in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    finally:
        db.close()
    Base.metadata.drop_all(bind=engine)


# ── (a) the positive control ─────────────────────────────────────────────────

class TestThePositiveControl:
    """Without these, every after-scan below passes by finding nothing."""

    def test_every_sentinel_is_planted_before(self, census):
        everywhere = set().union(*census.db_before.values())
        assert set(SENTINELS) <= everywhere, sorted(set(SENTINELS) - everywhere)

    def test_every_planted_person_column_holds_a_sentinel_before(self, census):
        planted = {c for c, k in COLUMN_CLASS.items() if k == PERSON} - set(PERSON_RESIDUAL)
        empty = sorted(c for c in planted if not (census.db_before.get(c, set()) & set(SENTINELS)))
        assert not empty, (
            f"{empty} are PERSON columns the census claims to plant, and no sentinel "
            "is in them before the withdrawal — so the after-scan proves nothing about "
            "them. Plant one in the fixture, or move the column to PERSON_RESIDUAL "
            "with the reason the withdrawal does not reach it."
        )

    def test_every_person_bearing_export_carries_sentinels_before(self, census):
        for name, found in census.exports_before.items():
            if name in EXPORTS_WITHOUT_PERSON_DATA:
                continue
            assert found & set(SENTINELS), f"{name} carried no sentinel before"


# ── (b) the database, every text column ─────────────────────────────────────

class TestTheDatabaseAfter:
    def test_no_sentinel_survives_in_any_text_column(self, census):
        leaks = {c: sorted(f & set(SENTINELS)) for c, f in census.db_after.items()
                 if f & set(SENTINELS)}
        assert not leaks, f"the withdrawal left their data in {leaks}"

    def test_the_withdrawn_entry_keeps_the_identifier_and_nothing_else(self, census):
        """D9: the record that the request was honoured names whom it was for."""
        details = census.kept_entry.get("details") or ""
        assert IDENTIFIER in details
        assert _found(details) == {IDENTIFIER}

    def test_everyone_elses_words_survive(self, census):
        """The other direction: OTHERSAID is their name said by someone else (kept,
        the confirm says so); SAMWORDS is the other speaker's hidden original of the
        merged turn (D7: Unmerge brings it back); SAMQUOTE is someone else's quote."""
        everywhere = set().union(*census.db_after.values())
        assert set(OTHERS) <= everywhere, sorted(set(OTHERS) - everywhere)

    def test_the_combined_speakers_are_renamed_and_the_orphan_is_gone(self, census):
        """Both merge orders are recomposed from their history; the "Maria Zelenka
        & Interviewer" row an Unmerge left with no turns is deleted."""
        assert census.speakers_after == [
            "Interviewer", "Sam", "Sam & Withdrawn participant 1",
            "Withdrawn participant 1", "Withdrawn participant 1 & Sam",
        ]

    def test_someone_elses_canvas_quote_is_untouched(self, census):
        content = json.dumps([t["content"] for t in census.canvas_after["themes"]])
        assert "SAMQUOTE" in content
        assert census.ids["e_sam"] in [
            n["attrs"]["excerptId"]
            for t in census.canvas_after["themes"] for n in t["content"]["content"]
            if n["type"] == "excerpt-embed"
        ]


# ── (c) every export ─────────────────────────────────────────────────────────

class TestEveryExportAfter:
    @pytest.mark.parametrize("name", sorted(EXPORTS))
    def test_the_export_is_clean(self, census, name):
        assert not (census.exports_after[name] & set(SENTINELS)), (
            name, sorted(census.exports_after[name] & set(SENTINELS)))


# ── (d) the population: every text column is classified ─────────────────────

class TestEveryTextColumnIsClassified:
    def test_the_walk_finds_the_schema(self):
        assert len(text_columns(Base.metadata)) >= 150, (
            "the text-column walk has gone blind — 172 existed when this was written"
        )

    def test_every_text_column_is_classified(self):
        missing = sorted(unclassified(Base.metadata))
        assert not missing, (
            f"{missing} hold text and no decision says whether a withdrawn "
            "participant's words can sit there. Add each to COLUMN_CLASS: PERSON "
            "(and then make the withdrawal reach it and plant a sentinel in the "
            "census, or give it a PERSON_RESIDUAL reason), RESEARCHER, or STRUCTURAL."
        )

    def test_no_classification_names_a_column_that_is_gone(self):
        stale = sorted(set(COLUMN_CLASS) - text_columns(Base.metadata))
        assert not stale, f"{stale} are classified but no longer exist"

    def test_a_residual_is_a_person_column(self):
        assert all(COLUMN_CLASS.get(c) == PERSON for c in PERSON_RESIDUAL)

    def test_the_check_reports_an_unknown_column(self):
        """Falsifier: a new text column on a new table IS reported."""
        md = MetaData()
        Table("synthetic_withdrawal_probe", md,
              Column("id", Integer, primary_key=True), Column("said", Text),
              Column("count", Integer))
        assert unclassified(md) == {"synthetic_withdrawal_probe.said"}


# ── (e) every download route, walked from the app ───────────────────────────

#: Download routes the census does NOT exercise, each with its reason.
EXPORT_ROUTES_EXCLUDED: dict[str, str] = {
    "GET /api/projects/{project_id}/export-ceiling": "a count of values, no content",
    "GET /api/projects/{project_id}/metrics/row-matrix/csv":
        "per-record scores of chosen metrics; their RowScores are deleted with their rows",
    "GET /api/projects/{project_id}/code-analysis/source-frequencies/csv":
        "code counts per source; no turn text",
    "GET /api/projects/{project_id}/code-analysis/demographic-comparison/csv":
        "code counts per demographic group (needs a grouping); no turn text",
    "GET /api/projects/{project_id}/text-coding/export":
        "the coded answers of a chosen column; their answers are deleted with their row",
    "GET /api/projects/{project_id}/text-analysis/export":
        "a chosen cross-analysis of answers; their answers are deleted with their row",
    "GET /api/projects/{project_id}/metrics/correlation-matrix/csv":
        "correlation coefficients of chosen metrics; numbers only",
    "GET /api/projects/{project_id}/metrics/scatter-data/csv":
        "paired values of chosen metrics; their rows are deleted",
    "GET /api/projects/{project_id}/metrics/group-comparison/csv":
        "a chosen comparison; its group labels are finding 13 (PERSON_RESIDUAL)",
    "GET /api/projects/{project_id}/data-quality/summary/csv":
        "missing-data counts per column; numbers only",
    "GET /api/projects/{project_id}/documents/{document_id}/original":
        "a document about them is unlinked and KEPT by design (row 46)",
    "GET /api/projects/{project_id}/documents/{document_id}/images/{image_index}":
        "a document's images; the document is kept by design (row 46)",
    "GET /api/backup/archives/{filename}":
        "a whole-install backup: disclosed, not edited (D12)",
    "GET /api/backup/safety-copies/{filename}":
        "a safety copy: disclosed, not edited (D12)",
    "POST /api/backup/create": "a new whole-install backup, taken after: holds what is left",
    "GET /api/projects/{project_id}/canvas-images/{image_id}": "a researcher's uploaded image",
}

EXERCISED_ROUTE_KEYS = {
    f"{method} {template.replace('{pid}', '{project_id}').replace('{canvas}', '{canvas_id}')}"
    for method, template, _ in EXPORTS.values()
}


def _download_routes() -> set[str]:
    import inspect
    found = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        # The single-page app's catch-all is not an export, and it EXISTS ONLY WHERE
        # `frontend/dist` has been built (`main.py` guards it on `dist_dir().exists()`),
        # so listing it as an exclusion made the census pass on a dev machine and fail
        # in CI's backend job, which has no build. Skipped by endpoint, not by path, so
        # any other route outside `/api` stays in the walk.
        if route.endpoint.__name__ == "spa_fallback":
            continue
        try:
            src = inspect.getsource(route.endpoint)
        except (OSError, TypeError):
            src = ""
        is_download = (
            "export" in route.path
            or any(s in src for s in ("Content-Disposition", "content_disposition(",
                                      "FileResponse", "StreamingResponse"))
        )
        if is_download:
            for method in route.methods:
                found.add(f"{method} {route.path}")
    return found


class TestEveryDownloadRouteIsDecided:
    def test_the_walk_finds_the_routes(self):
        assert len(_download_routes()) >= 25, "the download-route walk has gone blind"

    def test_every_download_route_is_exercised_or_excluded(self):
        undecided = sorted(_download_routes() - EXERCISED_ROUTE_KEYS - set(EXPORT_ROUTES_EXCLUDED))
        assert not undecided, (
            f"{undecided} send a file and the withdrawal census neither exercises them "
            "nor says why not. Add each to EXPORTS (it is then checked clean after a "
            "withdrawal) or to EXPORT_ROUTES_EXCLUDED with the reason."
        )

    def test_nothing_listed_is_gone(self):
        routes = _download_routes()
        assert EXERCISED_ROUTE_KEYS <= routes, sorted(EXERCISED_ROUTE_KEYS - routes)
        assert set(EXPORT_ROUTES_EXCLUDED) <= routes, sorted(set(EXPORT_ROUTES_EXCLUDED) - routes)


# ── The report agrees with the act ───────────────────────────────────────────

class TestTheReportMatchesTheOutcome:
    """#1320 — the report said 3 turns, 1 quote and 0 notes while the withdrawal
    left the merged turn, its quote and its note. Report = outcome, per kind."""

    def test_turns(self, census):
        convs = census.report["conversations"]
        assert sum(c["segments"] for c in convs) == census.outcome["segments_blanked"]

    def test_turns_reached_by_merge_or_split(self, census):
        convs = census.report["conversations"]
        # M1 (merged with Sam), M2 (no speaker), M3 (merged, then split) and its
        # two children — five turns their words reached only by history.
        assert sum(c["combined_turns"] for c in convs) == 5
        assert census.outcome["combined_turns_blanked"] == 5

    def test_quotes_notes_and_codes(self, census):
        convs = census.report["conversations"]
        # #1473 (c) — the confirm counts the quotes of their turns AND of their
        # answers ("N quotes taken from their data", `withdrawal-copy.ts::
        # removedSummary`), and the withdrawal deletes both. Each arm is held
        # non-zero, or the sum could agree by leaving one out.
        turn_quotes = sum(c["excerpts"] for c in convs)
        answer_quotes = sum(d["excerpts"] for d in census.report["datasets"])
        assert (turn_quotes, answer_quotes) == (2, 1)
        assert census.outcome["excerpts_deleted"] == turn_quotes + answer_quotes
        assert sum(c["notes"] for c in convs) == census.outcome["notes_for_review"] == 1
        assert (sum(c["code_applications"] for c in convs)
                == census.outcome["code_applications_kept"])

    def test_notes_and_codes_on_their_answers_are_counted_as_deleted(self, census):
        """#1473 — a note or a code on an ANSWER goes with it. The report (what the
        confirm lists as removed) and the record (the endpoint and the `withdrawn`
        entry) say the same number; neither is "kept" or "for review"."""
        sets = census.report["datasets"]
        notes = sum(d["notes"] for d in sets)
        codes = sum(d["code_applications"] for d in sets)
        assert (notes, codes) == (1, 1)
        record = json.loads(census.kept_entry["details"])
        for said in (census.outcome, record):
            assert (said["notes_deleted"], said["code_applications_deleted"]) == (notes, codes)


class TestWhatTheOutcomeRecords:
    def test_the_canvas_and_the_derived_copies(self, census):
        o = census.outcome
        # Theme: ALPHA, BRAVO, KILO by id; JULIET as an orphan (D8); MIKE as an
        # orphan of an answer (#1473). The snapshot holds the same five.
        assert o["canvas_embeds_scrubbed"] == 10
        assert o["canvas_snapshots_rewritten"] == 1
        # The live inbox item for BRAVO, and its copy in the snapshot.
        assert o["canvas_inbox_items_removed"] == 2
        assert o["computed_results_deleted"] >= 2
        assert o["audit_entries_redacted"] > 0

    def test_the_embed_reads_the_blanked_text_and_links_nowhere(self, census):
        embeds = [
            n["attrs"] for t in census.canvas_after["themes"]
            for n in t["content"]["content"] if n["type"] == "excerpt-embed"
        ]
        scrubbed = [a for a in embeds if a["displayText"] == BLANKED_SEGMENT_TEXT]
        assert len(scrubbed) == 5
        assert all(a["excerptId"] is None for a in scrubbed)
        assert census.canvas_after["pending_items"] == []

    def test_a_redacted_audit_entry_keeps_its_keys_and_numbers(self):
        """D9 — strings go, the trail stays: ids, counts and the keys survive."""
        from app.services.withdrawal_redaction import redacted_details
        out = json.loads(redacted_details(json.dumps(
            {"dataset_id": 4, "old_value": "ECHO", "nested": {"xs": ["a", 2]}})))
        assert out == {"dataset_id": 4, "old_value": None,
                       "nested": {"xs": [None, 2]}, "redacted": AUDIT_REDACTION_MARK}


# ── Service-level cases the HTTP census does not isolate ────────────────────

def _project(db):
    db.add(Project(id=1, name="P", user_id=1)); db.flush()
    conv = Conversation(id=1, project_id=1, name="C"); db.add(conv)
    db.add_all([Participant(id=1, project_id=1, identifier="W1", display_name="Wren"),
                Participant(id=2, project_id=1, identifier="O1", display_name="Ola")])
    db.flush()
    db.add_all([Speaker(id=1, project_id=1, name="Wren", participant_id=1),
                Speaker(id=2, project_id=1, name="Ola", participant_id=2)])
    db.flush()


class TestAReusedIdDoesNotRebind:
    """#1192's class — SQLite reuses the newest row's id, so an embed or inbox item
    left pointing at a deleted quote shows the NEXT quote given that id."""

    def test_neither_the_embed_nor_the_inbox_follows_the_id(self, db_session):
        from app.models.canvas import Canvas
        db = db_session
        _project(db)
        db.add_all([
            Segment(id=1, conversation_id=1, speaker_id=2, sequence_order=0, text="Ola speaks."),
            Segment(id=2, conversation_id=1, speaker_id=1, sequence_order=1, text="Wren's secret."),
        ])
        db.flush()
        theirs = Excerpt(project_id=1, segment_id=2); db.add(theirs); db.flush()
        canvas = Canvas(project_id=1, name="C"); db.add(canvas); db.flush()
        theme = CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps({
            "type": "doc", "content": [{"type": "excerpt-embed", "attrs": {
                "excerptId": theirs.id, "displayText": "Wren's secret.", "conversationId": 1}}]}))
        db.add(theme)
        db.add(CanvasPendingItem(canvas_id=canvas.id, item_type="excerpt", source_id=theirs.id))
        db.flush()
        reused_id = theirs.id

        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        db.expunge(theirs)  # deleted in bulk; the identity map still holds it
        newcomer = Excerpt(project_id=1, segment_id=1); db.add(newcomer); db.flush()
        assert newcomer.id == reused_id, "precondition: SQLite reused the id"

        db.expire_all()
        attrs = json.loads(db.get(CanvasTheme, theme.id).content)["content"][0]["attrs"]
        assert attrs["excerptId"] is None
        assert db.query(CanvasPendingItem).filter(
            CanvasPendingItem.source_id == reused_id).count() == 0


class TestTheOrphanRule:
    """D8 — an embed whose quote was deleted BEFORE the withdrawal is matched by
    their own words. A live quote of someone else's saying the same words is not."""

    def _canvas(self, db, *embeds):
        from app.models.canvas import Canvas
        canvas = Canvas(project_id=1, name="C"); db.add(canvas); db.flush()
        theme = CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps({
            "type": "doc", "content": [
                {"type": "excerpt-embed", "attrs": a} for a in embeds]}))
        db.add(theme); db.flush()
        return theme.id

    def test_someone_elses_live_quote_of_the_same_words_stays(self, db_session):
        db = db_session
        _project(db)
        db.add_all([
            Segment(id=1, conversation_id=1, speaker_id=2, sequence_order=0, text="I agree."),
            Segment(id=2, conversation_id=1, speaker_id=1, sequence_order=1,
                    text="Well, I agree."),
        ])
        db.flush()
        olas = Excerpt(project_id=1, segment_id=1); db.add(olas); db.flush()
        theme_id = self._canvas(
            db,
            {"excerptId": olas.id, "displayText": "I agree.", "conversationId": 1},
            {"excerptId": 999, "displayText": "Well, I agree.", "conversationId": 1},
        )
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        live, orphan = [n["attrs"] for n in
                        json.loads(db.get(CanvasTheme, theme_id).content)["content"]]
        assert live == {"excerptId": olas.id, "displayText": "I agree.", "conversationId": 1}
        assert orphan["displayText"] == BLANKED_SEGMENT_TEXT and orphan["excerptId"] is None

    def test_an_orphan_of_their_words_before_an_edit_is_found(self, db_session):
        """The quote was of the turn's EARLIER wording; the edit's audit entry is
        where those words still were."""
        db = db_session
        _project(db)
        db.add(Segment(id=2, conversation_id=1, speaker_id=1, sequence_order=0,
                       text="New wording."))
        db.flush()
        log_action(db, action="segment_updated", entity_type="segment", entity_id=2,
                   project_id=1, details={"old_text": "Old private wording.",
                                          "new_text": "New wording."})
        theme_id = self._canvas(
            db, {"excerptId": 77, "displayText": "Old private wording.", "conversationId": 1})
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        attrs = json.loads(db.get(CanvasTheme, theme_id).content)["content"][0]["attrs"]
        assert attrs["displayText"] == BLANKED_SEGMENT_TEXT


class TestTheOrphanRuleForAnswers:
    """#1473 (a) — an embed of an ANSWER whose quote was deleted BEFORE the
    withdrawal. Its `conversationId` is null, so D8's turn arm never saw it; it is
    matched by equality with a wording one of their answers held."""

    _canvas = TestTheOrphanRule._canvas

    def _answers(self, db, theirs: str, others: str):
        _project(db)
        db.add(Dataset(id=1, project_id=1, name="Survey")); db.flush()
        db.add(DatasetColumn(id=1, dataset_id=1, column_code="Q1", column_text="Q1",
                             column_name="Q1", column_type=ColumnType.OPEN_TEXT,
                             sequence_order=0, display_order=0))
        db.add_all([DatasetRow(id=1, dataset_id=1, participant_id=1),
                    DatasetRow(id=2, dataset_id=1, participant_id=2)])
        db.flush()
        db.add_all([DatasetValue(id=1, row_id=1, column_id=1, value_text=theirs),
                    DatasetValue(id=2, row_id=2, column_id=1, value_text=others)])
        db.flush()

    def _embeds_after(self, db, *embeds):
        theme_id = self._canvas(db, *embeds)
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        return [n["attrs"] for n in json.loads(db.get(CanvasTheme, theme_id).content)["content"]]

    def test_an_orphan_of_their_answer_is_found(self, db_session):
        db = db_session
        self._answers(db, "Wren's private answer.", "Ola's answer.")
        theirs, olas = self._embeds_after(
            db,
            {"excerptId": 77, "displayText": "Wren's private answer.", "conversationId": None},
            {"excerptId": 78, "displayText": "Ola's answer.", "conversationId": None},
        )
        assert theirs["displayText"] == BLANKED_SEGMENT_TEXT and theirs["excerptId"] is None
        assert olas == {"excerptId": 78, "displayText": "Ola's answer.", "conversationId": None}

    def test_an_orphan_of_their_answer_before_an_edit_is_found(self, db_session):
        """The quote was of the answer's EARLIER wording; the edit's audit entry
        (`value_updated`'s `old_value`) is where those words still were."""
        db = db_session
        self._answers(db, "New answer.", "Ola's answer.")
        log_action(db, action="value_updated", entity_type="dataset_value", entity_id=1,
                   project_id=1, details={"dataset_id": 1, "column_id": 1,
                                          "old_value": "Old private answer.",
                                          "new_value": "New answer."})
        (attrs,) = self._embeds_after(
            db, {"excerptId": 77, "displayText": "Old private answer.", "conversationId": None})
        assert attrs["displayText"] == BLANKED_SEGMENT_TEXT

    def test_an_answer_is_matched_whole_and_never_from_a_clip_or_a_live_quote(self, db_session):
        """Equality, not containment: someone else's deleted quote of a short answer
        ("No") inside one of theirs stays. A clip's text is a label, never theirs.
        A live quote of someone else's answer saying the same words stays."""
        db = db_session
        self._answers(db, "No, never again.", "No, never again.")
        olas = Excerpt(project_id=1, dataset_value_id=2); db.add(olas); db.flush()
        short, clip, live = self._embeds_after(
            db,
            {"excerptId": 90, "displayText": "No", "conversationId": None},
            {"excerptId": 91, "displayText": "No, never again.", "conversationId": None,
             "observationId": 5},
            {"excerptId": olas.id, "displayText": "No, never again.", "conversationId": None},
        )
        assert short["displayText"] == "No" and short["excerptId"] == 90
        assert clip["displayText"] == "No, never again." and clip["excerptId"] == 91
        assert live["displayText"] == "No, never again." and live["excerptId"] == olas.id


class TestAnEarlierWithdrawnEntryKeepsItsIdentifier:
    def test_a_reused_participant_id_does_not_strip_the_earlier_record(self, db_session):
        """SQLite reuses ids, so an EARLIER person's `withdrawn` entry can carry this
        participant's id. D9: that entry is the record a request was honoured."""
        from app.models.audit import AuditEntry
        db = db_session
        _project(db)
        earlier = log_action(db, action="withdrawn", entity_type="participant", entity_id=1,
                             project_id=1, details={"identifier": "EARLIER-01"})
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        assert "EARLIER-01" in db.get(AuditEntry, earlier.id).details


class TestTheCombinedSpeaker:
    def test_the_name_matches_the_merges_own(self, db_session):
        """`combined_speaker_name` restates `_build_combined_speaker`'s rule; a
        change to the merge's naming must fail here, not leave a recomposed name
        that no later merge finds."""
        from app.services.segment_operations import merge_segments
        db = db_session
        _project(db)
        db.add(Speaker(id=3, project_id=1, name="Kai"))
        db.flush()
        for i, sp in enumerate((1, 2, 3)):
            db.add(Segment(id=10 + i, conversation_id=1, speaker_id=sp, sequence_order=i,
                           text=f"t{i}"))
        db.flush()
        two, _ = merge_segments(db, [10, 11], "conversation", 1, 1, 1)
        assert two.speaker.name == combined_speaker_name(["Wren", "Ola"])
        three, _ = merge_segments(db, [two.id, 12], "conversation", 1, 1, 1)
        assert three.speaker.name == combined_speaker_name(["Wren & Ola", "Kai"])

    def test_a_merged_turn_is_renamed_from_its_history(self, db_session):
        from app.services.segment_operations import merge_segments
        db = db_session
        _project(db)
        db.add_all([
            Segment(id=1, conversation_id=1, speaker_id=1, sequence_order=0, text="Wren a."),
            Segment(id=2, conversation_id=1, speaker_id=2, sequence_order=1, text="Ola b."),
        ])
        db.flush()
        merged, _ = merge_segments(db, [1, 2], "conversation", 1, 1, 1)
        combined_id = merged.speaker_id
        out = apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        assert db.get(Segment, merged.id).speaker.name == "Withdrawn participant 1 & Ola"
        assert db.get(Segment, merged.id).speaker_id == combined_id, "renamed in place"
        assert out.combined_speakers_renamed == 1

    def test_a_split_across_two_turns_keeps_the_other_persons_own_piece(self, db_session):
        """A split across their turn and someone else's makes a 'before' child of
        theirs, a 'selected' child of both, and an 'after' child of the other
        person's words alone — which stays."""
        from app.schemas.segment import SegmentSplitRange
        from app.services.segment_operations import split_segment
        db = db_session
        _project(db)
        db.add_all([
            Segment(id=1, conversation_id=1, speaker_id=1, sequence_order=0,
                    text="Wren opens. Wren closes."),
            Segment(id=2, conversation_id=1, speaker_id=2, sequence_order=1,
                    text="Ola starts. Ola alone after."),
        ])
        db.flush()
        new, _ = split_segment(db, [
            SegmentSplitRange(segment_id=1, start_offset=12, end_offset=24),
            SegmentSplitRange(segment_id=2, start_offset=0, end_offset=11),
        ], "conversation", 1, 1, 1)
        after = [s.id for s in new if s.text == "Ola alone after."]
        selected = [s.id for s in new if "Wren closes." in s.text and "Ola starts." in s.text]
        assert after and selected, "precondition: the split made both children"
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush(); db.expire_all()
        assert db.get(Segment, after[0]).text == "Ola alone after."
        assert db.get(Segment, selected[0]).text == BLANKED_SEGMENT_TEXT


class TestItFailsClosed:
    def test_an_unreadable_canvas_section_rolls_the_withdrawal_back(self, db_session):
        from fastapi import HTTPException
        from app.models.canvas import Canvas
        from app.models.user import User
        db = db_session
        _project(db)
        db.add(Segment(id=1, conversation_id=1, speaker_id=1, sequence_order=0, text="Wren."))
        canvas = Canvas(project_id=1, name="C"); db.add(canvas); db.flush()
        db.add(CanvasTheme(canvas_id=canvas.id, name="Broken", content="{not json"))
        db.commit()
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(participants_router, "create_backup",
                       lambda *a, **k: SimpleNamespace(filename="pre_withdrawal_x.mmbackup"))
            with pytest.raises(HTTPException) as exc:
                participants_router.withdraw_participant(
                    1, 1, user=db.get(User, 1), db=db)
        assert exc.value.status_code == 500
        assert "nothing was changed" in exc.value.detail
        assert "Broken" in exc.value.detail
        assert "pre_withdrawal_x.mmbackup" in exc.value.detail
        db.expire_all()
        assert db.get(Participant, 1) is not None
        assert db.get(Segment, 1).text == "Wren."
