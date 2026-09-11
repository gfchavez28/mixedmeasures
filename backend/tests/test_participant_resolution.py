"""Row 45 step 1 — `services/participant_resolution.py`.

The resolver is an ENUMERATION over routes to a participant, which is the shape
#515/#676 names as guaranteeing a next instance. So the two gates at the bottom
derive the route set from artifacts a fourth route MUST touch — the FK graph and
`segment_operations._PARENT_FK` — rather than restating the three that exist.

The behavioural fixture populates every route AT ONCE, with a decoy participant
in the same sources: a query missing its scoping filter still produces plausible
answers, and only a second person can tell "this target's participant" from
"some participant in this project".
"""

import pytest

from app.models.conversation import Conversation
from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.document import Document
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services import participant_resolution as pr
from app.services.participant_resolution import (
    ROUTE_DATASET_ROW,
    ROUTE_DOCUMENT,
    ROUTE_OBSERVATION,
    ROUTE_SPEAKER,
    UNRESOLVED_DOCUMENT_UNLINKED,
    UNRESOLVED_NO_SPEAKER,
    UNRESOLVED_OBSERVATION_CLIP,
    UNRESOLVED_ROW_UNLINKED,
    UNRESOLVED_SPEAKER_UNLINKED,
    resolve_for_applications,
    resolve_participants,
)


@pytest.fixture
def corpus(db_session):
    """Every route, resolved and unresolved, plus a second project.

    Deliberately mirrors the shapes `backend/seed_pd_audit.py` plants, with the
    one it does NOT: a facilitator who IS linked to a participant. The seed's
    interviewers carry `participant_id=None`, so `via_facilitator` would be
    dead in every assertion drawn from that corpus.
    """
    db = db_session
    db.add(Project(id=1, name="PD audit", user_id=1))
    db.add(Project(id=2, name="Another project", user_id=1))
    db.flush()

    subject = Participant(project_id=1, identifier="E-01", display_name="Amara")
    decoy = Participant(project_id=1, identifier="E-02", display_name="Ben")
    host = Participant(project_id=1, identifier="F-01", display_name="Interviewer")
    db.add_all([subject, decoy, host])
    db.flush()

    conv = Conversation(project_id=1, name="Interview 1")
    db.add(conv)
    db.flush()

    linked = Speaker(project_id=1, name="Amara", participant_id=subject.id)
    unlinked = Speaker(project_id=1, name="Unknown voice", participant_id=None)
    facilitator = Speaker(
        project_id=1, name="Interviewer", is_facilitator=1, participant_id=host.id
    )
    db.add_all([linked, unlinked, facilitator])
    db.flush()

    turn = Segment(conversation_id=conv.id, speaker_id=linked.id,
                   sequence_order=0, text="my goal this year")
    unlinked_turn = Segment(conversation_id=conv.id, speaker_id=unlinked.id,
                            sequence_order=1, text="mumbling")
    untagged_turn = Segment(conversation_id=conv.id, speaker_id=None,
                            sequence_order=2, text="crosstalk")
    facilitator_turn = Segment(conversation_id=conv.id, speaker_id=facilitator.id,
                               sequence_order=3, text="and what happened next?")
    merged_turn = Segment(conversation_id=conv.id, speaker_id=linked.id,
                          sequence_order=4, text="a turn that was merged away")
    db.add_all([turn, unlinked_turn, untagged_turn, facilitator_turn, merged_turn])
    db.flush()
    merged_turn.merged_into_id = turn.id
    db.flush()

    # Row 46: the subject reached a SECOND way, and a document about nobody.
    doc = Document(project_id=1, name="Workplan 2026", source_filename="w.docx",
                   source_format="docx", participant_id=subject.id)
    orphan_doc = Document(project_id=1, name="Development policy",
                          source_filename="p.docx", source_format="docx",
                          participant_id=None)
    db.add_all([doc, orphan_doc])
    db.flush()
    doc_seg = Segment(document_id=doc.id, sequence_order=0, text="a goal")
    orphan_doc_seg = Segment(document_id=orphan_doc.id, sequence_order=0, text="policy")
    db.add_all([doc_seg, orphan_doc_seg])
    db.flush()

    # The route that reaches nobody by design.
    obs = Observation(project_id=1, name="Team huddle")
    db.add(obs)
    db.flush()
    clip = Segment(observation_id=obs.id, sequence_order=0, text="a clip",
                   start_time=1.0, end_time=4.0)
    db.add(clip)
    db.flush()

    ds = Dataset(project_id=1, name="HR extract")
    db.add(ds)
    db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_text="Q1",
                        column_type=ColumnType.OPEN_TEXT,
                        sequence_order=0, display_order=0)
    db.add(col)
    db.flush()
    linked_row = DatasetRow(dataset_id=ds.id, participant_id=decoy.id,
                            row_identifier="r1")
    unlinked_row = DatasetRow(dataset_id=ds.id, participant_id=None,
                              row_identifier="r2")
    db.add_all([linked_row, unlinked_row])
    db.flush()
    cell = DatasetValue(row_id=linked_row.id, column_id=col.id, value_text="an answer")
    unlinked_cell = DatasetValue(row_id=unlinked_row.id, column_id=col.id,
                                 value_text="another answer")
    db.add_all([cell, unlinked_cell])
    db.flush()

    # A second project's material, so the scoping filter has something to drop.
    other_conv = Conversation(project_id=2, name="Elsewhere")
    db.add(other_conv)
    db.flush()
    other_participant = Participant(project_id=2, identifier="X-01")
    db.add(other_participant)
    db.flush()
    other_speaker = Speaker(project_id=2, name="Somebody",
                            participant_id=other_participant.id)
    db.add(other_speaker)
    db.flush()
    foreign_turn = Segment(conversation_id=other_conv.id, speaker_id=other_speaker.id,
                           sequence_order=0, text="not ours")
    db.add(foreign_turn)
    db.flush()

    return {
        "db": db,
        "subject": subject, "decoy": decoy, "host": host,
        "turn": turn, "unlinked_turn": unlinked_turn,
        "untagged_turn": untagged_turn, "facilitator_turn": facilitator_turn,
        "merged_turn": merged_turn,
        "doc_seg": doc_seg, "orphan_doc_seg": orphan_doc_seg,
        "clip": clip,
        "cell": cell, "unlinked_cell": unlinked_cell,
        "foreign_turn": foreign_turn,
    }


