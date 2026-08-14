"""Tests for segment_operations service (merge, split, unmerge, unsplit, group/ungroup)."""

import pytest
from fastapi import HTTPException

# Ensure all models are registered with Base.metadata before create_all.
# conftest.py covers most, but segment_operations depends on these extras:
from app.models.segment_group import SegmentGroup
from app.models.audit import AuditEntry
from app.models.note import Note
from app.models.excerpt import Excerpt
from app.models.memo import Memo

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.schemas.segment import SegmentSplitRange
from app.services.segment_operations import (
    merge_segments,
    unmerge_segment,
    split_segment,
    unsplit_segment,
)
from app.routers.helpers import visible_segment_filter


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _setup_conversation(db):
    """Create a project, conversation, 2 speakers, 5 sequential segments.
    Expects test user id=1 from db_session fixture."""
    user = db.query(User).filter(User.id == 1).one()

    project = Project(id=1, name="Test Project", user_id=1)
    db.add(project)

    conv = Conversation(id=1, project_id=1, name="Interview 1")
    db.add(conv)

    sp_a = Speaker(id=1, project_id=1, name="Alice", color_index=0)
    sp_b = Speaker(id=2, project_id=1, name="Bob", color_index=1)
    db.add_all([sp_a, sp_b])

    texts = [
        "First segment text.",     # 0  (Alice)
        "Second segment here.",    # 1  (Bob)
        "Third part of talk.",     # 2  (Alice)
        "Fourth line spoken.",     # 3  (Bob)
        "Fifth final segment.",    # 4  (Alice)
    ]
    segments = []
    for i, txt in enumerate(texts):
        seg = Segment(
            conversation_id=1,
            speaker_id=(1 if i % 2 == 0 else 2),
            sequence_order=i,
            text=txt,
            word_count=len(txt.split()),
        )
        db.add(seg)
        segments.append(seg)

    db.flush()
    return project, user, conv, [sp_a, sp_b], segments


def _visible_segments(db, conversation_id):
    """Return visible segments for a conversation, ordered by sequence."""
    return (
        db.query(Segment)
        .filter(
            Segment.conversation_id == conversation_id,
            *visible_segment_filter(),
        )
        .order_by(Segment.sequence_order)
        .all()
    )


# ===========================================================================
# Parent-type dispatch fails CLOSED (slab-0 hardening for the Observations track)
# ===========================================================================


class TestParentTypeFailClosed:
    """An unrecognized parent_type must RAISE, not silently target the wrong
    parent. Both dispatch helpers were fail-open: _parent_filter fell through to
    the DOCUMENT filter for any non-'conversation' value, and
    _make_segment_fields left both FKs NULL (→ ck_segment_exactly_one_parent
    violation at flush).

    'observation' became a KNOWN parent in slab 3b (_PARENT_FK gained it for
    the time ops + the reused unmerge), so the unknown-exemplar here is 'media'
    — fittingly, the stale token the plan once used. The observation-specific
    refusal moved to the TEXT ops (test_observation_time_ops.py::
    TestTextOpParentGuards — a different error, by design).
    """

    def test_parent_filter_rejects_unknown(self):
        from app.services.segment_operations import _parent_filter
        with pytest.raises(ValueError, match="Unknown segment parent_type"):
            _parent_filter("media", 1)

    def test_make_segment_fields_rejects_unknown(self):
        from app.services.segment_operations import _make_segment_fields
        with pytest.raises(ValueError, match="Unknown segment parent_type"):
            _make_segment_fields("media", 1)

    @pytest.mark.parametrize("parent_type,expected_fk", [
        ("conversation", "conversation_id"),
        ("document", "document_id"),
        ("observation", "observation_id"),
    ])
    def test_known_types_set_exactly_one_fk(self, parent_type, expected_fk):
        from app.services.segment_operations import _parent_filter, _make_segment_fields
        _parent_filter(parent_type, 1)  # must not raise
        fields = _make_segment_fields(parent_type, 7)
        set_fks = [k for k, v in fields.items() if v is not None]
        assert set_fks == [expected_fk], (
            f"expected only {expected_fk} set, got {set_fks}")

    def test_public_op_rejects_unknown_parent_before_touching_db(self, db_session):
        """The guard is REACHED in the real merge flow (transitively via
        _parent_filter), so a mis-wired op can't run against the wrong parent."""
        with pytest.raises(ValueError, match="Unknown segment parent_type"):
            merge_segments(db_session, [1, 2], "media", 1, project_id=1, user_id=1)


