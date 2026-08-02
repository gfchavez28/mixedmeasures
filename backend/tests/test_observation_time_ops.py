"""Observation time operations — split/merge + their undo inverses (slab 3b).

Pins: the tiling split (label to BOTH halves, notes to the FIRST half, per-coder
layers carried to both), the no-adjacency merge (spans gaps, " / " labels,
(code, coder) dedup, notes stranded-then-restored), the REUSED unmerge_segment
(with the load-bearing observation resequence — the interleave fixture fails
under the text op's shift arithmetic alone), the two-id unsplit_clip (tiling
validation instead of the _find_split_siblings contiguity heuristic, which is
unsound for time-ordered clips), the consensus-origin carry filter, and the
symmetric text-op parent guards.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.auth import get_or_create_consensus_user
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.note import Note
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.observations import (
    create_clip,
    freeze_segmentation,
    list_observation_segments,
    merge_observation_clips,
    split_clip,
    unmerge_clip,
    unsplit_observation_clip,
    update_clip,
)
from app.schemas.observation import (
    ClipCreate,
    ClipMergeRequest,
    ClipSplitRequest,
    ClipUnsplitRequest,
    ClipUpdate,
)
from app.services.segment_operations import merge_segments, split_segment


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


def _coder(db, uid, name):
    u = User(id=uid, username=name, password_hash=None, coder_type="human")
    db.add(u)
    db.flush()
    return u


def _obs_project(db, pid=740):
    db.add(Project(id=pid, name="P", user_id=1))
    db.add(Observation(id=pid, project_id=pid, name="Obs"))
    db.flush()
    return pid


def _code(db, cid, pid, numeric_id=1):
    db.add(Code(id=cid, project_id=pid, name=f"Code{cid}", numeric_id=numeric_id,
                is_active=True, is_universal=False))
    db.flush()


def _apply(db, code_id, user_id, segment_id):
    db.add(CodeApplication(code_id=code_id, user_id=user_id, segment_id=segment_id))
    db.flush()


def _clip(db, u, pid, start, end, text=""):
    return _run(create_clip(pid, pid, ClipCreate(start_time=start, end_time=end, text=text),
                            user=u, db=db))


def _listed(db, u, pid):
    return _run(list_observation_segments(pid, pid, user=u, db=db))


# ── Split ────────────────────────────────────────────────────────────────────


class TestSplitClip:
    def test_split_tiles_range_copies_label_and_carries_layers(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _coder(db, 2, "K")
        clip = _clip(db, u, pid, 0.0, 10.0, "lesson")
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        _apply(db, 1, 2, clip.id)

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        assert [(h.start_time, h.end_time, h.text) for h in halves] == [
            (0.0, 4.0, "lesson"), (4.0, 10.0, "lesson")
        ]
        # Every coder's layer carried to BOTH halves.
        for h in halves:
            assert sorted((d.code_id, d.user_id) for d in h.applied_code_details) == [
                (1, 1), (1, 2)
            ]
        # Original soft-deleted, pointing at the FIRST half; list shows the halves.
        original = db.query(Segment).filter(Segment.id == clip.id).one()
        assert original.split_into_id == halves[0].id
        assert [c.id for c in _listed(db, u, pid)] == [h.id for h in halves]

    def test_split_moves_notes_to_first_half(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        note = Note(observation_id=pid, segment_id=clip.id, content="n", sequence_number=1)
        db.add(note)
        db.flush()

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=6.0),
                                 user=u, db=db))

        db.refresh(note)
        assert note.segment_id == halves[0].id

    @pytest.mark.parametrize("t", [0.0, 10.0, -1.0, 12.0, float("nan")])
    def test_split_time_strictly_inside_or_400(self, db_session, t):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        with pytest.raises(HTTPException) as ei:
            _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=t), user=u, db=db))
        assert ei.value.status_code == 400

    def test_split_point_event_400(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        pin = _clip(db, u, pid, 5.0, 5.0)
        with pytest.raises(HTTPException) as ei:
            _run(split_clip(pid, pid, pin.id, ClipSplitRequest(time=5.0), user=u, db=db))
        assert ei.value.status_code == 400

    def test_split_frozen_409(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0), user=u, db=db))
        assert ei.value.status_code == 409

    def test_split_never_carries_consensus_rows(self, db_session):
        """Time ops run only on UNFROZEN observations, where a carried consensus
        row would be a stranded orphan (the #615 shape)."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        consensus = get_or_create_consensus_user(db)
        db.add(CodeApplication(code_id=1, user_id=consensus.id, origin="consensus",
                               segment_id=clip.id))
        db.flush()

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        for h in halves:
            rows = db.query(CodeApplication).filter(
                CodeApplication.segment_id == h.id
            ).all()
            assert [r.origin for r in rows] == ["human"] or all(
                r.origin != "consensus" for r in rows
            )
            assert len(rows) == 1


# ── Merge ────────────────────────────────────────────────────────────────────


class TestMergeClips:
    def test_merge_spans_gap_joins_labels_and_resequences(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 2.0, "a")
        _clip(db, u, pid, 4.0, 5.0, "middle")
        b = _clip(db, u, pid, 8.0, 10.0, "b")

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[b.id, a.id]), user=u, db=db))

        assert (merged.start_time, merged.end_time) == (0.0, 10.0)
        assert merged.text == "a / b"  # temporal order, despite the reversed input
        listed = _listed(db, u, pid)
        assert [(c.text, c.sequence_order) for c in listed] == [
            ("a / b", 0), ("middle", 1)
        ]

    def test_merge_dedups_per_coder_layers(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _coder(db, 2, "K")
        a = _clip(db, u, pid, 0.0, 2.0)
        b = _clip(db, u, pid, 8.0, 10.0)
        _code(db, 1, pid)
        _apply(db, 1, 1, a.id)  # coder 1 on both originals → ONE merged row
        _apply(db, 1, 1, b.id)
        _apply(db, 1, 2, b.id)  # coder 2 only on b → preserved distinctly

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))

        assert sorted((d.code_id, d.user_id) for d in merged.applied_code_details) == [
            (1, 1), (1, 2)
        ]

    def test_merge_label_skips_empty_and_duplicates(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0, "")
        b = _clip(db, u, pid, 2.0, 3.0, "same")
        c = _clip(db, u, pid, 4.0, 5.0, "same")
        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id, c.id]), user=u, db=db))
        assert merged.text == "same"

    def test_merge_requires_two_distinct_visible_clips(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        for ids in ([a.id], [a.id, a.id], [a.id, 9999]):
            with pytest.raises(HTTPException) as ei:
                _run(merge_observation_clips(
                    pid, pid, ClipMergeRequest(segment_ids=ids), user=u, db=db))
            assert ei.value.status_code == 400
        # A soft-deleted clip can't merge again.
        _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(merge_observation_clips(
                pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))
        assert ei.value.status_code == 400

    def test_merge_frozen_409(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(merge_observation_clips(
                pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))
        assert ei.value.status_code == 409


# ── Unmerge (the reused text op + the load-bearing resequence) ──────────────


class TestUnmergeClip:
    def test_unmerge_restores_time_order_not_shift_arithmetic(self, db_session):
        """A[0,1] + B[10,11] merged, C[5,6] between them. The text op's shift
        arithmetic alone restores A,B adjacent (orders 0,1 with C shifted to 2);
        the true temporal order is A, C, B — the observation resequence inside
        unmerge_segment is what produces it."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0, "A")
        _clip(db, u, pid, 5.0, 6.0, "C")
        b = _clip(db, u, pid, 10.0, 11.0, "B")
        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))

        restored = _run(unmerge_clip(pid, pid, merged.id, user=u, db=db))

        assert sorted(c.id for c in restored) == sorted([a.id, b.id])
        listed = _listed(db, u, pid)
        assert [(c.text, c.sequence_order) for c in listed] == [
            ("A", 0), ("C", 1), ("B", 2)
        ]

    def test_unmerge_restores_note_reachability(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        note = Note(observation_id=pid, segment_id=a.id, content="n", sequence_number=1)
        db.add(note)
        db.flush()
        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))
        # Stranded on the hidden original while merged (mirrors the text merge)…
        db.refresh(note)
        assert note.segment_id == a.id

        _run(unmerge_clip(pid, pid, merged.id, user=u, db=db))

        # …and reachable again once the original is restored.
        listed = _listed(db, u, pid)
        noted = {c.id: [n.id for n in c.attached_notes] for c in listed}
        assert noted[a.id] == [note.id]

    def test_unmerge_rehomes_post_merge_coding_to_first_original(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db))
        _code(db, 1, pid)
        _apply(db, 1, 1, merged.id)  # coding done AFTER the merge

        _run(unmerge_clip(pid, pid, merged.id, user=u, db=db))

        homed = db.query(CodeApplication).filter(CodeApplication.code_id == 1).all()
        assert [ca.segment_id for ca in homed] == [a.id]


# ── Unsplit (two explicit ids + tiling validation) ──────────────────────────


class TestUnsplitClip:
    def test_split_unsplit_round_trip(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0, "whole")
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        restored = _run(unsplit_observation_clip(
            pid, pid, ClipUnsplitRequest(segment_ids=[h.id for h in halves]),
            user=u, db=db))

        assert (restored.id, restored.start_time, restored.end_time, restored.text) == (
            clip.id, 0.0, 10.0, "whole"
        )
        # No duplicated layers, children hard-deleted, list shows the original.
        assert [(d.code_id, d.user_id) for d in restored.applied_code_details] == [(1, 1)]
        assert db.query(Segment).filter(
            Segment.id.in_([h.id for h in halves])
        ).count() == 0
        assert [c.id for c in _listed(db, u, pid)] == [clip.id]

    def test_unsplit_rehomes_post_split_coding_and_notes(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))
        _code(db, 1, pid)
        _apply(db, 1, 1, halves[1].id)  # coded AFTER the split
        note = Note(observation_id=pid, segment_id=halves[1].id, content="n",
                    sequence_number=1)
        db.add(note)
        db.flush()

        restored = _run(unsplit_observation_clip(
            pid, pid, ClipUnsplitRequest(segment_ids=[h.id for h in halves]),
            user=u, db=db))

        assert [(d.code_id, d.user_id) for d in restored.applied_code_details] == [(1, 1)]
        db.refresh(note)
        assert note.segment_id == restored.id

    def test_unsplit_requires_the_exact_pair(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip_a = _clip(db, u, pid, 0.0, 10.0)
        clip_b = _clip(db, u, pid, 20.0, 30.0)
        halves_a = _run(split_clip(pid, pid, clip_a.id, ClipSplitRequest(time=4.0),
                                   user=u, db=db))
        halves_b = _run(split_clip(pid, pid, clip_b.id, ClipSplitRequest(time=25.0),
                                   user=u, db=db))
        # One id, and a cross-split pair, both refuse.
        for ids in ([halves_a[0].id], [halves_a[0].id, halves_b[1].id]):
            with pytest.raises(HTTPException) as ei:
                _run(unsplit_observation_clip(
                    pid, pid, ClipUnsplitRequest(segment_ids=ids), user=u, db=db))
            assert ei.value.status_code == 400

    def test_unsplit_refuses_after_a_boundary_edit(self, db_session):
        """An undo whose target was edited since is not an undo — the pair no
        longer tiles the original's range."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))
        _run(update_clip(pid, pid, halves[1].id, ClipUpdate(end_time=12.0),
                         user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(unsplit_observation_clip(
                pid, pid, ClipUnsplitRequest(segment_ids=[h.id for h in halves]),
                user=u, db=db))
        assert ei.value.status_code == 400


# ── Cross-observation / cross-tenant scoping (#641) ─────────────────────────


def _second_tenant(db, *, pid=741, obs_id=7410, owner_id=9):
    """A SECOND project, owned by a DIFFERENT user, with its own observation.

    Ids deliberately differ from one another: `_obs_project` gives the project
    and the observation the SAME id, so a confusion between the two coincides
    there and hides (the coinciding-identifiers rule in tests/CLAUDE.md). Here
    741 != 7410 != 740, so a scope that reads the wrong one cannot pass by luck.
    """
    db.add(User(id=owner_id, username="Other coder", password_hash=None,
                coder_type="human"))
    db.add(Project(id=pid, name="Their project", user_id=owner_id))
    db.flush()
    db.add(Observation(id=obs_id, project_id=pid, name="Their obs"))
    db.flush()
    return pid, obs_id, db.get(User, owner_id)


class TestCrossObservationScoping:
    """`merge_clips` / `unsplit_clip` take `segment_ids` from the REQUEST BODY.

    The router validates the *observation* (`_get_observation_or_404`), never
    the clip ids — so `Segment.observation_id == observation_id` inside the
    service is the only thing standing between a caller and another
    observation's clips, which since an observation belongs to a project means
    another PROJECT's clips, codes and quotes.

    The scoping is correct today; #641 is that nothing pinned it. Removing the
    filter from `merge_clips` left all 2,195 backend tests passing AND the
    ownership AST sweep green (the router's gate token is still present) — the
    exact blindness the overlay warns about: *"the scan passes on any gate
    token and is structurally blind to a cross-tenant SECOND entity id."*
    D17's recording-reuse hatch got a behavioural test; the clip time ops,
    which landed later, did not.
    """

    def test_merge_refuses_a_clip_from_another_observation(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        mine = _clip(db, u, pid, 0.0, 2.0, "mine")
        their_pid, their_obs, their_u = _second_tenant(db)
        theirs = _run(create_clip(
            their_pid, their_obs,
            ClipCreate(start_time=0.0, end_time=2.0, text="theirs"),
            user=their_u, db=db))

        with pytest.raises(HTTPException) as ei:
            _run(merge_observation_clips(
                pid, pid, ClipMergeRequest(segment_ids=[mine.id, theirs.id]),
                user=u, db=db))
        assert ei.value.status_code == 400

        # Neither side mutated: no merged clip here, their clip still theirs
        # and still visible (a partial merge would have soft-deleted it).
        assert [c.id for c in _listed(db, u, pid)] == [mine.id]
        stolen = db.get(Segment, theirs.id)
        assert stolen.observation_id == their_obs
        assert stolen.merged_into_id is None

    def test_unsplit_refuses_halves_from_another_observation(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _clip(db, u, pid, 0.0, 2.0, "mine")
        their_pid, their_obs, their_u = _second_tenant(db)
        their_clip = _run(create_clip(
            their_pid, their_obs,
            ClipCreate(start_time=0.0, end_time=10.0, text="theirs"),
            user=their_u, db=db))
        halves = _run(split_clip(
            their_pid, their_obs, their_clip.id, ClipSplitRequest(time=4.0),
            user=their_u, db=db))

        with pytest.raises(HTTPException) as ei:
            _run(unsplit_observation_clip(
                pid, pid,
                ClipUnsplitRequest(segment_ids=[h.id for h in halves]),
                user=u, db=db))
        assert ei.value.status_code == 400

        # Their split survives intact — an unsplit HARD-DELETES the halves, so
        # a leak here destroys another project's data rather than merely
        # reading it.
        assert db.query(Segment).filter(
            Segment.id.in_([h.id for h in halves])
        ).count() == 2
        assert db.get(Segment, their_clip.id).split_into_id is not None


# ── The symmetric text-op guards ────────────────────────────────────────────


class TestTextOpParentGuards:
    """Adding 'observation' to _PARENT_FK silently made the TEXT forward ops
    accept clips (char-splitting a clip label, text-joining labels on merge) —
    the explicit refusal is what un-legalizes that. A wiring bug, so ValueError,
    not a 400."""

    def test_text_merge_refuses_observation_parent(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        with pytest.raises(ValueError, match="time ops"):
            merge_segments(db, [a.id, b.id], 'observation', pid, pid, 1)

    def test_text_split_refuses_observation_parent(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _clip(db, u, pid, 0.0, 1.0, "label")
        with pytest.raises(ValueError, match="time ops"):
            split_segment(db, [object()], 'observation', pid, pid, 1)


# ── Quote carry through the time ops (#621) ─────────────────────────────────
#
# The gap these close: both ops soft-delete their inputs, and every quote
# surface reads through visible_segment_filter(), so before #621 a quote simply
# vanished the moment its clip was split or merged — recoverable only by an
# undo the researcher had no reason to reach for. The TEXT split had always
# re-created a whole excerpt on the selected part; the clip path had no
# analogue because it predated clip quotes existing at all (slab 5a).
#
# ⚠️ Fixture discipline: every fixture below sits where the OLD and NEW
# behaviour DISAGREE. In particular the straddle test uses a quote that
# genuinely crosses the cut — a quote wholly inside one half would pass under
# a "carry to the containing half" implementation AND under a buggy
# "carry everything to the first half" one.


def _quote(db, pid, segment_id, start=None, end=None):
    from app.models.excerpt import Excerpt
    ex = Excerpt(project_id=pid, segment_id=segment_id, start_time=start, end_time=end)
    db.add(ex)
    db.flush()
    return ex


def _quotes_on(db, segment_id):
    from app.models.excerpt import Excerpt
    return sorted(
        (
            (e.start_time, e.end_time)
            for e in db.query(Excerpt).filter(Excerpt.segment_id == segment_id).all()
        ),
        key=lambda p: (p[0] is not None, p),
    )


class TestSplitCarriesQuotes:
    def test_whole_clip_quote_goes_to_both_halves(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0, "lesson")
        _quote(db, pid, clip.id)

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        # Both halves inherit the claim, exactly as the LABEL does.
        assert _quotes_on(db, halves[0].id) == [(None, None)]
        assert _quotes_on(db, halves[1].id) == [(None, None)]

    def test_time_quote_goes_to_the_half_that_contains_it(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _quote(db, pid, clip.id, 6.0, 8.0)   # wholly inside the SECOND half

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        assert _quotes_on(db, halves[0].id) == []
        assert _quotes_on(db, halves[1].id) == [(6.0, 8.0)]

    def test_a_quote_straddling_the_cut_is_divided_at_the_cut(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _quote(db, pid, clip.id, 2.0, 8.0)   # crosses t=4

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        # Neither piece is dropped and neither side silently swallows the whole
        # range — the marked moment survives in full across the two clips.
        assert _quotes_on(db, halves[0].id) == [(2.0, 4.0)]
        assert _quotes_on(db, halves[1].id) == [(4.0, 8.0)]

    def test_point_quote_exactly_at_the_cut_lands_on_the_first_half(self, db_session):
        """Contained by BOTH halves — the tie-break must be deterministic."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _quote(db, pid, clip.id, 4.0, 4.0)   # a point quote AT t

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))

        assert _quotes_on(db, halves[0].id) == [(4.0, 4.0)]
        assert _quotes_on(db, halves[1].id) == []

    def test_unsplit_restores_the_original_single_quote(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 10.0)
        _quote(db, pid, clip.id, 2.0, 8.0)

        halves = _run(split_clip(pid, pid, clip.id, ClipSplitRequest(time=4.0),
                                 user=u, db=db))
        _run(unsplit_observation_clip(
            pid, pid, ClipUnsplitRequest(segment_ids=[h.id for h in halves]),
            user=u, db=db,
        ))

        # The halves' copies went with them (delete-orphan); the original's own
        # quote was never touched, so the divide is fully reversible.
        assert _quotes_on(db, clip.id) == [(2.0, 8.0)]
        for h in halves:
            assert _quotes_on(db, h.id) == []


class TestMergeCarriesQuotes:
    def test_whole_clip_quotes_collapse_to_one(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 5.0)
        b = _clip(db, u, pid, 10.0, 15.0)
        _quote(db, pid, a.id)
        _quote(db, pid, b.id)

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db,
        ))

        # ix_excerpt_segment_whole permits exactly one — two would be an
        # IntegrityError, not a cosmetic duplicate.
        assert _quotes_on(db, merged.id) == [(None, None)]

    def test_identical_time_quotes_on_two_inputs_dedup(self, db_session):
        """Overlapping clips quoting the SAME moment — the unique index case."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 10.0)
        b = _clip(db, u, pid, 5.0, 15.0)
        _quote(db, pid, a.id, 6.0, 7.0)
        _quote(db, pid, b.id, 6.0, 7.0)

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db,
        ))

        assert _quotes_on(db, merged.id) == [(6.0, 7.0)]

    def test_distinct_time_quotes_all_carry(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 5.0)
        b = _clip(db, u, pid, 10.0, 15.0)
        _quote(db, pid, a.id, 1.0, 2.0)
        _quote(db, pid, b.id, 11.0, 12.0)

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db,
        ))

        assert _quotes_on(db, merged.id) == [(1.0, 2.0), (11.0, 12.0)]

    def test_unmerge_restores_each_input_quote(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 5.0)
        b = _clip(db, u, pid, 10.0, 15.0)
        _quote(db, pid, a.id, 1.0, 2.0)
        _quote(db, pid, b.id)

        merged = _run(merge_observation_clips(
            pid, pid, ClipMergeRequest(segment_ids=[a.id, b.id]), user=u, db=db,
        ))
        _run(unmerge_clip(pid, pid, merged.id, user=u, db=db))

        assert _quotes_on(db, a.id) == [(1.0, 2.0)]
        assert _quotes_on(db, b.id) == [(None, None)]
        assert _quotes_on(db, merged.id) == []