def _resolve_all(corpus):
    return resolve_participants(
        corpus["db"], 1,
        segment_ids=[
            corpus["turn"].id, corpus["unlinked_turn"].id,
            corpus["untagged_turn"].id, corpus["facilitator_turn"].id,
            corpus["merged_turn"].id, corpus["doc_seg"].id,
            corpus["orphan_doc_seg"].id, corpus["clip"].id,
            corpus["foreign_turn"].id,
        ],
        dataset_value_ids=[corpus["cell"].id, corpus["unlinked_cell"].id],
    )


class TestTheThreeRoutes:
    def test_a_conversation_turn_resolves_through_its_speaker(self, corpus):
        route = _resolve_all(corpus).segments[corpus["turn"].id]
        assert route.participant_id == corpus["subject"].id
        assert route.route == ROUTE_SPEAKER
        assert route.unresolved_reason is None
        assert route.via_facilitator is False

    def test_a_document_segment_resolves_through_the_document(self, corpus):
        """Row 46's grain: the subject sits on the DOCUMENT, not on a speaker.

        Document segments have `speaker_id` NULL, so a resolver that reached for
        the speaker here would report "no speaker" for every one of them.
        """
        route = _resolve_all(corpus).segments[corpus["doc_seg"].id]
        assert route.participant_id == corpus["subject"].id
        assert route.route == ROUTE_DOCUMENT
        assert route.unresolved_reason is None

    def test_a_dataset_cell_resolves_through_its_row(self, corpus):
        route = _resolve_all(corpus).dataset_values[corpus["cell"].id]
        assert route.participant_id == corpus["decoy"].id
        assert route.route == ROUTE_DATASET_ROW
        assert route.unresolved_reason is None

    def test_one_participant_is_reached_by_two_routes(self, corpus):
        """E-01's case in the working corpus: a workplan AND her own turns.

        Both must name the SAME participant, or the rollup pools two people.
        """
        resolution = _resolve_all(corpus)
        turn = resolution.segments[corpus["turn"].id]
        doc = resolution.segments[corpus["doc_seg"].id]
        assert turn.participant_id == doc.participant_id == corpus["subject"].id
        assert turn.route != doc.route


