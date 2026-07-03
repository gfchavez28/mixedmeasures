"""Per-source / per-project coder coverage (Track J · Group A — #1/#3/#13).

Coverage = the distinct REAL coders who applied ≥1 non-universal, non-consensus code,
derived from codings (NOT the instance-global roster — the #444 trap). It INCLUDES
archived coders (flagged) but excludes system coders (consensus/Unattributed),
null-applier rows, and universal-only coders. Per-source coverage honors the visible
segment filter; per-project coverage/counts scope by ``Code.project_id`` (no visible
filter — a coder of a since-merged segment still participated).
"""
import asyncio

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.services.coding_coverage import (
    source_coder_coverage,
    project_coder_coverage,
    project_coder_counts,
)


def _run(coro):
    return asyncio.run(coro)


PID = 700
CONV1, CONV2 = 700, 701
DS, COL, ROW, VAL = 700, 7000, 7000, 70000
C_UNCLEAR, C_THEME_A, C_THEME_B = 6800, 6801, 6802


@pytest.fixture
def coverage_project(db_session):
    """One project exercising every coverage rule. Coders:

    - Researcher (id 1) — universal code ONLY in conv1           → NOT counted
    - Alice (101, active)    — Theme A conv1 + Theme B conv2      → counted (both)
    - Ben (102, active)      — Theme A conv1                      → counted (conv1)
    - Carmen (103, ARCHIVED) — Theme A conv1                      → counted, flagged
    - Consensus (104, system, origin='consensus') conv1          → NOT counted
    - Unattributed (105, system) conv1                           → NOT counted
    - Dora (106, active)     — Theme A on a MERGED conv1 segment  → NOT in conv1 source
                                                                    coverage (hidden),
                                                                    YES in project
    - Evan (107, active)     — Theme B conv2 only                 → conv2 + project
    - Farah (108, active)    — Theme A on a dataset value         → text-column + project
    - NULL applier           — Theme A conv1                      → NOT counted
    """
    db = db_session
    db.add(Project(id=PID, name="Coverage", user_id=1))
    db.add_all([
        User(id=101, username="Alice", display_color="#123456"),
        User(id=102, username="Ben"),
        User(id=103, username="Carmen", archived=True),
        User(id=104, username="Consensus", coder_type="consensus"),
        User(id=105, username="Unattributed", coder_type="unattributed"),
        User(id=106, username="Dora"),
        User(id=107, username="Evan"),
        User(id=108, username="Farah"),
    ])
    db.add_all([
        Conversation(id=CONV1, project_id=PID, name="RFO1"),
        Conversation(id=CONV2, project_id=PID, name="RIN5"),
    ])
    db.flush()

    db.add_all([
        Segment(id=7000, conversation_id=CONV1, sequence_order=0, text="a", word_count=1),
        # 7001 is soft-deleted via merge → hidden from per-source coverage
        Segment(id=7001, conversation_id=CONV1, sequence_order=1, text="b", word_count=1,
                merged_into_id=7000),
        Segment(id=7002, conversation_id=CONV2, sequence_order=0, text="c", word_count=1),
    ])
    db.add_all([
        Code(id=C_UNCLEAR, project_id=PID, numeric_id=0, name="Unclear", is_universal=True, is_active=True),
        Code(id=C_THEME_A, project_id=PID, numeric_id=2, name="Theme A", is_universal=False, is_active=True),
        Code(id=C_THEME_B, project_id=PID, numeric_id=3, name="Theme B", is_universal=False, is_active=True),
    ])
    db.flush()

    # A dataset text column + one value, for open-ended text-coding coverage.
    db.add(Dataset(id=DS, project_id=PID, name="Survey"))
    db.flush()
    db.add(DatasetColumn(id=COL, dataset_id=DS, column_text="Comments",
                         column_type=ColumnType.OPEN_TEXT, sequence_order=0))
    db.add(DatasetRow(id=ROW, dataset_id=DS))
    db.flush()
    db.add(DatasetValue(id=VAL, row_id=ROW, column_id=COL, value_text="great"))
    db.flush()

    db.add_all([
        # conv1 seg 7000 (visible)
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=101),                 # Alice
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=102),                 # Ben
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=103),                 # Carmen (archived)
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=104, origin="consensus"),  # excluded
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=105),                 # Unattributed excluded
        CodeApplication(segment_id=7000, code_id=C_UNCLEAR, user_id=1),                   # Researcher universal-only
        CodeApplication(segment_id=7000, code_id=C_THEME_A, user_id=None),               # null applier excluded
        # conv1 seg 7001 (MERGED / hidden) — Dora codes ONLY here
        CodeApplication(segment_id=7001, code_id=C_THEME_A, user_id=106),
        # conv2 seg 7002 — Alice + Evan
        CodeApplication(segment_id=7002, code_id=C_THEME_B, user_id=101),
        CodeApplication(segment_id=7002, code_id=C_THEME_B, user_id=107),
        # dataset value — Farah
        CodeApplication(dataset_value_id=VAL, code_id=C_THEME_A, user_id=108),
    ])
    db.flush()
    return db


