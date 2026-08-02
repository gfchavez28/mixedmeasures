"""Observations track — slab 4c: a coded clip reaches every analysis surface.

Per-surface inclusion tests (frequencies · co-occurrence, both levels ·
saturation steps · source-frequencies · Content · codebook tree) with correct
counts and ``obs_``-keyed identities, the frozen-consensus ``layer_scope``
rider, and the #616 export riders (document + clip rows with honest source
columns; conversation row values unchanged).

Fixture shape: one project with a conversation turn, a document paragraph, and
TWO observation clips — code X on all four targets, code Y co-applied on clip 1
only, so obs-only signals (the Y co-occurrence cell, clip 1's second chip) are
distinguishable from conv/doc contributions.
"""
import asyncio
import csv as csv_module
import io
from datetime import datetime

from app.models import (
    Project, Conversation, Document, Observation, Segment, Code,
    CodeApplication, User,
)
from app.auth import get_or_create_consensus_user
from app.services.consensus import materialize_consensus_for_project
from app.services.coding_layers import CONSENSUS_ORIGIN
from app.services.code_analysis import (
    get_code_frequencies,
    get_code_cooccurrence,
    get_source_level_cooccurrence,
    get_saturation_data,
    get_source_frequencies,
    get_segments_with_context,
)
from app.routers.codebook import get_codebook_tree
from app.routers.export import export_coded_segments_csv


def _run(coro):
    return asyncio.run(coro)


CODE_X = 8001
CODE_Y = 8002


def _seed(db, pid=800):
    """conv turn + doc para + 2 clips; X on all four, Y on clip 1 only."""
    db.add(Project(id=pid, name="P", user_id=1))
    db.flush()
    db.add_all([
        Conversation(id=pid, project_id=pid, name="Interview", created_at=datetime(2026, 7, 1)),
        Document(id=pid, project_id=pid, name="Field notes", source_filename="f.txt",
                 source_format="txt", created_at=datetime(2026, 7, 2)),
        Observation(id=pid, project_id=pid, name="Classroom", created_at=datetime(2026, 7, 3)),
        Code(id=CODE_X, project_id=pid, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=CODE_Y, project_id=pid, name="Y", numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        Segment(id=8010, conversation_id=pid, sequence_order=0, text="conv turn about bells"),
        Segment(id=8011, document_id=pid, conversation_id=None, sequence_order=0, text="doc para"),
        Segment(id=8012, observation_id=pid, conversation_id=None, sequence_order=0,
                start_time=10.0, end_time=25.5, text="Bell interruption"),
        Segment(id=8013, observation_id=pid, conversation_id=None, sequence_order=1,
                start_time=30.0, end_time=45.0, text="Group work"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=8010),
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=8011),
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=8012),
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=8013),
        CodeApplication(code_id=CODE_Y, user_id=1, segment_id=8012),  # co-occurs on clip 1
    ])
    db.flush()
    return pid


class TestFrequencies:
    def test_clips_fold_into_segment_count_and_observation_column(self, db_session):
        pid = _seed(db_session)
        result = get_code_frequencies(db_session, pid, source="all")
        x = next(f for f in result["frequencies"] if f["code_id"] == CODE_X)
        assert x["segment_count"] == 4, "conv + doc + 2 clips"
        assert x["observation_count"] == 1
        assert result["total_observations"] == 1
        assert result["total_coded_segments"] == 4

    def test_observation_ids_scoping(self, db_session):
        pid = _seed(db_session)
        # A foreign observation id: no clip contribution from this project's obs.
        result = get_code_frequencies(db_session, pid, source="all", observation_ids=[999999])
        x = next(f for f in result["frequencies"] if f["code_id"] == CODE_X)
        assert x["segment_count"] == 2, "conv + doc only when the obs filter excludes"
        assert x["observation_count"] == 0