class TestReachingNobody:
    def test_a_clip_reaches_nobody_and_says_it_is_a_clip(self, corpus):
        """Decision 4: excluded AND disclosed. `Observation` has no participant
        link at all, so this is structural — not an unlinked recording."""
        route = _resolve_all(corpus).segments[corpus["clip"].id]
        assert route.participant_id is None
        assert route.route == ROUTE_OBSERVATION
        assert route.unresolved_reason == UNRESOLVED_OBSERVATION_CLIP

    def test_the_five_reasons_are_distinct(self, corpus):
        """The whole point of the vocabulary: five causes, five remedies.

        Collapsing any pair makes the disclosure useless — "map your speakers"
        and "link this document" are different instructions to the researcher,
        and neither is what a clip needs.
        """
        resolution = _resolve_all(corpus)
        reasons = {
            corpus["clip"].id: UNRESOLVED_OBSERVATION_CLIP,
            corpus["untagged_turn"].id: UNRESOLVED_NO_SPEAKER,
            corpus["unlinked_turn"].id: UNRESOLVED_SPEAKER_UNLINKED,
            corpus["orphan_doc_seg"].id: UNRESOLVED_DOCUMENT_UNLINKED,
        }
        for segment_id, expected in reasons.items():
            route = resolution.segments[segment_id]
            assert route.participant_id is None
            assert route.unresolved_reason == expected
        unlinked_cell = resolution.dataset_values[corpus["unlinked_cell"].id]
        assert unlinked_cell.unresolved_reason == UNRESOLVED_ROW_UNLINKED
        assert len(set(reasons.values()) | {UNRESOLVED_ROW_UNLINKED}) == 5

    def test_a_reason_and_a_participant_are_a_pair(self, corpus):
        """Never both, never neither — the invariant the dataclass documents."""
        resolution = _resolve_all(corpus)
        for routes in (resolution.segments, resolution.dataset_values):
            for route in routes.values():
                assert (route.participant_id is None) == (
                    route.unresolved_reason is not None
                )

    def test_every_reason_emitted_is_in_the_declared_vocabulary(self, corpus):
        """A client renders these; an unknown value renders nothing."""
        resolution = _resolve_all(corpus)
        for routes in (resolution.segments, resolution.dataset_values):
            for route in routes.values():
                if route.unresolved_reason is not None:
                    assert route.unresolved_reason in pr.UNRESOLVED_REASONS
                assert route.route in {
                    ROUTE_SPEAKER, ROUTE_DOCUMENT, ROUTE_DATASET_ROW, ROUTE_OBSERVATION,
                }


class TestTheFactsThatRideAlongside:
    def test_a_facilitator_turn_resolves_but_is_flagged(self, corpus):
        """The fact `coding_counts._participant_predicate` exists to express.

        The link is real — a facilitator may be a participant — so the resolver
        reports it and does NOT decide. The rollup excludes these explicitly;
        without the flag it would have to re-derive the Speaker join to know.
        """
        route = _resolve_all(corpus).segments[corpus["facilitator_turn"].id]
        assert route.participant_id == corpus["host"].id
        assert route.via_facilitator is True

    def test_via_facilitator_is_false_off_the_speaker_route(self, corpus):
        """A document has no facilitator to exclude — applying the
        conversation's filter there drops every document segment (row 46)."""
        resolution = _resolve_all(corpus)
        assert resolution.segments[corpus["doc_seg"].id].via_facilitator is False
        assert resolution.segments[corpus["clip"].id].via_facilitator is False
        assert resolution.dataset_values[corpus["cell"].id].via_facilitator is False

    def test_a_merged_away_segment_reports_its_link_and_its_invisibility(self, corpus):
        """#500: its codings are unreachable in the UI, so an aggregate must not
        count them — but the person it belonged to is still a fact."""
        route = _resolve_all(corpus).segments[corpus["merged_turn"].id]
        assert route.participant_id == corpus["subject"].id
        assert route.target_visible is False
        assert _resolve_all(corpus).segments[corpus["turn"].id].target_visible is True

    def test_a_dataset_cell_is_always_visible(self, corpus):
        assert _resolve_all(corpus).dataset_values[corpus["cell"].id].target_visible


