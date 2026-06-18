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