class TestCooccurrence:
    def test_segment_level_includes_the_clip_pair(self, db_session):
        pid = _seed(db_session)
        result = get_code_cooccurrence(db_session, pid, source="all")
        ids = [c["id"] for c in result["codes"]]
        xi, yi = ids.index(CODE_X), ids.index(CODE_Y)
        # X–Y co-occur ONLY on clip 8012 — a matrix that drops clips reads 0 here.
        assert result["matrix"][xi][yi] == 1

    def test_source_level_keys_obs(self, db_session):
        pid = _seed(db_session)
        cooccur, total_units = get_source_level_cooccurrence(db_session, pid, source="all")
        # 3 segment-shaped sources engaged (conv, doc, obs) — obs carries X and Y.
        assert total_units == 3
        assert cooccur[(CODE_X, CODE_Y)] == 1, "the X-Y pairing exists only within obs_800"


class TestSaturation:
    def test_observation_is_a_step_and_contributes_new_codes(self, db_session):
        pid = _seed(db_session)
        result = get_saturation_data(db_session, pid)
        types = [p["source_type"] for p in result["points"]]
        assert types == ["conversation", "document", "observation"], "created_at interleave"
        obs_point = result["points"][2]
        # Y appears ONLY on a clip — the old 2-parent gather would show 0 new here.
        assert obs_point["new_codes_this_source"] == 1
        assert obs_point["new_code_names"] == ["Y"]
        assert result["total_unique_codes"] == 2


class TestSourceFrequencies:
    def test_observation_source_entry_and_totals(self, db_session):
        pid = _seed(db_session)
        result = get_source_frequencies(db_session, pid)
        obs_entries = [s for s in result["sources"] if s["source_type"] == "observation"]
        assert len(obs_entries) == 1
        entry = obs_entries[0]
        assert entry["source_id"] == pid and entry["source_label"] == "Classroom"
        assert entry["total_segments"] == 2  # two visible clips
        assert entry["coded_segments"] == 2
        assert entry["code_counts"][str(CODE_X)]["count"] == 2
        assert entry["groups"] is None, "no participant spine — the document posture"
        assert result["totals"]["total_observations"] == 1
        assert result["totals"]["total_segments"] >= 4

    def test_wire_carries_total_observations(self, db_session):
        """Pin the WIRE, not the schema (the splat trap): serialize through the
        response model exactly as the endpoint does."""
        from app.schemas.code_analysis import SourceFrequenciesResponse
        pid = _seed(db_session)
        result = get_source_frequencies(db_session, pid)
        wire = SourceFrequenciesResponse.model_validate(result).model_dump()
        assert wire["totals"]["total_observations"] == 1
        obs_srcs = [s for s in wire["sources"] if s["source_type"] == "observation"]
        assert len(obs_srcs) == 1


class TestContent:
    def test_observations_array_and_clip_inclusive_total(self, db_session):
        pid = _seed(db_session)
        result = get_segments_with_context(db_session, pid, code_id=CODE_X)
        assert result["total_segments"] == 4, "clip-inclusive total (D25)"
        assert len(result["observations"]) == 1
        group = result["observations"][0]
        assert group["observation_name"] == "Classroom"
        focal = group["segments"][0]
        assert focal["id"] == 8012
        assert focal["start_time"] == 10.0 and focal["end_time"] == 25.5, "timecode range"
        assert set(focal["applied_code_ids"]) == {CODE_X, CODE_Y}
        # Clip 2 is the following context (next clip by sequence_order).
        assert focal["following_context"][0]["id"] == 8013

    def test_wire_carries_observations(self, db_session):
        """The router declares CodeSegmentsWithContextResponse — serialize
        through it so a schema that drops the key fails HERE (the #586 shape)."""
        from app.schemas.code_analysis import CodeSegmentsWithContextResponse
        pid = _seed(db_session)
        result = get_segments_with_context(db_session, pid, code_id=CODE_X)
        wire = CodeSegmentsWithContextResponse.model_validate(result).model_dump()
        assert len(wire["observations"]) == 1
        assert wire["observations"][0]["segments"][0]["end_time"] == 25.5

    def test_clip_only_code_still_reaches_content(self, db_session):
        """#618 (found by the 4e live drive): an EMPTY conversation arm must not
        starve the doc/obs gathers — a clip-only code used to early-return an
        empty Content view while its frequency badge said 1 use (the D25
        split-brain). CODE_Y lives ONLY on clip 8012 — the degenerate fixture
        the 4c tests lacked (their code also sat on a conversation turn)."""
        pid = _seed(db_session)
        result = get_segments_with_context(db_session, pid, code_id=CODE_Y)
        assert result["conversations"] == []
        assert len(result["observations"]) == 1
        assert result["observations"][0]["segments"][0]["id"] == 8012
        assert result["total_segments"] == 1

    def test_document_only_code_still_reaches_content(self, db_session):
        """The #618 sibling — live since documents shipped (the early return
        predates the document arm entirely)."""
        pid = _seed(db_session)
        db_session.add(Code(id=8003, project_id=pid, name="DocOnly", numeric_id=3,
                            is_active=True, is_universal=False))
        db_session.flush()
        db_session.add(CodeApplication(code_id=8003, user_id=1, segment_id=8011))
        db_session.flush()
        result = get_segments_with_context(db_session, pid, code_id=8003)
        assert result["conversations"] == []
        assert len(result["documents"]) == 1
        assert result["documents"][0]["segments"][0]["id"] == 8011
        assert result["total_segments"] == 1