class TestScopingAndAbsence:
    def test_another_projects_segment_is_absent_not_unresolved(self, corpus):
        """The security property AND the semantic one in one assertion.

        Absent means "I could not resolve that at all"; a present entry with no
        participant means "this target reaches nobody". A foreign id resolving
        to `None` would read as an unlinked speaker in this project.
        """
        resolution = _resolve_all(corpus)
        assert corpus["foreign_turn"].id not in resolution.segments
        # Non-vacuous: the same id DOES resolve under its own project.
        other = resolve_participants(
            corpus["db"], 2, segment_ids=[corpus["foreign_turn"].id]
        )
        assert other.segments[corpus["foreign_turn"].id].participant_id is not None

    def test_an_unknown_id_is_absent(self, corpus):
        resolution = resolve_participants(corpus["db"], 1, segment_ids=[999_999])
        assert resolution.segments == {}

    def test_a_foreign_dataset_cell_is_absent(self, corpus):
        """The value grain scopes through `Dataset.project_id`, not the row."""
        resolution = resolve_participants(
            corpus["db"], 2, dataset_value_ids=[corpus["cell"].id]
        )
        assert resolution.dataset_values == {}

    def test_nothing_asked_is_nothing_queried(self, corpus):
        resolution = resolve_participants(corpus["db"], 1)
        assert resolution.segments == {} and resolution.dataset_values == {}


class TestTheBatchApi:
    def test_for_target_dispatches_the_xor(self, corpus):
        resolution = _resolve_all(corpus)
        assert resolution.for_target(
            segment_id=corpus["turn"].id
        ).participant_id == corpus["subject"].id
        assert resolution.for_target(
            dataset_value_id=corpus["cell"].id
        ).participant_id == corpus["decoy"].id
        assert resolution.for_target(segment_id=999_999) is None

    @pytest.mark.parametrize("kwargs", [
        {},
        {"segment_id": 1, "dataset_value_id": 2},
    ])
    def test_for_target_refuses_a_malformed_target(self, corpus, kwargs):
        """Both states are wiring bugs, not user input — fail closed, loudly."""
        with pytest.raises(ValueError, match="exactly one"):
            _resolve_all(corpus).for_target(**kwargs)

    def test_resolve_for_applications_collects_both_grains(self, corpus):
        """The ergonomic door: hand it the rows, not two id lists."""
        class _App:
            def __init__(self, segment_id=None, dataset_value_id=None):
                self.segment_id = segment_id
                self.dataset_value_id = dataset_value_id

        resolution = resolve_for_applications(corpus["db"], 1, [
            _App(segment_id=corpus["turn"].id),
            _App(segment_id=corpus["doc_seg"].id),
            _App(dataset_value_id=corpus["cell"].id),
        ])
        assert resolution.participant_ids() == {
            corpus["subject"].id, corpus["decoy"].id
        }

    def test_unresolved_counts_is_the_disclosure(self, corpus):
        counts = _resolve_all(corpus).unresolved_counts()
        assert counts == {
            UNRESOLVED_OBSERVATION_CLIP: 1,
            UNRESOLVED_NO_SPEAKER: 1,
            UNRESOLVED_SPEAKER_UNLINKED: 1,
            UNRESOLVED_DOCUMENT_UNLINKED: 1,
            UNRESOLVED_ROW_UNLINKED: 1,
        }

    def test_participant_ids_pools_both_grains_and_dedupes(self, corpus):
        """The subject is reached twice; she is one person in the result."""
        ids = _resolve_all(corpus).participant_ids()
        assert ids == {corpus["subject"].id, corpus["decoy"].id, corpus["host"].id}

    def test_chunking_does_not_change_the_answers(self, corpus, monkeypatch):
        """#842's ceiling is handled by chunking, and a chunk boundary is
        exactly where a batched lookup silently drops rows. Nine segments over
        a chunk of two is four boundaries."""
        full = _resolve_all(corpus)
        monkeypatch.setattr(pr, "_ID_CHUNK", 2)
        chunked = _resolve_all(corpus)
        assert chunked == full
        assert len(chunked.segments) == 8  # the foreign turn is correctly absent


