"""Observations slab 5a — the time-range excerpt shape (D29/D32, plan §8j).

Direct async endpoint calls via ``asyncio.run`` (the _run pattern; ownership is
structurally guaranteed by test_ownership_gate_sweep.py). Covers:

  * the ExcerptCreate schema table — times both-or-neither, one-shape XOR,
    comment-excerpt refusals, ``start_time >= 0``, ``end_time >= start_time``
    with POINT quotes legal (D7 symmetry; the char shape stays strictly ``>``)
  * router shape rules — char offsets refused on clips, time ranges refused on
    conversation/document segments, create-time containment two-sided, and a
    FROZEN observation still accepts quotes (annotation stays legal, D22)
  * the §8j.0.2 predicate split — two DIFFERENT time excerpts coexist on one
    clip (the rewritten ix_excerpt_segment_whole fixture: under the pre-slab-5
    predicate the second insert dies), whole + time coexist in BOTH orders,
    and each shape 409s only its own duplicate
  * wire pins ON THE RESPONSE, never just the schema (the splat rule)
  * the quote flag goes shape-AGNOSTIC on display surfaces (Content
    ``is_quoted`` + the coded-segments CSV "Is Quoted") while a char-range-only
    conversation segment stays NOT quoted — two-sided (D32)
  * the excerpt CSV's Start Time / End Time / Duration columns + the
    "time-range" Type (a whole-clip row emits the CLIP's range — its label is
    often empty, so the range is the row's substance)
  * ``format_timecode`` — the Python mirror of lib/utils.ts::formatTimecode,
    including the JS half-up rounding pin (Python's bare round() is banker's)
"""
import asyncio
import csv as csv_module
import io
from datetime import datetime

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models import (
    Project, Observation, Conversation, Document, Segment, Code,
    CodeApplication, User,
)
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.routers.excerpts import (
    create_excerpt, export_excerpts_csv, get_excerpt, list_quoted_excerpts,
)
from app.routers.export import export_coded_segments_csv
from app.schemas.code_analysis import ObservationSegmentGroup
from app.schemas.excerpt import ExcerptCreate
from app.services.code_analysis import get_segments_with_context
from app.services.timestamp import format_timecode


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


def _stream_to_text(response):
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
    return "".join(chunks)


def _obs_with_clip(db, pid=900, oid=900, sid=9001, *, start=10.0, end=40.0,
                   duration=600.0, frozen=False, label="arrival"):
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Observation(
            id=oid, project_id=pid, name="Classroom",
            media_duration_seconds=duration,
            segmentation_frozen_at=datetime(2026, 7, 1) if frozen else None,
        ),
    ])
    db.flush()
    db.add(Segment(
        id=sid, observation_id=oid, conversation_id=None, document_id=None,
        sequence_order=0, start_time=start, end_time=end, text=label,
    ))
    db.flush()
    return pid, oid, sid


def _conv_with_segment(db, pid=910, cid=910, sid=9101, text="Hello transcript"):
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Conversation(id=cid, project_id=pid, name="Conv"),
    ])
    db.flush()
    db.add(Segment(id=sid, conversation_id=cid, sequence_order=0, text=text))
    db.flush()
    return pid, cid, sid


# ── Schema table (Pydantic — internal consistency) ──────────────────────────

class TestTimeShapeSchema:
    def test_times_both_or_neither(self):
        with pytest.raises(ValidationError, match="both be set or both be null"):
            ExcerptCreate(segment_id=1, start_time=1.0)
        with pytest.raises(ValidationError, match="both be set or both be null"):
            ExcerptCreate(segment_id=1, end_time=1.0)

    def test_one_shape_xor(self):
        with pytest.raises(ValidationError, match="one shape"):
            ExcerptCreate(segment_id=1, start_offset=0, end_offset=3,
                          start_time=1.0, end_time=2.0)

    def test_times_refused_on_comment_excerpts(self):
        with pytest.raises(ValidationError, match="not supported for comment"):
            ExcerptCreate(dataset_value_id=1, start_time=1.0, end_time=2.0)

    def test_negative_start_refused(self):
        with pytest.raises(ValidationError, match="start_time must be >= 0"):
            ExcerptCreate(segment_id=1, start_time=-0.5, end_time=2.0)

    def test_end_before_start_refused(self):
        with pytest.raises(ValidationError, match="end_time must be >= start_time"):
            ExcerptCreate(segment_id=1, start_time=5.0, end_time=4.9)

    def test_point_quote_legal(self):
        # `>=`, deliberately diverging from the char shape's strict `>` — a
        # point quote marks an instant (D7 symmetry with point-event clips).
        item = ExcerptCreate(segment_id=1, start_time=5.0, end_time=5.0)
        assert item.start_time == item.end_time == 5.0


