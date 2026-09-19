"""#35 variant B — the rating sweep's work queue (`services/rating_queue.py`).

Scope: which applications reach the queue, at what GRAIN, and in what order.
The commit half is unchanged (`test_magnitude_coding.py` owns it); this file is
entirely about the read path the sweep surface is built on.

🔴 **The fixture scale is −1…+1, so ZERO is interior.** The queue's whole job is
to list applications that carry no rating, and the difference between *unrated*
and *rated zero* is the headline rule of this feature. On a 0–10 scale a
`magnitude IS NULL` filter and a truthiness slip agree about almost every row,
because 0 sits on the boundary and reads as "nothing there". On −1…+1 a rating
of zero is a real, meaningful judgement ("neither"), so the two implementations
produce DIFFERENT queues and the test can tell them apart. The degenerate-fixture
rule, applied to the axis this module actually turns on.

⚠️ **The colleague is user id 2 and the caller is user id 1**, which is the
opposite of the arrangement `test_a_rating_NEVER_touches_a_COLLEAGUES_application`
requires — deliberately, because the hazard here is the mirror image. That test
guards a WRITE that could pick the lowest id by luck; this file guards a READ
whose filter is `user_id == caller`, where a caller who is the lowest id would
make an unscoped query look correct. Both fixtures exist to break the luck.
"""

import pytest
from fastapi import HTTPException

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.user import User
from app.routers.coding import get_rating_queue
from app.services.coding_layers import CONSENSUS_ORIGIN
from app.services.rating_queue import DEFAULT_QUEUE_LIMIT, build_rating_queue

PID = 950
SELF = 1
COLLEAGUE = 2
CONSENSUS_USER = 3

SCALED = 951        # −1…+1, the code everything in the queue carries
NO_SCALE = 952
UNIVERSAL = 953     # hand-given a scale: the clause must still exclude it
INACTIVE = 954      # scaled but retired
FLOOR_ONLY = 956    # a min and no max — reachable only by hand-editing
CEILING_ONLY = 957  # the mirror: a max and no min


@pytest.fixture
def multiuser_on():
    """Flip the gate on the cached Settings singleton (the house pattern)."""
    from app.config import get_settings
    settings = get_settings()
    original = settings.mm_multiuser_auth_enabled
    settings.mm_multiuser_auth_enabled = True
    yield
    settings.mm_multiuser_auth_enabled = original