class TestCodebookTree:
    def test_clip_counts_and_obs_source_keys(self, db_session):
        pid = _seed(db_session)
        u = db_session.get(User, 1)
        # All Query-defaulted params passed explicitly — a Query() default leaks
        # its sentinel object into direct calls (backend/tests/CLAUDE.md).
        tree = _run(get_codebook_tree(
            pid, conversation_ids=None, text_column_ids=None,
            exclude_facilitator=True, include_inactive=False,
            min_segments=None, max_segments=None, layer_scope=None,
            user=u, db=db_session))
        x = next(c for c in tree.uncategorized_codes if c.id == CODE_X)
        assert x.segment_count == 4, "tree count now matches 'N uses' (8i.0.11)"
        assert x.source_count == 3
        assert f"obs:{pid}" in x.source_keys
        y = next(c for c in tree.uncategorized_codes if c.id == CODE_Y)
        assert y.segment_count == 1 and y.source_keys == [f"obs:{pid}"]


class TestFrozenConsensusLayerRider:
    def test_frozen_clip_consensus_renders_under_layer_scope(self, db_session):
        """A frozen observation's materialized consensus layer is selectable via
        layer_scope='consensus' on the new obs arms; conv/doc unchanged."""
        db = db_session
        pid = _seed(db)
        db.add(User(id=2, username="Coder B", password_hash=None, coder_type="human"))
        db.flush()
        # Second coder agrees on clip 8012; freeze → clips are consensus-eligible.
        db.add(CodeApplication(code_id=CODE_X, user_id=2, segment_id=8012))
        obs = db.get(Observation, pid)
        obs.segmentation_frozen_at = datetime(2026, 7, 17)
        db.flush()
        materialize_consensus_for_project(db, pid)
        db.flush()
        consensus_id = get_or_create_consensus_user(db).id
        assert db.query(CodeApplication).filter(
            CodeApplication.user_id == consensus_id,
            CodeApplication.origin == CONSENSUS_ORIGIN,
            CodeApplication.segment_id == 8012,
        ).count() == 1, "fixture sanity: the clip's consensus row exists"

        result = get_code_frequencies(db, pid, source="all", layer_scope="consensus")
        x = next(f for f in result["frequencies"] if f["code_id"] == CODE_X)
        # Only the clip carries consensus (single-coder everywhere else).
        assert x["segment_count"] == 1
        assert x["observation_count"] == 1

        # Human layer: the consensus row must NOT inflate (J2-B).
        human = get_code_frequencies(db, pid, source="all")
        hx = next(f for f in human["frequencies"] if f["code_id"] == CODE_X)
        assert hx["segment_count"] == 4