# ── Router shape rules ──────────────────────────────────────────────────────

class TestTimeShapeRouterRules:
    def test_char_offsets_refused_on_clip(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(
                pid, ExcerptCreate(segment_id=sid, start_offset=0, end_offset=3),
                user=_user(db), db=db,
            ))
        assert exc.value.status_code == 400
        assert "time range" in exc.value.detail

    def test_time_range_refused_on_conversation_segment(self, db_session):
        db = db_session
        pid, cid, sid = _conv_with_segment(db)
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(
                pid, ExcerptCreate(segment_id=sid, start_time=1.0, end_time=2.0),
                user=_user(db), db=db,
            ))
        assert exc.value.status_code == 400
        assert "observation clips" in exc.value.detail

    def test_time_range_refused_on_document_segment(self, db_session):
        db = db_session
        db.add_all([
            Project(id=920, name="P", user_id=1),
            Document(id=920, project_id=920, name="Doc", source_filename="d.txt", source_format="txt"),
        ])
        db.flush()
        db.add(Segment(id=9201, document_id=920, sequence_order=0, text="para"))
        db.flush()
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(
                920, ExcerptCreate(segment_id=9201, start_time=1.0, end_time=2.0),
                user=_user(db), db=db,
            ))
        assert exc.value.status_code == 400

    @pytest.mark.parametrize("qstart,qend", [
        (9.5, 20.0),    # starts before the clip
        (20.0, 40.5),   # ends after the clip
    ])
    def test_containment_two_sided(self, db_session, qstart, qend):
        db = db_session
        pid, oid, sid = _obs_with_clip(db, start=10.0, end=40.0)
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(
                pid, ExcerptCreate(segment_id=sid, start_time=qstart, end_time=qend),
                user=_user(db), db=db,
            ))
        assert exc.value.status_code == 400
        assert "inside the clip" in exc.value.detail

    def test_frozen_observation_still_accepts_quotes(self, db_session):
        # D22: quotes are annotation, not segmentation — the freeze must not
        # refuse them.
        db = db_session
        pid, oid, sid = _obs_with_clip(db, frozen=True)
        resp = _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=15.0, end_time=25.0),
            user=_user(db), db=db,
        ))
        assert (resp.start_time, resp.end_time) == (15.0, 25.0)


# ── The §8j.0.2 predicate split — coexistence + per-shape dups ──────────────

class TestShapeCoexistence:
    def test_two_different_time_excerpts_coexist_on_one_clip(self, db_session):
        """THE index fixture: under the pre-slab-5 ix_excerpt_segment_whole
        predicate (`start_offset IS NULL` alone) the SECOND insert here trips
        whole-segment uniqueness. Mutation-verified by restoring the old
        predicate in models/excerpt.py."""
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=12.0, end_time=18.0),
            user=_user(db), db=db,
        ))
        resp2 = _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=20.0, end_time=30.0),
            user=_user(db), db=db,
        ))
        assert resp2.start_time == 20.0
        assert db.query(Excerpt).filter(Excerpt.segment_id == sid).count() == 2

    def test_whole_quote_does_not_block_time_quote(self, db_session):
        # The dup guard's whole arm must be shape-EXACT: a bare
        # `start_offset IS NULL` here would 409 the time create.
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        resp = _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=12.0, end_time=18.0),
            user=_user(db), db=db,
        ))
        assert resp.start_time == 12.0

    def test_time_quote_does_not_block_whole_quote(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=12.0, end_time=18.0),
            user=_user(db), db=db,
        ))
        resp = _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        assert resp.start_time is None and resp.start_offset is None

    def test_duplicate_time_range_409(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=12.0, end_time=18.0),
            user=_user(db), db=db,
        ))
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(
                pid, ExcerptCreate(segment_id=sid, start_time=12.0, end_time=18.0),
                user=_user(db), db=db,
            ))
        assert exc.value.status_code == 409

    def test_duplicate_whole_quote_still_409(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        with pytest.raises(HTTPException) as exc:
            _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        assert exc.value.status_code == 409


# ── Wire pins (the RESPONSE, not the schema — the splat rule) ───────────────

class TestTimeShapeWire:
    def test_create_response_carries_times_and_observation(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        resp = _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=15.0, end_time=25.0),
            user=_user(db), db=db,
        ))
        dumped = resp.model_dump()
        assert dumped["start_time"] == 15.0
        assert dumped["end_time"] == 25.0
        assert dumped["observation_id"] == oid
        assert dumped["observation_name"] == "Classroom"
        # A time excerpt's text is the clip LABEL — the range is its identity.
        assert dumped["excerpt_text"] == "arrival"

    def test_detail_response_inherits_the_fields(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        created = _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=15.0, end_time=25.0),
            user=_user(db), db=db,
        ))
        detail = _run(get_excerpt(pid, created.id, user=_user(db), db=db))
        assert (detail.start_time, detail.end_time) == (15.0, 25.0)
        assert detail.observation_name == "Classroom"

    def test_quoted_list_items_carry_times(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db)
        _run(create_excerpt(
            pid, ExcerptCreate(segment_id=sid, start_time=15.0, end_time=25.0),
            user=_user(db), db=db,
        ))
        resp = _run(list_quoted_excerpts(
            pid, source="all", code_ids=None, conversation_ids=None,
            document_ids=None, text_column_ids=None, exclude_facilitator=False,
            participant_ids=None, user=_user(db), db=db,
        ))
        assert resp.total_observation_excerpts == 1
        item = resp.excerpts[0]
        assert (item.start_time, item.end_time) == (15.0, 25.0)
        # is_sub_segment stays CHAR-only — never overloaded for the time shape
        # (the #569 type-overloading lesson).
        assert item.is_sub_segment is False