@pytest.fixture
def corpus(db_session):
    """One project with all four source kinds and every exclusion planted."""
    db = db_session
    # ⚠️ Staged, not one `add_all`. The unit of work orders inserts by table
    # dependency, and `segment_groups` → `conversations` came out ahead of the
    # conversation itself under `PRAGMA foreign_keys=ON`. Flushing each layer
    # is what makes the fixture's own shape explicit.
    db.add_all([
        Project(id=PID, name="Sweep", user_id=SELF),
        User(id=COLLEAGUE, username="colleague", password_hash=None),
        User(id=CONSENSUS_USER, username="consensus", password_hash=None,
             coder_type="consensus"),
    ])
    db.flush()
    db.add_all([
        Conversation(id=PID, project_id=PID, name="Interview one"),
        Document(id=PID, project_id=PID, name="Workplan",
                 source_filename="workplan.docx", source_format="docx"),
        Observation(id=PID, project_id=PID, name="Session tape"),
        Dataset(id=PID, project_id=PID, name="Staff survey"),
    ])
    db.flush()
    db.add_all([
        SegmentGroup(id=PID, conversation_id=PID),
        DatasetColumn(id=PID, dataset_id=PID, column_text="What changed?",
                      column_name="changed", column_type=ColumnType.OPEN_TEXT,
                      sequence_order=0),
        DatasetRow(id=PID, dataset_id=PID, row_identifier="R0007"),
    ])
    db.flush()
    db.add_all([
        # A lone conversation segment.
        Segment(id=9500, conversation_id=PID, sequence_order=0, text="alone"),
        # Two segments coded as ONE unit — the group collapse case.
        Segment(id=9501, conversation_id=PID, sequence_order=1, text="first half",
                group_id=PID),
        Segment(id=9502, conversation_id=PID, sequence_order=2, text="second half",
                group_id=PID),
        # Merged away: UI-unreachable, so nothing on it can be rated (#500).
        Segment(id=9503, conversation_id=PID, sequence_order=3, text="gone",
                merged_into_id=9500),
        Segment(id=9510, document_id=PID, sequence_order=0, text="a paragraph"),
        Segment(id=9520, observation_id=PID, sequence_order=0, text="clip label",
                start_time=12.0, end_time=20.0),

        Code(id=SCALED, project_id=PID, name="District support", numeric_id=2,
             is_active=True, is_universal=False,
             magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
        Code(id=NO_SCALE, project_id=PID, name="Pacing", numeric_id=3,
             is_active=True, is_universal=False),
        Code(id=UNIVERSAL, project_id=PID, name="Unclear", numeric_id=1,
             is_active=True, is_universal=True,
             magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
        Code(id=INACTIVE, project_id=PID, name="Retired", numeric_id=4,
             is_active=False, is_universal=False,
             magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
        # 🔴 HALF a scale — a floor and no ceiling. `normalize_scale` cannot
        # produce this; a hand-edited database can. It exists in the fixture
        # because a code with NEITHER bound is excluded by either clause of the
        # pair on its own, so it cannot tell them apart (mutant 7 survived on
        # exactly that degeneracy).
        # ⚠️ ONE PER ARM. `magnitude_min` and `magnitude_max` are a pair, and a
        # fixture missing only one of them is caught by the OTHER clause — so a
        # single half-declared code kills one mutant and lets its mirror live
        # (#709: a rule with two arms needs a fixture per arm).
        Code(id=FLOOR_ONLY, project_id=PID, name="Floor only", numeric_id=6,
             is_active=True, is_universal=False,
             magnitude_min=-1.0, magnitude_max=None, magnitude_step=0.5),
        Code(id=CEILING_ONLY, project_id=PID, name="Ceiling only", numeric_id=7,
             is_active=True, is_universal=False,
             magnitude_min=None, magnitude_max=1.0, magnitude_step=0.5),

        DatasetValue(id=PID, row_id=PID, column_id=PID, value_text="a free answer"),
    ])
    db.flush()
    return db


def _apply(db, *, segment=None, value=None, code=SCALED, user=SELF,
           magnitude=None, origin="human"):
    db.add(CodeApplication(
        segment_id=segment, dataset_value_id=value, code_id=code,
        user_id=user, magnitude=magnitude, origin=origin,
    ))


def _queue(db, **kw):
    return build_rating_queue(db, PID, SELF, **kw)


def _codes_in(queue):
    return [e.code_id for e in queue.entries]


# ───────────────────────── 1. what reaches the queue ───────────────────────────

class TestTheFiveFilters:
    def test_an_unrated_application_on_a_scaled_code_is_queued(self, corpus):
        _apply(corpus, segment=9500)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.total == 1
        assert [e.segment_id for e in queue.entries] == [9500]
        assert queue.entries[0].code_name == "District support"
        assert queue.entries[0].scale["min"] == -1.0

    def test_a_rating_of_ZERO_is_rated_and_leaves_the_queue(self, corpus):
        """🔴 The falsy-zero case, and the reason the fixture is bipolar.

        Zero is a legal, meaningful rating on −1…+1 ("neither"). A filter
        written as a truthiness test rather than `IS NULL` puts this row back
        in the work list, telling the coder to rate a passage they have already
        judged — and, if they comply, overwriting that judgement.
        """
        _apply(corpus, segment=9500, magnitude=0.0)
        _apply(corpus, segment=9501, magnitude=None)
        corpus.flush()
        queue = _queue(corpus)
        assert [e.segment_id for e in queue.entries] == [9501]
        assert queue.total == 1

    def test_a_COLLEAGUES_unrated_application_is_never_queued(self, corpus):
        """Own applications only — the design call of 2026-09-12.

        The commit endpoint filters on the caller, so a colleague's row is not
        merely private, it is unratable: queuing it offers a control whose
        every commit 404s.
        """
        _apply(corpus, segment=9500, user=COLLEAGUE)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_an_UNATTRIBUTED_application_is_never_queued(self, corpus):
        """`user_id` is nullable — merged legacy data carries such rows.

        No door rates them, on any surface, so a naive "unrated applications"
        query would fill the queue with work nobody can do (the #806 shape).
        """
        _apply(corpus, segment=9500, user=None)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_a_code_with_no_declared_scale_is_never_queued(self, corpus):
        _apply(corpus, segment=9500, code=NO_SCALE)
        corpus.flush()
        assert _queue(corpus).total == 0

    @pytest.mark.parametrize("half", [FLOOR_ONLY, CEILING_ONLY])
    def test_a_HALF_declared_scale_is_excluded_from_the_COUNT_too(self, corpus, half):
        """🔴 Both bounds are required TOGETHER, and the count is where it shows.

        `has_scale` requires a min AND a max: a floor with no ceiling has no
        range to normalise against, so `read_scale` returns None and hydration
        drops the entry. If only one of the two clauses guarded the query, the
        row would still be COUNTED — the queue would report work outstanding
        and hand back an empty list, which reads as a broken screen rather than
        as a malformed code.

        ⚠️ **Parametrized over BOTH halves, and that is not tidiness.** The
        both-bounds-null code cannot see this at all (either clause excludes it
        alone), and a single half-declared code kills only the mutant that
        drops the OTHER clause. Measured: with `FLOOR_ONLY` alone, deleting the
        `magnitude_min` guard left the whole file green.
        """
        _apply(corpus, segment=9500, code=half)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.entries == ()
        assert queue.total == 0, "counted a code whose instrument cannot render"
        assert queue.per_code == ()

    def test_a_UNIVERSAL_code_is_never_queued_even_holding_a_scale(self, corpus):
        """`scale_refusal` refuses to declare one, so this state is only
        reachable by a hand-edited database — and a rating on the artifact row
        would silently never reach a statistic."""
        _apply(corpus, segment=9500, code=UNIVERSAL)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_an_INACTIVE_code_is_never_queued(self, corpus):
        """`validate_value` refuses a new rating on a retired code."""
        _apply(corpus, segment=9500, code=INACTIVE)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_a_MERGED_AWAY_segment_is_never_queued(self, corpus):
        _apply(corpus, segment=9503)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_a_CONSENSUS_row_is_never_queued(self, corpus):
        """The consensus median is DERIVED — nobody rates it directly.

        🔴 **The fixture owns the row to the CALLER, and that is deliberate
        even though the state is unreachable in production.** A real consensus
        row belongs to the global system coder, so the `user_id == caller`
        filter already excludes it — which means the realistic fixture cannot
        tell whether `non_consensus_filter()` is doing anything, and the clause
        would survive its own deletion (the belt-and-braces case the mutation
        rule warns about). Owning it to the caller is what makes the chokepoint
        observable. The clause is kept rather than deleted because a
        `.mmproject` import, a merge or legacy data are the paths that could
        put a human id on a derived row, and offering one to be rated would
        have the next recompute silently overwrite the judgement.
        """
        _apply(corpus, segment=9500, user=SELF, origin=CONSENSUS_ORIGIN)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_the_system_coders_own_consensus_row_is_excluded_twice_over(self, corpus):
        """The realistic shape, kept as a positive control for the fixture above."""
        _apply(corpus, segment=9500, user=CONSENSUS_USER, origin=CONSENSUS_ORIGIN)
        corpus.flush()
        assert _queue(corpus).total == 0

    def test_another_projects_application_is_never_queued(self, corpus):
        db = corpus
        db.add_all([
            Project(id=951, name="Other", user_id=SELF),
            Conversation(id=951, project_id=951, name="Elsewhere"),
            Segment(id=9590, conversation_id=951, sequence_order=0, text="x"),
            Code(id=959, project_id=951, name="Support", numeric_id=2,
                 is_active=True, is_universal=False,
                 magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
        ])
        db.flush()
        _apply(db, segment=9590, code=959)
        db.flush()
        assert _queue(db).total == 0


# ───────────────────────── 2. the grain is the rating ACT ──────────────────────

class TestTheGrainIsTheRatingAct:
    def test_a_coded_GROUP_is_ONE_entry_covering_both_segments(self, corpus):
        """🔴 `_fan_out_rating` writes across every visible sibling of a group.

        A per-application queue would list this judgement twice, keep showing
        the sibling as unrated after one press had rated it, and drop its
        remaining count by two for one act.
        """
        _apply(corpus, segment=9501)
        _apply(corpus, segment=9502)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.total == 1
        (entry,) = queue.entries
        assert entry.n_targets == 2
        assert entry.segment_id in (9501, 9502)

    def test_a_group_and_a_lone_segment_do_not_collide_on_id(self, corpus):
        """⚠️ `group_id` and `segment_id` are different id spaces.

        Here the group's id and a lone segment's id are deliberately unequal
        but both live; a single COALESCE'd bucket key would still be wrong in
        general, so the two are separate GROUP BY columns. This pins that a
        lone segment never merges into a group's bucket.
        """
        _apply(corpus, segment=9500)
        _apply(corpus, segment=9501)
        _apply(corpus, segment=9502)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.total == 2
        by_target = {e.segment_id: e.n_targets for e in queue.entries}
        assert by_target[9500] == 1
        assert sorted(by_target.values()) == [1, 2]

    def test_two_codes_on_one_group_are_two_entries(self, corpus):
        """The bucket is `(code, group)`: two instruments, two judgements."""
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Clarity", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9501)
        _apply(db, segment=9502)
        _apply(db, segment=9501, code=955)
        _apply(db, segment=9502, code=955)
        db.flush()
        queue = _queue(db)
        assert queue.total == 2
        assert sorted(_codes_in(queue)) == [SCALED, 955]
        assert all(e.n_targets == 2 for e in queue.entries)

    def test_a_group_whose_sibling_is_already_rated_still_counts_once(self, corpus):
        """Only the unrated member is in the bucket, and the entry still covers
        one rating act — `n_targets` describes the QUERY's rows, so it reports
        one here rather than claiming a reach the queue cannot see."""
        _apply(corpus, segment=9501, magnitude=0.5)
        _apply(corpus, segment=9502, magnitude=None)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.total == 1
        assert queue.entries[0].n_targets == 1


# ───────────────────────── 3. all four source kinds ────────────────────────────

class TestEverySourceKind:
    def test_all_four_kinds_are_queued_and_labelled(self, corpus):
        _apply(corpus, segment=9500)
        _apply(corpus, segment=9510)
        _apply(corpus, segment=9520)
        _apply(corpus, value=PID)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.total == 4
        by_type = {e.source_type: e for e in queue.entries}
        assert set(by_type) == {"conversation", "document", "observation", "column"}
        assert by_type["conversation"].source_label == "Interview one"
        assert by_type["document"].source_label == "Workplan"
        assert by_type["observation"].source_label == "Session tape"
        assert by_type["column"].source_label == "Staff survey › changed"

    def test_a_dataset_cell_carries_its_record_and_no_segment(self, corpus):
        """The two arms commit through DIFFERENT endpoints, so the entry has to
        say which — and exactly one target id is set, matching the CHECK."""
        _apply(corpus, value=PID)
        corpus.flush()
        (entry,) = _queue(corpus).entries
        assert entry.target_kind == "dataset_value"
        assert entry.dataset_value_id == PID
        assert entry.segment_id is None
        assert entry.record_identifier == "R0007"
        assert entry.text == "a free answer"

    def test_a_clip_carries_its_time_range(self, corpus):
        """A clip's identity to a researcher is its range — `Segment.text`
        holds only a label there, routinely empty."""
        _apply(corpus, segment=9520)
        corpus.flush()
        (entry,) = _queue(corpus).entries
        assert entry.target_kind == "segment"
        assert (entry.start_time, entry.end_time) == (12.0, 20.0)

    def test_segments_are_presented_before_dataset_cells(self, corpus):
        _apply(corpus, value=PID)
        _apply(corpus, segment=9500)
        corpus.flush()
        kinds = [e.target_kind for e in _queue(corpus).entries]
        assert kinds == ["segment", "dataset_value"]

    def test_conversations_sort_before_documents_and_clips(self, corpus):
        """🔴 The parent is a grouping column, not `MIN(conversation_id)`.

        Under the aggregate form SQLite sorts the NULL parents first, so this
        order came out reversed — documents and clips ahead of conversations —
        while the code read as source-major.
        """
        _apply(corpus, segment=9520)
        _apply(corpus, segment=9510)
        _apply(corpus, segment=9500)
        corpus.flush()
        assert [e.source_type for e in _queue(corpus).entries] == [
            "conversation", "document", "observation",
        ]


# ───────────────────────── 4. what the window says about itself ────────────────

class TestTotalsAndWindow:
    def test_total_counts_the_whole_queue_while_entries_are_a_window(self, corpus):
        for seq, sid in enumerate(range(9530, 9535)):
            corpus.add(Segment(id=sid, conversation_id=PID,
                               sequence_order=10 + seq, text=f"s{sid}"))
        corpus.flush()
        for sid in range(9530, 9535):
            _apply(corpus, segment=sid)
        corpus.flush()
        queue = _queue(corpus, limit=2)
        assert queue.total == 5
        assert len(queue.entries) == 2
        assert queue.truncated is True

    def test_an_untruncated_queue_says_so(self, corpus):
        _apply(corpus, segment=9500)
        corpus.flush()
        queue = _queue(corpus)
        assert queue.truncated is False

    def test_per_code_counts_both_arms_at_the_collapsed_grain(self, corpus):
        """Per-code coverage is the number that matters: thin ratings on ONE
        code are what make that code's agreement figure misleading, and a
        single global percentage hides it."""
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Clarity", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9501)          # grouped, collapses with the next
        _apply(db, segment=9502)
        _apply(db, segment=9500, code=955)
        _apply(db, value=PID, code=955)   # the dataset arm counts too
        db.flush()
        queue = _queue(db)
        assert [(c.code_id, c.code_name, c.outstanding) for c in queue.per_code] == [
            (955, "Clarity", 2), (SCALED, "District support", 1),
        ], "named, and most-outstanding first"
        assert queue.total == 3

    def test_per_code_names_a_code_with_NOTHING_in_the_returned_batch(self, corpus):
        """🔴 The counts span the QUEUE; `entries` is one BATCH.

        A client naming these chips from `entries` labels them with a bare id
        for every code the window happens to exclude — and does so exactly when
        the queue is long enough for a per-code filter to be worth having. The
        limit here is 1, so the second code has no entry to be named from.
        """
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Clarity", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9500)              # District support
        _apply(db, segment=9510, code=955)    # Clarity — outside a 1-entry window
        db.flush()
        queue = _queue(db, limit=1)
        assert len(queue.entries) == 1
        assert _codes_in(queue) == [SCALED]
        named = {c.code_id: c.code_name for c in queue.per_code}
        assert named == {SCALED: "District support", 955: "Clarity"}

    def test_per_code_ties_break_on_NAME_so_the_chip_order_is_stable(self, corpus):
        """Two requests returning the same numbers must return the same order;
        dict order would otherwise leak the query plan into the interface."""
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Aardvark", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9500)
        _apply(db, segment=9510, code=955)
        db.flush()
        assert [c.code_name for c in _queue(db).per_code] == [
            "Aardvark", "District support",
        ]

    def test_the_code_filter_narrows_entries_and_total(self, corpus):
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Clarity", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9500)
        _apply(db, segment=9510, code=955)
        db.flush()
        queue = _queue(db, code_id=955)
        assert queue.total == 1
        assert _codes_in(queue) == [955]

    def test_the_filter_narrows_the_QUEUE_and_never_the_PICKER(self, corpus):
        """🔴 #979 — `per_code` spans the whole queue whatever `code_id` says.

        It is the picker. Narrowed to its own selection it lists only the code
        already chosen, so there is nothing to switch to; and once that code is
        worked to zero it empties, which on the client takes the whole chip row
        — and with it the "All codes" way out — off the screen.

        ⚠️ The fixture must give the OTHER code work too, or a narrowed and an
        unnarrowed `per_code` are the same tuple and this assertion passes
        against the defect (the degenerate-fixture rule: the filtered and
        unfiltered answers have to DISAGREE).
        """
        db = corpus
        db.add(Code(id=955, project_id=PID, name="Clarity", numeric_id=5,
                    is_active=True, is_universal=False,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        _apply(db, segment=9500)               # SCALED — "District support"
        _apply(db, segment=9510, code=955)     # 955 — "Clarity"
        db.flush()

        scoped = _queue(db, code_id=955)
        assert scoped.total == 1, "the QUEUE is still narrowed"
        assert _codes_in(scoped) == [955]
        # Ties break on NAME (`_name_code_counts`), so "Clarity" precedes
        # "District support" — both carry one outstanding act.
        assert [(c.code_id, c.outstanding) for c in scoped.per_code] == [
            (955, 1), (SCALED, 1),
        ], "the PICKER still lists every code with work"

        # And it is the same tuple the unfiltered call returns, which is what
        # lets the client read `sum(outstanding)` as the all-codes total.
        assert scoped.per_code == _queue(db).per_code

    def test_the_limit_is_clamped_rather_than_trusted(self, corpus):
        """A hand-built request must not be able to ask for the whole table."""
        from app.services.rating_queue import MAX_QUEUE_LIMIT
        _apply(corpus, segment=9500)
        corpus.flush()
        assert _queue(corpus, limit=10_000).total == 1
        assert _queue(corpus, limit=0).total == 1
        assert MAX_QUEUE_LIMIT >= DEFAULT_QUEUE_LIMIT

    def test_an_empty_queue_is_empty_rather_than_absent(self, corpus):
        queue = _queue(corpus)
        assert queue.entries == ()
        assert queue.total == 0
        assert queue.truncated is False
        assert queue.per_code == ()


# ───────────────────────── 5. the endpoint ─────────────────────────────────────

class TestTheEndpoint:
    """⚠️ Entered at the ROUTER, not the service.

    The service is exercised above; what only the endpoint can prove is that
    the ownership gate is reached and that every field the service writes is
    declared on the response schema. Under pytest `app.schemas` runs with
    `extra='forbid'` (#855), so a key the service emits and the schema does not
    declare raises here instead of being dropped silently on the wire — the
    defect that hid `MergeReport.magnitude_conflicts` for a release cycle.
    """

    def test_the_queue_reaches_the_wire_with_every_field(self, corpus):
        _apply(corpus, segment=9520)
        _apply(corpus, value=PID)
        corpus.flush()
        out = get_rating_queue(PID, user=corpus.get(User, SELF), db=corpus)
        assert out.total == 2
        assert out.truncated is False
        assert [(c.code_id, c.code_name, c.outstanding) for c in out.per_code] == [
            (SCALED, "District support", 2),
        ]
        clip = next(e for e in out.entries if e.target_kind == "segment")
        assert clip.source_label == "Session tape"
        assert clip.scale["anchors"] == []
        assert clip.n_targets == 1

    def test_the_code_filter_rides_the_endpoint(self, corpus):
        _apply(corpus, segment=9500)
        corpus.flush()
        assert get_rating_queue(PID, code_id=NO_SCALE,
                                user=corpus.get(User, SELF), db=corpus).total == 0
        assert get_rating_queue(PID, code_id=SCALED,
                                user=corpus.get(User, SELF), db=corpus).total == 1

    def test_an_unknown_project_404s(self, corpus):
        """The gate is REACHED. `build_rating_queue` is scoped by `project_id`
        and would return a cheerful empty queue for a project that does not
        exist — an empty result and a refusal are different answers.
        """
        with pytest.raises(HTTPException) as exc:
            get_rating_queue(424242, user=corpus.get(User, SELF), db=corpus)
        assert exc.value.status_code == 404

    def test_a_colleague_shares_the_queue_in_LOCAL_ROSTER_mode(self, corpus):
        """⚠️ Two-sided, because the regression that would actually hurt users
        is the wrong one.

        `MM_MULTIUSER_AUTH_ENABLED` is OFF by default and the roster shares
        every project, so a colleague opening the sweep must get a queue — of
        THEIR OWN unrated work, which is the filter's job rather than the
        gate's. Asserting only the refusal below would let a gate that refuses
        everybody pass.
        """
        _apply(corpus, segment=9500, user=COLLEAGUE)
        corpus.flush()
        out = get_rating_queue(PID, user=corpus.get(User, COLLEAGUE), db=corpus)
        assert out.total == 1
        # ...and the caller's own queue is empty, because that row is not theirs.
        assert get_rating_queue(PID, user=corpus.get(User, SELF), db=corpus).total == 0

    def test_another_users_project_404s_under_MULTIUSER(self, corpus, multiuser_on):
        db = corpus
        db.add(User(id=77, username="stranger", password_hash=None))
        db.flush()
        with pytest.raises(HTTPException) as exc:
            get_rating_queue(PID, user=db.get(User, 77), db=db)
        assert exc.value.status_code == 404