def _names(coverage):
    return [c.username for c in coverage]


def test_source_coverage_conversation(coverage_project):
    cov = source_coder_coverage(coverage_project, PID, conversation_id=CONV1)
    # Active alpha (Alice, Ben) then archived (Carmen). Excludes universal-only
    # Researcher, system consensus/unattributed, null applier, hidden-seg Dora,
    # and conv2-only Evan.
    assert _names(cov) == ["Alice", "Ben", "Carmen"]
    assert [c.archived for c in cov] == [False, False, True]
    assert cov[0].display_color == "#123456"


def test_source_coverage_isolated_per_source(coverage_project):
    conv2 = source_coder_coverage(coverage_project, PID, conversation_id=CONV2)
    assert _names(conv2) == ["Alice", "Evan"]


def test_source_coverage_text_column(coverage_project):
    cov = source_coder_coverage(coverage_project, PID, text_column_ids=[COL])
    assert _names(cov) == ["Farah"]


def test_source_coverage_requires_a_selector(coverage_project):
    assert source_coder_coverage(coverage_project, PID) == []


def test_project_coverage_unions_sources_and_includes_hidden_seg_coder(coverage_project):
    cov = project_coder_coverage(coverage_project, PID)
    # Every real coder anywhere: active alpha, then archived. Dora counts here
    # (project scope ignores the visible filter) though she is absent from conv1
    # source coverage.
    assert _names(cov) == ["Alice", "Ben", "Dora", "Evan", "Farah", "Carmen"]
    assert cov[-1].archived is True  # Carmen sorts last (archived)


def test_project_coder_counts_batch(coverage_project):
    counts = project_coder_counts(coverage_project, [PID, 999])
    assert counts.get(PID) == 6   # Alice, Ben, Carmen, Dora, Evan, Farah
    assert 999 not in counts      # no codings → absent


def test_project_coder_counts_empty_input(coverage_project):
    assert project_coder_counts(coverage_project, []) == {}


# ── endpoint + projects-list wiring ─────────────────────────────────────────


def test_coverage_endpoint_project_and_source(coverage_project):
    from app.routers.code_analysis import coder_coverage
    user = coverage_project.query(User).filter(User.id == 1).one()
    res = _run(coder_coverage(project_id=PID, user=user, db=coverage_project))
    assert res.count == 6
    assert _names(res.coders) == ["Alice", "Ben", "Dora", "Evan", "Farah", "Carmen"]
    res2 = _run(coder_coverage(project_id=PID, conversation_id=CONV1, user=user, db=coverage_project))
    assert _names(res2.coders) == ["Alice", "Ben", "Carmen"]
    assert res2.coders[-1].archived is True


def test_project_list_includes_coder_count(coverage_project):
    from app.routers.projects import list_projects
    user = coverage_project.query(User).filter(User.id == 1).one()
    res = _run(list_projects(user=user, db=coverage_project))
    proj = next(p for p in res.projects if p.id == PID)
    assert proj.coder_count == 6
