"""A coverage figure counts PEOPLE's coding, on every surface that states one (#1029).

#989 made a machine coder a layer and routed every gauge in `coding_counts` through
`layer_scope_filter()`, whose default (human) arm drops the derived consensus layer
AND a machine's labels. Seven count surfaces never reached that module: they filtered
`non_consensus_filter()` only, which KEEPS the machine. A model that labelled a whole
open-text column therefore made the Text Coding gauge read 100% while the Overview
said 0% — `multicoder.md`'s own rule ("a machine cannot inflate a coverage gauge")
false outside the one module that named it.

The audit named three sites (all in `routers/text_coding.py`); enumerating by what a
query COUNTS found four more: the analysis page's per-column "N coded", the
conversation reader's `coded_count` (an in-memory copy of the predicate that tested
`origin` only), and the conversation and observation cards' "N codes".

🔴 **Every fixture is built so the OLD filter and the NEW one give different answers**
— a machine-only unit and a code only the machine applied — and each keeps an
UNATTRIBUTED application (legacy, `user_id IS NULL`) that must still count: the NULL
arm of `without_machine_filter()` is the silent half of this rule (`multicoder.md`),
and a bare `NOT IN` would drop it only once a machine coder exists — as one does here.

The payloads are NOT narrowed: a machine's chips must stay attributable. Only the
COUNT means people. `test_layer_filter_sites.py` is the class guard.
"""
import asyncio

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.conversations import get_conversation, list_conversations
from app.routers.observations import get_observation, list_observations
from app.routers.segments import list_segments
from app.routers.text_coding import coding_progress, list_texts, text_columns
from app.services.code_analysis import get_text_columns_with_coding

PID = 9500
HUMAN = 2
MACHINE = 3
THEME = 9540          # applied by people
MODEL_ONLY = 9541     # applied ONLY by the machine — the card's "N codes" axis
UNCLEAR = 9542        # universal: never makes a unit "coded"
CONV = 9501
DATASET = 9510
COLUMN = 9520
OBS = 9530


@pytest.fixture
def corpus(db_session):
    db = db_session
    db.add_all([
        Project(id=PID, user_id=1, name="Coverage by people"),
        User(id=HUMAN, username="Ana", password_hash=None, coder_type="human"),
        User(id=MACHINE, username="GPT-4o", password_hash=None, coder_type="ai"),
        Code(id=THEME, project_id=PID, name="Theme", numeric_id=1, is_universal=False),
        Code(id=MODEL_ONLY, project_id=PID, name="Model idea", numeric_id=2,
             is_universal=False),
        Code(id=UNCLEAR, project_id=PID, name="Unclear", numeric_id=3, is_universal=True),
        Conversation(id=CONV, project_id=PID, name="Interview"),
        Dataset(id=DATASET, project_id=PID, name="Survey"),
        DatasetColumn(
            id=COLUMN, dataset_id=DATASET, column_code="Q1", column_name="Q1",
            column_text="Open question", column_type=ColumnType.OPEN_TEXT,
            sequence_order=0, display_order=0,
        ),
        Observation(id=OBS, project_id=PID, name="Huddle"),
    ])
    db.flush()

    # ── The transcript: four turns ────────────────────────────────────────────
    # s1 the machine alone · s2 a person · s3 UNATTRIBUTED (legacy) · s4 the
    # consensus layer alone. People's coded turns = s2 + s3 = 2; before = 3.
    for i in range(1, 5):
        db.add(Segment(id=CONV * 10 + i, conversation_id=CONV, text=f"turn {i}",
                       sequence_order=i))
    # ── The column: five answers, the same four shapes plus one uncoded ──────
    for i in range(1, 6):
        db.add(DatasetRow(id=DATASET * 10 + i, dataset_id=DATASET, row_identifier=f"R{i:03d}"))
        db.add(DatasetValue(id=COLUMN * 10 + i, row_id=DATASET * 10 + i, column_id=COLUMN,
                            value_text=f"a substantive answer {i}"))
    # ── The observation: two clips, machine-only and a person ────────────────
    for i in range(1, 3):
        db.add(Segment(id=OBS * 10 + i, observation_id=OBS, text=f"clip {i}",
                       sequence_order=i, start_time=float(i * 10), end_time=float(i * 10 + 5)))
    db.flush()

    def app_(user_id, code_id, *, seg=None, val=None, origin="human"):
        db.add(CodeApplication(segment_id=seg, dataset_value_id=val, code_id=code_id,
                               user_id=user_id, origin=origin))

    for target in ("seg", "val"):
        first = (CONV * 10) if target == "seg" else (COLUMN * 10)
        kw = lambda i: {target: first + i}  # noqa: E731
        app_(MACHINE, MODEL_ONLY, **kw(1))
        app_(MACHINE, THEME, **kw(1))
        app_(HUMAN, THEME, **kw(2))
        app_(HUMAN, UNCLEAR, **kw(2))
        app_(None, THEME, **kw(3))
        app_(None, THEME, origin="consensus", **kw(4))
    app_(MACHINE, MODEL_ONLY, seg=OBS * 10 + 1)
    app_(HUMAN, THEME, seg=OBS * 10 + 2)
    db.flush()
    return db