# ── Display quote flag: shape-agnostic; char-range stays excluded (D32) ─────

class TestQuoteFlagShapeAgnostic:
    def _coded_clip(self, db, pid=930, oid=930, sid=9301, code_id=9300):
        _obs_with_clip(db, pid=pid, oid=oid, sid=sid)
        db.add(Code(id=code_id, project_id=pid, name="C", numeric_id=1,
                    is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(segment_id=sid, code_id=code_id, user_id=1, origin="human"))
        db.flush()
        return pid, oid, sid, code_id

    def test_time_only_quoted_clip_reads_quoted_in_content(self, db_session):
        db = db_session
        pid, oid, sid, code_id = self._coded_clip(db)
        db.add(Excerpt(project_id=pid, segment_id=sid, start_time=15.0, end_time=25.0))
        db.flush()
        result = get_segments_with_context(db, pid, code_id, exclude_facilitator=False)
        group = result["observations"][0]
        assert group["segments"][0]["is_quoted"] is True
        # The occurrence-strip denominator rides the group (D31) — validated
        # through the response schema so Pydantic can't silently drop it.
        parsed = ObservationSegmentGroup(**group)
        assert parsed.media_duration_seconds == 600.0
        # The sub-clip quote's RANGE rides the same payload (slab 5c) — the
        # membership query already read these rows and used to discard them.
        # Asserted through the schema: an undeclared field is silently dropped.
        assert [(q.start_time, q.end_time) for q in parsed.segments[0].quote_ranges] == [(15.0, 25.0)]

    def test_whole_clip_quote_contributes_no_range(self, db_session):
        # A whole-clip quote IS the clip — it has no range of its own, and
        # inventing one would make the card claim a moment the researcher never
        # marked. `is_quoted` alone carries it.
        db = db_session
        pid, oid, sid, code_id = self._coded_clip(db, pid=931, oid=931, sid=9311, code_id=9310)
        db.add(Excerpt(project_id=pid, segment_id=sid))
        db.flush()
        result = get_segments_with_context(db, pid, code_id, exclude_facilitator=False)
        seg = result["observations"][0]["segments"][0]
        assert seg["is_quoted"] is True
        assert seg["quote_ranges"] == []

    def test_char_range_conversation_segment_stays_unquoted(self, db_session):
        # Two-sided: shape-agnostic means whole OR time — widening the flag to
        # char-range excerpts would silently change every conv/doc surface.
        db = db_session
        pid, cid, sid = _conv_with_segment(db, pid=940, cid=940, sid=9401)
        db.add(Code(id=9400, project_id=pid, name="C", numeric_id=1,
                    is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(segment_id=sid, code_id=9400, user_id=1, origin="human"))
        db.add(Excerpt(project_id=pid, segment_id=sid, start_offset=0, end_offset=5))
        db.flush()
        result = get_segments_with_context(db, pid, 9400, exclude_facilitator=False)
        assert result["conversations"][0]["segments"][0]["is_quoted"] is False

    def test_time_only_quoted_clip_reads_yes_in_coded_segments_csv(self, db_session):
        db = db_session
        pid, oid, sid, code_id = self._coded_clip(db, pid=950, oid=950, sid=9501, code_id=9500)
        db.add(Excerpt(project_id=pid, segment_id=sid, start_time=15.0, end_time=25.0))
        db.flush()
        text = _stream_to_text(_run(export_coded_segments_csv(
            project_id=pid, code_ids=None, exclude_facilitator=False,
            conversation_ids=None, participant_ids=None,
            user=_user(db), db=db,
        )))
        rows = list(csv_module.reader(io.StringIO(text)))
        header, data_rows = rows[0], rows[1:]
        quoted_col = header.index("Is Quoted")
        clip_rows = [r for r in data_rows if r[header.index("Source Type")] == "observation"]
        assert clip_rows and all(r[quoted_col] == "Yes" for r in clip_rows)


# ── Excerpt CSV: the time columns (D32) ─────────────────────────────────────

class TestExcerptCsvTimeColumns:
    def test_time_and_whole_clip_rows_emit_ranges(self, db_session):
        db = db_session
        pid, oid, sid = _obs_with_clip(db, pid=960, oid=960, sid=9601,
                                       start=10.0, end=40.0, label="")
        db.add_all([
            Excerpt(project_id=pid, segment_id=sid, start_time=20.0, end_time=31.5),
            Excerpt(project_id=pid, segment_id=sid),  # whole-clip
        ])
        db.flush()
        text = _stream_to_text(_run(export_excerpts_csv(pid, user=_user(db), db=db)))
        rows = list(csv_module.reader(io.StringIO(text)))
        header = rows[0]
        for col in ("Start Time", "End Time", "Duration"):
            assert col in header
        by_type = {r[header.index("Type")]: r for r in rows[1:]}
        tr = by_type["time-range"]
        assert tr[header.index("Start Time")] == "0:20.0"
        assert tr[header.index("End Time")] == "0:31.5"
        assert tr[header.index("Duration")] == "0:11.5"
        # A whole-clip excerpt emits the CLIP's range — its label is often "",
        # so without the range the row would be blank where it matters most.
        wh = by_type["whole-segment"]
        assert wh[header.index("Start Time")] == "0:10.0"
        assert wh[header.index("End Time")] == "0:40.0"
        assert wh[header.index("Duration")] == "0:30.0"

    def test_conversation_rows_leave_time_columns_empty(self, db_session):
        db = db_session
        pid, cid, sid = _conv_with_segment(db, pid=970, cid=970, sid=9701)
        db.add(Excerpt(project_id=pid, segment_id=sid))
        db.flush()
        text = _stream_to_text(_run(export_excerpts_csv(pid, user=_user(db), db=db)))
        rows = list(csv_module.reader(io.StringIO(text)))
        header, row = rows[0], rows[1]
        assert row[header.index("Start Time")] == ""
        assert row[header.index("Duration")] == ""


# ── format_timecode — the Python mirror of lib/utils.ts ─────────────────────

class TestFormatTimecode:
    @pytest.mark.parametrize("seconds,expected", [
        (0, "0:00.0"),
        (3.1, "0:03.1"),
        (65, "1:05.0"),
        (31.5, "0:31.5"),
        (3661.25, "1:01:01.3"),   # h:mm:ss.d over an hour (and a half-up tenth)
        (-2.0, "0:00.0"),         # clamps below zero, mirroring the TS max(0, …)
        (None, ""),
        (float("inf"), ""),
        (float("nan"), ""),
    ])
    def test_matches_the_ts_mirror(self, seconds, expected):
        assert format_timecode(seconds) == expected

    def test_rounds_halves_up_like_js(self):
        # JS Math.round(2.5) == 3; Python's bare round(2.5) == 2 (banker's).
        # The mirror must follow JS or the same excerpt formats differently in
        # the CSV and on the card.
        assert format_timecode(0.25) == "0:00.3"

    def test_integer_tenths_no_float_dust(self):
        # 0.1 + 0.2 style dust must not render "0:03.10".
        assert format_timecode(3.1000000000000005) == "0:03.1"