# ===========================================================================
# Merge
# ===========================================================================


class TestMerge:
    def test_merge_two_adjacent(self, db_session):
        """Merging 2 adjacent segments produces combined text, correct speaker, resequenced order."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        merged, deleted_count = merge_segments(
            db_session,
            segment_ids=[segs[1].id, segs[2].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert deleted_count == 2
        assert "Second segment here." in merged.text
        assert "Third part of talk." in merged.text
        assert merged.is_merge_result == 1

        # Combined speaker name for Alice & Bob
        assert merged.speaker is not None
        assert "Bob" in merged.speaker.name
        assert "Alice" in merged.speaker.name

        # Visible segments should be 4 (5 originals - 2 merged + 1 new)
        visible = _visible_segments(db_session, conv.id)
        assert len(visible) == 4
        orders = [s.sequence_order for s in visible]
        assert orders == [0, 1, 2, 3]

    def test_merge_preserves_codes(self, db_session):
        """Codes from both segments appear on the merged segment (union)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        code_a = Code(project_id=1, numeric_id=10, name="Theme A")
        code_b = Code(project_id=1, numeric_id=11, name="Theme B")
        db_session.add_all([code_a, code_b])
        db_session.flush()

        db_session.add(CodeApplication(segment_id=segs[0].id, code_id=code_a.id, user_id=user.id))
        db_session.add(CodeApplication(segment_id=segs[1].id, code_id=code_b.id, user_id=user.id))
        db_session.flush()

        merged, _ = merge_segments(
            db_session,
            segment_ids=[segs[0].id, segs[1].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        merged_code_ids = {ca.code_id for ca in merged.code_applications}
        assert code_a.id in merged_code_ids
        assert code_b.id in merged_code_ids

    def test_merge_non_adjacent_fails(self, db_session):
        """Merging non-consecutive segments raises 400."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        with pytest.raises(HTTPException) as exc:
            merge_segments(
                db_session,
                segment_ids=[segs[0].id, segs[2].id],
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400
        assert "adjacent" in exc.value.detail.lower()

    def test_merge_single_segment_fails(self, db_session):
        """Merging fewer than 2 segments raises 400."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        with pytest.raises(HTTPException) as exc:
            merge_segments(
                db_session,
                segment_ids=[segs[0].id],
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400
        assert "2 segments" in exc.value.detail.lower()

    def test_merge_same_speaker(self, db_session):
        """Merging segments with the same speaker keeps original speaker (no combined name)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        # segs[0] and segs[2] both have speaker Alice, but they're not adjacent.
        # segs[2] and segs[4] both have speaker Alice — but also not adjacent.
        # Reassign segs[1] to Alice so [0] and [1] share a speaker.
        segs[1].speaker_id = 1
        db_session.flush()

        merged, _ = merge_segments(
            db_session,
            segment_ids=[segs[0].id, segs[1].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert merged.speaker_id == speakers[0].id
        assert merged.speaker.name == "Alice"


# ===========================================================================
# Unmerge
# ===========================================================================


class TestUnmerge:
    def test_unmerge_restores_originals(self, db_session):
        """Unmerging reveals original segments with their original text."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        original_texts = [segs[1].text, segs[2].text]
        original_ids = [segs[1].id, segs[2].id]

        merged, _ = merge_segments(
            db_session,
            segment_ids=[segs[1].id, segs[2].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        restored, restored_count = unmerge_segment(
            db_session,
            segment_id=merged.id,
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert restored_count == 2
        assert len(restored) == 2
        restored_texts = [s.text for s in restored]
        assert restored_texts == original_texts

        # All 5 originals visible again
        visible = _visible_segments(db_session, conv.id)
        assert len(visible) == 5
        orders = [s.sequence_order for s in visible]
        assert orders == [0, 1, 2, 3, 4]

    def test_unmerge_non_merged_fails(self, db_session):
        """Unmerging a segment that was not created by merge raises 400."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        with pytest.raises(HTTPException) as exc:
            unmerge_segment(
                db_session,
                segment_id=segs[0].id,
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400
        assert "not created by a merge" in exc.value.detail.lower()


# ===========================================================================
# Split
# ===========================================================================


class TestSplit:
    def test_split_single_range(self, db_session):
        """Splitting a segment at an offset creates 2 new segments."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        # "First segment text." — split at offset 6 to 13 => "segmen"
        # before = "First ", selected = "segment", after = " text."
        seg = segs[0]
        text = seg.text  # "First segment text."
        r = SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=13)

        new_segs, deleted_ids = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert seg.id in deleted_ids
        assert len(new_segs) == 3  # before, selected, after
        assert all(s.is_split_result == 1 for s in new_segs)

        # Visible count: original hidden, 3 new + 4 remaining = 7
        visible = _visible_segments(db_session, conv.id)
        assert len(visible) == 7

    def test_split_no_before(self, db_session):
        """Splitting from offset 0 produces only 2 parts (selected + after)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]  # "First segment text."
        # start_offset=0, end_offset=5 => selected="First", after=" segment text."
        r = SegmentSplitRange(segment_id=seg.id, start_offset=0, end_offset=5)

        new_segs, deleted_ids = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert len(new_segs) == 2
        assert new_segs[0].text == "First"
        assert "segment text." in new_segs[1].text

    def test_split_no_after(self, db_session):
        """Splitting to the end of text produces only 2 parts (before + selected)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]  # "First segment text."
        text_len = len(seg.text)
        # start_offset=6, end_offset=text_len => before="First", selected="segment text."
        r = SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=text_len)

        new_segs, deleted_ids = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert len(new_segs) == 2
        assert new_segs[0].text == "First"
        assert new_segs[1].text == "segment text."

    def test_split_preserves_codes(self, db_session):
        """Codes from the original segment are copied to all split children."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        code = Code(project_id=1, numeric_id=10, name="Theme")
        db_session.add(code)
        db_session.flush()
        db_session.add(CodeApplication(segment_id=segs[0].id, code_id=code.id, user_id=user.id))
        db_session.flush()

        r = SegmentSplitRange(segment_id=segs[0].id, start_offset=6, end_offset=13)
        new_segs, _ = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        for ns in new_segs:
            codes = db_session.query(CodeApplication).filter(
                CodeApplication.segment_id == ns.id,
            ).all()
            assert len(codes) == 1
            assert codes[0].code_id == code.id

    def test_split_original_hidden(self, db_session):
        """After split, the original segment has split_into_id set (hidden from visible filter)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        original_id = segs[0].id

        r = SegmentSplitRange(segment_id=original_id, start_offset=6, end_offset=13)
        split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        original = db_session.get(Segment, original_id)
        assert original.split_into_id is not None

        # Original must NOT appear in visible segments
        visible_ids = [s.id for s in _visible_segments(db_session, conv.id)]
        assert original_id not in visible_ids

    def test_split_entire_text_fails(self, db_session):
        """Selecting the entire segment text raises 400 (nothing left to split)."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]
        r = SegmentSplitRange(segment_id=seg.id, start_offset=0, end_offset=len(seg.text))

        with pytest.raises(HTTPException) as exc:
            split_segment(
                db_session,
                ranges=[r],
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400

    def test_split_invalid_offsets_fails(self, db_session):
        """Invalid offset range raises 400."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]
        # start_offset >= end_offset
        r = SegmentSplitRange(segment_id=seg.id, start_offset=10, end_offset=5)

        with pytest.raises(HTTPException) as exc:
            split_segment(
                db_session,
                ranges=[r],
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400


# ===========================================================================
# Unsplit
# ===========================================================================


class TestUnsplit:
    def test_unsplit_restores_original(self, db_session):
        """Unsplitting restores the original segment and hides split children."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        original_id = segs[0].id
        original_text = segs[0].text

        r = SegmentSplitRange(segment_id=original_id, start_offset=6, end_offset=13)
        new_segs, _ = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        # Unsplit using any of the split-result segment ids
        restored, deleted_count = unsplit_segment(
            db_session,
            segment_id=new_segs[0].id,
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        assert restored.id == original_id
        assert restored.text == original_text
        assert restored.split_into_id is None
        assert deleted_count == 3  # 3 split parts were deleted

        # Back to original 5 visible segments
        visible = _visible_segments(db_session, conv.id)
        assert len(visible) == 5
        orders = [s.sequence_order for s in visible]
        assert orders == [0, 1, 2, 3, 4]

    def test_unsplit_non_split_fails(self, db_session):
        """Unsplitting a segment that was not created by split raises 400."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        with pytest.raises(HTTPException) as exc:
            unsplit_segment(
                db_session,
                segment_id=segs[0].id,
                parent_type="conversation",
                parent_id=conv.id,
                project_id=project.id,
                user_id=user.id,
            )
        assert exc.value.status_code == 400
        assert "not created by a split" in exc.value.detail.lower()


# ===========================================================================
# Group / Ungroup (router-level logic, tested via direct model ops)
# ===========================================================================


class TestGroup:
    def test_group_segments(self, db_session):
        """Creating a SegmentGroup and assigning group_id to segments."""
        _project, _user, conv, _speakers, segs = _setup_conversation(db_session)

        group = SegmentGroup(conversation_id=conv.id)
        db_session.add(group)
        db_session.flush()

        segs[1].group_id = group.id
        segs[2].group_id = group.id
        db_session.flush()

        reloaded = db_session.get(SegmentGroup, group.id)
        member_ids = {s.id for s in reloaded.segments}
        assert segs[1].id in member_ids
        assert segs[2].id in member_ids
        assert len(member_ids) == 2

    def test_ungroup_segments(self, db_session):
        """Removing group_id and deleting the SegmentGroup."""
        _project, _user, conv, _speakers, segs = _setup_conversation(db_session)

        group = SegmentGroup(conversation_id=conv.id)
        db_session.add(group)
        db_session.flush()

        segs[1].group_id = group.id
        segs[2].group_id = group.id
        db_session.flush()

        # Ungroup
        for seg in [segs[1], segs[2]]:
            seg.group_id = None
        db_session.delete(group)
        db_session.flush()

        assert segs[1].group_id is None
        assert segs[2].group_id is None
        assert db_session.get(SegmentGroup, group.id) is None


# ===========================================================================
# Visibility filter integration
# ===========================================================================


class TestVisibility:
    def test_visible_filter_after_merge(self, db_session):
        """Merged-into segments are excluded from visible_segment_filter."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        merged, _ = merge_segments(
            db_session,
            segment_ids=[segs[0].id, segs[1].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        visible = _visible_segments(db_session, conv.id)
        visible_ids = {s.id for s in visible}

        # Originals hidden
        assert segs[0].id not in visible_ids
        assert segs[1].id not in visible_ids
        # Merged result visible
        assert merged.id in visible_ids
        # Total: 5 - 2 + 1 = 4
        assert len(visible) == 4

    def test_visible_filter_after_split(self, db_session):
        """Split-into original is excluded; split children are visible."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        original_id = segs[0].id

        r = SegmentSplitRange(segment_id=original_id, start_offset=6, end_offset=13)
        new_segs, _ = split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        visible = _visible_segments(db_session, conv.id)
        visible_ids = {s.id for s in visible}

        # Original hidden
        assert original_id not in visible_ids
        # All split children visible
        for ns in new_segs:
            assert ns.id in visible_ids
        # Total: 5 - 1 + 3 = 7
        assert len(visible) == 7

    def test_sequence_continuity_after_merge(self, db_session):
        """After merge, sequence_order values are contiguous starting at 0."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        merge_segments(
            db_session,
            segment_ids=[segs[2].id, segs[3].id, segs[4].id],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        visible = _visible_segments(db_session, conv.id)
        orders = [s.sequence_order for s in visible]
        assert orders == list(range(len(orders)))

    def test_sequence_continuity_after_split(self, db_session):
        """After split, sequence_order values are contiguous starting at 0."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)

        r = SegmentSplitRange(segment_id=segs[2].id, start_offset=6, end_offset=11)
        split_segment(
            db_session,
            ranges=[r],
            parent_type="conversation",
            parent_id=conv.id,
            project_id=project.id,
            user_id=user.id,
        )

        visible = _visible_segments(db_session, conv.id)
        orders = [s.sequence_order for s in visible]
        assert orders == list(range(len(orders)))


# ═══════════════════════════════════════════════════════════════════════════════
# #695 — char-range quotes must survive a split
#
# `split_segment` carried forward only WHOLE-segment excerpts (`had_whole_excerpt`).
# Char-range quotes stayed attached to the original, which the split soft-deletes via
# `split_into_id` — so `visible_segment_filter()` hid them and they vanished from the
# workbench and the Quote Board with no notice. Not data loss (unsplit recovers them),
# but silent disappearance.
#
# The fix ports #621's `_clip_excerpt_carry_plan` shape to text. Two things make the
# text case genuinely different from the clip case, and both are pinned below:
#   1. children are built from STRIPPED slices, so offsets shift by discarded whitespace
#   2. the multi-segment split CONCATENATES runs from N sources into one child
# ═══════════════════════════════════════════════════════════════════════════════

class TestCharRangeQuotesSurviveSplit:

    def _quote(self, db, project_id, seg, start, end):
        ex = Excerpt(project_id=project_id, segment_id=seg.id, start_offset=start, end_offset=end)
        db.add(ex)
        db.flush()
        return ex

    def _visible_quotes(self, db, segs):
        """(text, quote_text) for every char-range quote on the given segments."""
        out = []
        for s in segs:
            for e in s.excerpts:
                if e.start_offset is not None:
                    out.append(s.text[e.start_offset:e.end_offset])
        return out

    def test_quote_inside_the_selected_part_is_carried_and_rebased(self, db_session):
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]  # "First segment text."
        # Quote "segment" (offsets 6..13), split so it lands wholly in `selected`.
        assert seg.text[6:13] == "segment"
        self._quote(db_session, project.id, seg, 6, 13)

        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=13)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        assert self._visible_quotes(db_session, new_segs) == ["segment"]

    def test_the_rebase_accounts_for_the_stripped_whitespace(self, db_session):
        """The arithmetic the clip sibling never needs.

        `before_text = text[:start].strip()`, so the child's text is NOT
        `text[:start]` — a naive `offset - part_start` would be off by the discarded
        leading whitespace and the quote would point at the wrong words.
        """
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]
        seg.text = "   Leading space then QUOTED here."
        db_session.flush()
        qs = seg.text.index("QUOTED")
        self._quote(db_session, project.id, seg, qs, qs + len("QUOTED"))

        # Split so the quote lands in `after`, whose slice also gets stripped.
        cut = seg.text.index("then")
        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=cut, end_offset=cut + 4)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        assert "QUOTED" in self._visible_quotes(db_session, new_segs)

    def test_a_quote_straddling_the_cut_is_divided_not_dropped(self, db_session):
        """Picking a side or dropping it would silently discard a marked passage."""
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]  # "First segment text."
        # Quote "rst segment" spans the cut at offset 6.
        qs, qe = 2, 13
        self._quote(db_session, project.id, seg, qs, qe)

        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=13)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        quotes = self._visible_quotes(db_session, new_segs)
        # Both halves of the marked passage survive, one per child.
        assert "rst" in quotes
        assert "segment" in quotes

    def test_unsplit_restores_the_original_quote_and_removes_the_copies(self, db_session):
        """Copy-never-move is what makes the inverse free.

        Re-pointing would be worse than awkward: unsplit DELETES the children, so a
        re-pointed excerpt would be destroyed outright and its note's `excerpt_id`
        (ondelete=SET NULL) would silently detach.
        """
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]
        original_id = seg.id
        self._quote(db_session, project.id, seg, 6, 13)
        before = db_session.query(Excerpt).count()

        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=13)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        assert db_session.query(Excerpt).count() > before, "a copy must have been made"

        unsplit_segment(
            db_session, segment_id=new_segs[0].id,
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        restored = db_session.query(Segment).filter(Segment.id == original_id).one()
        assert restored.split_into_id is None
        assert [(e.start_offset, e.end_offset) for e in restored.excerpts] == [(6, 13)]
        assert db_session.query(Excerpt).count() == before, "copies must go with the children"

    def test_two_quotes_collapsing_to_the_same_span_do_not_violate_the_unique_index(self, db_session):
        """`ix_excerpt_segment_range` is unique per (segment, start, end).

        Two distinct quotes on the source CAN clip to the same span on one child;
        without the dedup that is an IntegrityError mid-split, not a duplicate row.
        """
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]  # "First segment text."
        # Both overlap the `selected` part [6,13) on exactly [6,13) after clipping.
        self._quote(db_session, project.id, seg, 0, 13)
        self._quote(db_session, project.id, seg, 3, 13)

        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=6, end_offset=13)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        db_session.flush()  # would raise IntegrityError without the dedup
        selected = [s for s in new_segs if s.text == "segment"][0]
        spans = sorted((e.start_offset, e.end_offset) for e in selected.excerpts if e.start_offset is not None)
        assert spans == [(0, 7)], spans

    def test_multi_segment_split_carries_quotes_from_every_source(self, db_session):
        """The concatenation case — the sibling path with the same defect.

        `selected_text` joins runs from N segments with ' ', so a quote from the
        SECOND source needs `dest_offset + (quote - src_start)`; a plain rebase
        would land it at the wrong place in the merged child.
        """
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        s0, s1 = segs[0], segs[1]   # "First segment text." / "Second segment here."
        # A quote in the FIRST source's selected run…
        self._quote(db_session, project.id, s0, 6, 13)          # "segment"
        # …and one in the SECOND, which only a dest-offset-aware map places correctly.
        q1s = s1.text.index("here")
        self._quote(db_session, project.id, s1, q1s, q1s + 4)   # "here"

        new_segs, _ = split_segment(
            db_session,
            ranges=[
                SegmentSplitRange(segment_id=s0.id, start_offset=6, end_offset=len(s0.text)),
                SegmentSplitRange(segment_id=s1.id, start_offset=0, end_offset=len(s1.text)),
            ],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        quotes = self._visible_quotes(db_session, new_segs)
        assert "segment" in quotes, quotes
        assert "here" in quotes, quotes

    def test_a_whitespace_only_quote_is_carried_nowhere_rather_than_misplaced(self, db_session):
        """No child exists for stripped whitespace, so there is no honest destination.

        It stays on the soft-deleted original and returns on unsplit — the same
        outcome as before the fix, but now by decision rather than by omission.
        """
        project, user, conv, speakers, segs = _setup_conversation(db_session)
        seg = segs[0]
        seg.text = "Alpha    Beta"
        db_session.flush()
        self._quote(db_session, project.id, seg, 5, 9)  # inside the run of spaces

        new_segs, _ = split_segment(
            db_session,
            ranges=[SegmentSplitRange(segment_id=seg.id, start_offset=9, end_offset=13)],
            parent_type="conversation", parent_id=conv.id,
            project_id=project.id, user_id=user.id,
        )
        carried = [e for s in new_segs for e in s.excerpts if e.start_offset is not None]
        assert carried == []