class Test616CodedSegmentsExport:
    def _rows(self, response):
        chunks = []
        body = response.body_iterator
        try:
            for ch in body:
                chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
        except TypeError:
            async def _drain():
                async for ch in body:
                    chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
            asyncio.run(_drain())
        return list(csv_module.reader(io.StringIO("".join(chunks))))

    def test_three_parents_with_honest_source_columns(self, db_session):
        pid = _seed(db_session)
        u = db_session.get(User, 1)
        resp = _run(export_coded_segments_csv(pid, user=u, db=db_session))
        rows = self._rows(resp)
        header = rows[0]
        assert "Source Type" in header and "Source" in header
        kind_i = header.index("Source Type")
        name_i = header.index("Source")
        kinds = {r[kind_i] for r in rows[1:]}
        assert kinds == {"conversation", "document", "observation"}, \
            "#616: document + clip rows present, not silently absent"

        by_kind = {r[kind_i]: r for r in rows[1:]}
        assert by_kind["document"][name_i] == "Field notes"
        assert by_kind["observation"][name_i] == "Classroom"
        # Conversation row values unchanged: name, speakerless blanks, text.
        conv = by_kind["conversation"]
        assert conv[name_i] == "Interview"
        assert conv[header.index("Segment Text")] == "conv turn about bells"
        # Clip row: timestamp = the clip's start; speaker columns degrade blank.
        clip_rows = [r for r in rows[1:] if r[kind_i] == "observation"]
        assert any(r[header.index("Timestamp")] == "10.00" for r in clip_rows)
        for r in clip_rows:
            assert r[header.index("Speaker")] == ""

    def test_clip_rows_carry_an_end_timestamp_so_duration_is_derivable(self, db_session):
        """#623: a start with no end means a clip exports no DURATION.

        That is the whole point of exporting a timed unit — rate, airtime and
        bout-length analyses are all folds over (start, end), and until the timed
        analytics surfaces ship, this CSV is the honest way to compute them
        elsewhere. Conversation/document rows leave it blank as they do the start.
        """
        pid = _seed(db_session)
        u = db_session.get(User, 1)
        resp = _run(export_coded_segments_csv(pid, user=u, db=db_session))
        rows = self._rows(resp)
        header = rows[0]
        assert "End Timestamp" in header
        end_i, kind_i = header.index("End Timestamp"), header.index("Source Type")

        clip_rows = [r for r in rows[1:] if r[kind_i] == "observation"]
        assert clip_rows and all(r[end_i] for r in clip_rows), \
            "every clip row must carry its end time"
        # A real span, not a repeat of the start — the degenerate case would let a
        # zero-duration bug pass unnoticed.
        starts_and_ends = {(r[header.index("Timestamp")], r[end_i]) for r in clip_rows}
        assert any(s != e for s, e in starts_and_ends)

        assert all(
            r[end_i] == "" for r in rows[1:] if r[kind_i] in ("conversation", "document")
        )

    def test_source_name_is_csv_safe(self, db_session):
        db = db_session
        db.add(Project(id=801, name="P", user_id=1))
        db.flush()
        db.add_all([
            Observation(id=801, project_id=801, name="=EVIL()"),
            Code(id=8101, project_id=801, name="C", numeric_id=1, is_active=True, is_universal=False),
        ])
        db.flush()
        db.add(Segment(id=8110, observation_id=801, conversation_id=None,
                       sequence_order=0, start_time=0.0, end_time=1.0, text="clip"))
        db.flush()
        db.add(CodeApplication(code_id=8101, user_id=1, segment_id=8110))
        db.flush()
        u = db.get(User, 1)
        resp = _run(export_coded_segments_csv(801, user=u, db=db))
        rows = self._rows(resp)
        name_i = rows[0].index("Source")
        assert rows[1][name_i].startswith("'="), "formula prefix defanged (csv_safe)"


def _csv_rows(response):
    """Drain a StreamingResponse into parsed CSV rows."""
    chunks = []
    body = response.body_iterator
    try:
        for ch in body:
            chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
    except TypeError:
        async def _drain():
            async for ch in body:
                chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
        asyncio.run(_drain())
    return list(csv_module.reader(io.StringIO("".join(chunks))))