class TestEveryParticipantFkHasARoute:
    """The enumeration, derived from the schema instead of remembered.

    Same rule as `test_withdrawal_report.py::TestEveryParticipantFkHasAnArm`,
    and deliberately a SECOND copy of the reflection rather than a shared
    helper: the two consumers answer opposite questions (participant → data,
    data → participant) and a fourth link must fail in both places with its own
    instructions. `withdrawal_redaction.py` is the third.
    """

    def _participant_fks(self):
        from app.database import Base
        found = set()
        for table in Base.metadata.tables.values():
            for col in table.columns:
                for fk in col.foreign_keys:
                    if fk.column.table.name == "participants":
                        found.add((table.name, col.name))
        return found

    def test_the_walk_finds_the_known_links(self):
        """Population self-check (#729/#730). A reflection that resolves to
        nothing passes an `== expected` test whenever `expected` is empty too."""
        found = self._participant_fks()
        assert len(found) >= 3, (
            f"the FK walk found {len(found)} links to `participants.id` — it has "
            "gone blind; three are known to exist"
        )

    def test_every_fk_to_participants_has_a_route(self):
        found = self._participant_fks()
        missing = found - set(pr.PARTICIPANT_FK_ROUTES)
        assert not missing, (
            f"{sorted(missing)} name(s) `participants.id` with no route in "
            "participant_resolution.PARTICIPANT_FK_ROUTES. A new link means a "
            "new arm in `resolve_participants` AND a new unresolved reason — "
            "plus `withdrawal_report.py` and `withdrawal_redaction.py`."
        )
        stale = set(pr.PARTICIPANT_FK_ROUTES) - found
        assert not stale, f"{sorted(stale)} no longer exist in the schema"


class TestEverySegmentParentHasARoute:
    """A fourth `Segment` parent must not silently resolve to nobody.

    `segment_operations._PARENT_FK` is the map a new parent has to touch (it is
    what dispatches every merge/split), so it is the artifact this pins against
    — not a list of the three that exist today.
    """

    def _parent_columns(self):
        from app.services.segment_operations import _PARENT_FK
        return set(_PARENT_FK.values())

    def test_the_parent_map_is_populated(self):
        assert len(self._parent_columns()) >= 3

    def test_every_segment_parent_has_a_route(self):
        parents = self._parent_columns()
        assert parents == set(pr.SEGMENT_PARENT_ROUTES), (
            "segment parents and participant routes disagree: "
            f"{sorted(parents ^ set(pr.SEGMENT_PARENT_ROUTES))}. Add the parent "
            "to participant_resolution.SEGMENT_PARENT_ROUTES and give it a "
            "branch in `_segment_route`."
        )

    def test_a_parentless_segment_raises_rather_than_reaching_nobody(self):
        """The fail-closed half. `ck_segment_exactly_one_parent` makes this
        unreachable through the DB, so the only route here is a fourth parent
        added without widening the branch — which must be loud, because a
        silent 'reaches nobody' shrinks every score with no error."""
        with pytest.raises(ValueError, match="SEGMENT_PARENT_ROUTES"):
            pr._segment_route(
                conversation_id=None, document_id=None, observation_id=None,
                speaker_id=None, speaker_participant_id=None, is_facilitator=None,
                document_participant_id=None, visible=True,
            )