def _user(db):
    return db.get(User, 1)


class TestTheTextCodingFiguresCountPeople:
    """The three sites the audit named."""

    def test_the_texts_totals(self, corpus):
        page = list_texts(
            project_id=PID, column_ids=str(COLUMN), dataset_ids=None, hide_empty=True,
            record_id=None, search=None, sort_by="column_asc", random_seed=None,
            quoted_only=False, limit=200, offset=0, user=_user(corpus), db=corpus,
        )
        assert (page.coded_texts, page.coded_rows) == (2, 2)
        # The PAYLOAD still carries the machine's chips — attribution, not coverage.
        by_value = {t.dataset_value_id: t for t in page.texts}
        assert {d.user_id for d in by_value[COLUMN * 10 + 1].applied_code_details} == {MACHINE}

    def test_the_column_pickers_n_coded(self, corpus):
        out = asyncio.run(text_columns(project_id=PID, user=_user(corpus), db=corpus))
        assert [c.coded_rows for c in out.columns] == [2]

    def test_the_coding_gauge(self, corpus):
        out = coding_progress(project_id=PID, column_ids=None, user=_user(corpus), db=corpus)
        assert out.overall_texts == {"coded": 2, "total": 5}
        assert out.overall_records == {"coded": 2, "total": 5}
        assert [(c.coded, c.total) for c in out.by_column] == [(2, 5)]

    def test_the_per_coder_breakdown_still_names_the_machine(self, corpus):
        """⚠️ Deliberate: `by_coder` says who did what, attributed — the same split as
        the chips beside a gauge. It is the OVERALL claim that means people."""
        out = coding_progress(project_id=PID, column_ids=None, user=_user(corpus), db=corpus)
        assert {row.user_id: row.coded_texts for row in out.by_coder} == {HUMAN: 1, MACHINE: 1}


class TestTheOtherSurfacesCountPeople:
    """The four the audit did not name, found by what their queries COUNT."""

    def test_the_analysis_pages_per_column_n_coded(self, corpus):
        rows = get_text_columns_with_coding(corpus, PID)
        assert [r["coded_count"] for r in rows] == [2]

    def test_the_conversation_readers_coded_counts(self, corpus):
        out = asyncio.run(list_segments(conversation_id=CONV, user=_user(corpus), db=corpus))
        assert (out.coded_count, out.participant_coded) == (2, 2)
        assert (out.total, out.participant_total) == (4, 4)

    def test_the_conversation_cards_n_codes(self, corpus):
        # People applied Theme and the universal Unclear (the card has always counted
        # distinct codes of any kind); the machine's Model idea is gone. Before: 3.
        listed = asyncio.run(list_conversations(project_id=PID, user=_user(corpus), db=corpus))
        assert [c.code_count for c in listed.conversations] == [2]
        one = asyncio.run(get_conversation(
            project_id=PID, conversation_id=CONV, user=_user(corpus), db=corpus,
        ))
        assert one.code_count == 2
        # …and the coded count on the same card line, which already meant people.
        assert one.coded_segment_count == 2

    def test_the_observation_cards_n_codes(self, corpus):
        listed = asyncio.run(list_observations(project_id=PID, user=_user(corpus), db=corpus))
        assert [o.code_count for o in listed] == [1]
        one = asyncio.run(get_observation(
            project_id=PID, observation_id=OBS, user=_user(corpus), db=corpus,
        ))
        assert one.code_count == 1
        assert one.coded_segment_count == 1


class TestTheFixtureDiscriminates:
    """The claim "we count people" is only tested if the old filter disagrees here."""

    def test_the_consensus_only_filter_would_count_the_machine(self, corpus):
        from app.services.coding_layers import layer_scope_filter, non_consensus_filter

        def coded_values(clause):
            return {
                v for (v,) in corpus.query(CodeApplication.dataset_value_id)
                .join(Code, Code.id == CodeApplication.code_id)
                .filter(CodeApplication.dataset_value_id.isnot(None),
                        Code.is_universal == False, clause)  # noqa: E712
                .distinct()
            }

        old, new = coded_values(non_consensus_filter()), coded_values(layer_scope_filter())
        assert COLUMN * 10 + 1 in old and COLUMN * 10 + 1 not in new
        # The unattributed answer survives BOTH — the NULL arm is live here because a
        # machine coder exists, which is the only state that can break it.
        assert COLUMN * 10 + 3 in old and COLUMN * 10 + 3 in new