class Test650StudyCsvExport:
    """`/export/csv` — the WIDE segment × code matrix — spans all three parents.

    ⚠️ This export is NOT interchangeable with `/coded-segments` above, and the
    difference is the reason #650 was fixed rather than the endpoint retired:
    this one emits a row for EVERY segment, including uncoded ones, which is the
    denominator. `/coded-segments` is rooted at `CodeApplication` and structurally
    cannot represent an uncoded unit.
    """

    def test_three_parents_with_honest_source_columns(self, db_session):
        from app.routers.export import export_study_csv
        pid = _seed(db_session)
        u = db_session.get(User, 1)
        rows = _csv_rows(_run(export_study_csv(pid, user=u, db=db_session)))
        header = rows[0]

        assert "conversation_name" not in header, (
            "the single conversation column is gone — it could not name a "
            "document or a clip (#650)"
        )
        assert header[0] == "source_type" and header[1] == "source_name"

        kind_i = header.index("source_type")
        kinds = {r[kind_i] for r in rows[1:]}
        assert kinds == {"conversation", "document", "observation"}, \
            "#650: document paragraphs and observation clips are no longer absent"

        name_i = header.index("source_name")
        names = {r[kind_i]: r[name_i] for r in rows[1:]}
        assert names["document"] == "Field notes"
        assert names["observation"] == "Classroom"
        assert names["conversation"] == "Interview"

    def test_an_uncoded_segment_still_emits_a_row_of_zeros(self, db_session):
        """The property that makes this export worth keeping.

        Proportional claims ("18% of segments were coded X") need the uncoded
        units in the file. Rooting this query at CodeApplication — the obvious
        way to make it look like /coded-segments — would silently delete the
        denominator, and every count-based assertion elsewhere would still pass.
        """
        from app.routers.export import export_study_csv
        db = db_session
        pid = _seed(db)
        # A document paragraph nobody coded, plus an uncoded clip.
        db.add_all([
            Segment(id=8014, document_id=pid, conversation_id=None,
                    sequence_order=1, text="uncoded doc para"),
            Segment(id=8015, observation_id=pid, conversation_id=None,
                    sequence_order=2, start_time=50.0, end_time=60.0,
                    text="uncoded clip"),
        ])
        db.flush()

        u = db.get(User, 1)
        rows = _csv_rows(_run(export_study_csv(pid, user=u, db=db)))
        header = rows[0]
        seg_i = header.index("segment_id")
        code_cols = [i for i, h in enumerate(header) if h.startswith("code_")]
        assert code_cols, "the wide form must have per-code columns"

        by_seg = {r[seg_i]: r for r in rows[1:]}
        assert len(by_seg) == 6, "4 coded + 2 uncoded segments all present"

        for uncoded in ("8014", "8015"):
            assert uncoded in by_seg, f"segment {uncoded} is uncoded, not absent"
            assert all(by_seg[uncoded][i] == "0" for i in code_cols), \
                "an uncoded segment is a row of zeros — that IS the denominator"

        # And a coded one still reads 1 where it should.
        assert by_seg["8012"][code_cols[0]] == "1"

    def test_speaker_columns_go_blank_rather_than_zero_off_conversations(self, db_session):
        """A document paragraph is not "a non-facilitator" — the question does
        not apply. A 0 there would be tabulated as a real observation."""
        from app.routers.export import export_study_csv
        pid = _seed(db_session)
        u = db_session.get(User, 1)
        rows = _csv_rows(_run(export_study_csv(pid, user=u, db=db_session)))
        header = rows[0]
        kind_i = header.index("source_type")
        spk_i, fac_i = header.index("speaker"), header.index("is_facilitator")

        for r in rows[1:]:
            if r[kind_i] in ("document", "observation"):
                assert r[spk_i] == ""
                assert r[fac_i] == "", "blank, not 0 (#650)"
