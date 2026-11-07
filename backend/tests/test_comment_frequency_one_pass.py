"""#1463 (D66, 1.5.9) — the text arm's frequency count is ONE ordered pass.

`code_analysis._get_comment_frequencies` ran three statements — per code, total
answers, total records — each a hand-written copy of one filter, each walking every
open-text cell of the project. On the encrypted BES copy they took 16.9–17.2 s, and
with the Qualitative analysis page's other requests the page failed at the client's
30 s limit (the 2026-11-02e review, the internal design notes,
git-ignored, *Extension*). D66: one read ordered by the answer, tallied as it streams,
the same answers.

The old three statements are kept VERBATIM below as the oracle, and every scope the
endpoint takes — code ids, participant ids, coder ids, layer — is run through both.
⚠️ The fixture is built so the plausible-wrong forms DISAGREE with the right one
(`test_the_fixture_can_tell_the_wrong_forms_apart`, #707a): two coders on one answer
(applications ≠ answers), one record answering two columns (answers ≠ records), and a
code filter whose totals differ from the filtered codes' own (the prototype filtered
the totals too). ⚠️ The answers' ids DESCEND against insertion order, so a read that
loses its ORDER BY meets `CommentFrequencyOrderError` rather than passing quietly.
"""
import ast
import inspect
import itertools
import textwrap

import pytest
from sqlalchemy import func

from app.auth import get_or_create_consensus_user
from app.models import Code, CodeApplication, Participant, Project, User
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services import code_analysis as ca

PID, OTHER_PID = 960, 961
ADA, BEN, MODEL = 1, 2, 3          # conftest's User(id=1) is a person; Ben too; the model is a machine
X, Y, Z, U, OTHER_X = 9601, 9602, 9603, 9604, 9611   # U is universal; OTHER_X is another project's
P1, P2, P3 = 9621, 9622, 9623
T1, T2, NOM, OTHER_T = 9631, 9632, 9633, 9634        # two open-text columns, a nominal one, another project's
R1, R2, R3, R4, R5, R_OTHER = 9641, 9642, 9643, 9644, 9645, 9646

# Each answer: (value id, record, column, [(code, coder or None or "consensus")]).
# The value ids DESCEND against this list's order — the order the rows are inserted.
ANSWERS = [
    ("a", 9659, R1, T1, [(X, ADA), (X, BEN)]),          # two coders, one code, one answer
    ("b", 9658, R1, T2, [(X, ADA), (Y, ADA)]),          # one answer, two codes; R1's second column
    ("c", 9657, R2, T1, [(Y, BEN), (Z, MODEL)]),        # a person's code beside a model's
    ("d", 9656, R3, T1, [(U, ADA)]),                    # a universal code only
    ("e", 9655, R3, T2, [(X, "consensus")]),            # the consensus layer only
    ("f", 9654, R4, T1, [(X, None)]),                   # a pre-J1 row: no coder
    ("g", 9653, R5, NOM, [(X, ADA)]),                   # a NOMINAL column: never a text answer
    ("h", 9652, R2, T2, [(Z, MODEL)]),                  # the model only
    ("i", 9651, R_OTHER, OTHER_T, [(OTHER_X, ADA)]),    # another project's answer
]
PARTICIPANT_OF = {R1: P1, R2: P2, R3: P3}


def _seed(db):
    db.add_all([
        User(id=BEN, username="Ben", coder_type="human"),
        User(id=MODEL, username="Model", coder_type="ai"),
        Project(id=PID, name="Frequencies, one pass", user_id=1),
        Project(id=OTHER_PID, name="Someone else's", user_id=1),
    ])
    db.flush()
    consensus = get_or_create_consensus_user(db)
    db.add_all([
        Code(id=X, project_id=PID, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=Y, project_id=PID, name="Y", numeric_id=2, is_active=True, is_universal=False),
        Code(id=Z, project_id=PID, name="Z", numeric_id=3, is_active=True, is_universal=False),
        Code(id=U, project_id=PID, name="Unclear", numeric_id=4, is_active=True, is_universal=True),
        Code(id=OTHER_X, project_id=OTHER_PID, name="X", numeric_id=1, is_active=True,
             is_universal=False),
        Participant(id=P1, project_id=PID, identifier="P-01"),
        Participant(id=P2, project_id=PID, identifier="P-02"),
        Participant(id=P3, project_id=PID, identifier="P-03"),
        Dataset(id=PID, project_id=PID, name="Survey"),
        Dataset(id=OTHER_PID, project_id=OTHER_PID, name="Other survey"),
    ])
    db.flush()
    columns = [(T1, PID, ColumnType.OPEN_TEXT), (T2, PID, ColumnType.OPEN_TEXT),
               (NOM, PID, ColumnType.NOMINAL), (OTHER_T, OTHER_PID, ColumnType.OPEN_TEXT)]
    db.add_all([
        DatasetColumn(id=col, dataset_id=ds, column_code=f"Q{col}", column_name=f"Q{col}",
                      column_text=f"Q{col}", column_type=kind, sequence_order=i, display_order=i)
        for i, (col, ds, kind) in enumerate(columns)
    ])
    db.add_all([
        DatasetRow(id=row, dataset_id=OTHER_PID if row == R_OTHER else PID,
                   participant_id=PARTICIPANT_OF.get(row))
        for row in (R1, R2, R3, R4, R5, R_OTHER)
    ])
    db.flush()
    for _name, value_id, row, col, codings in ANSWERS:
        db.add(DatasetValue(id=value_id, row_id=row, column_id=col, value_text=f"answer {_name}"))
        db.flush()
        for code, coder in codings:
            if coder == "consensus":
                db.add(CodeApplication(dataset_value_id=value_id, code_id=code,
                                       user_id=consensus.id, origin="consensus"))
            else:
                db.add(CodeApplication(dataset_value_id=value_id, code_id=code, user_id=coder,
                                       origin="human"))
    db.flush()


def _old_comment_frequencies(
    db,
    project_id: int,
    code_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """The ORACLE: `_get_comment_frequencies` before #1463 D66, its body VERBATIM (`dd7251d8`)."""
    _coder_filter = ca._coder_filter
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)).label("text_count"),
            func.count(func.distinct(DatasetValue.row_id)).label("row_count"),
        )
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if participant_ids:
        base = base.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        base = base.filter(DatasetRow.participant_id.in_(participant_ids))

    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))
    base = _coder_filter(base, coder_ids, layer_scope)

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals (must apply same participant filter as per-code queries)
    total_comment_query = (
        db.query(func.count(func.distinct(CodeApplication.dataset_value_id)))
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_comment_query = (
            total_comment_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_comment_query = _coder_filter(total_comment_query, coder_ids, layer_scope)
    total_coded_texts = total_comment_query.scalar() or 0

    total_records_query = (
        db.query(func.count(func.distinct(DatasetValue.row_id)))
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_records_query = (
            total_records_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_records_query = _coder_filter(total_records_query, coder_ids, layer_scope)
    total_records = total_records_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_texts": total_coded_texts,
        "total_rows": total_records,
    }


def _j_a_total_coded_texts(
    db,
    project_id: int,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> int:
    """The SECOND oracle (#1526 D78, 1.5.9): the old total statement above with the universal
    exclusion written exactly as the three SEGMENT arms write theirs
    (`~CodeApplication.code_id.in_(universal_ids)`) — invariant J-A, an answer marked only
    with a universal code is not a coded answer. Independent of the tally's Python."""
    universal_ids = [c for (c,) in db.query(Code.id).filter(
        Code.project_id == project_id, Code.is_universal == True)]  # noqa: E712
    q = (
        db.query(func.count(func.distinct(CodeApplication.dataset_value_id)))
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if universal_ids:
        q = q.filter(~CodeApplication.code_id.in_(universal_ids))
    if participant_ids:
        q = q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id).filter(
            DatasetRow.participant_id.in_(participant_ids))
    q = ca._coder_filter(q, coder_ids, layer_scope)
    return q.scalar() or 0


def _expected(db, project_id, **scope) -> dict:
    """D66's per-code counts (unchanged by #1526) beside D78's J-A total."""
    old = _old_comment_frequencies(db, project_id, **scope)
    total_scope = {k: v for k, v in scope.items() if k != "code_ids"}   # the total ignores it
    return {"freq_map": old["freq_map"],
            "total_coded_texts": _j_a_total_coded_texts(db, project_id, **total_scope)}


CODE_SCOPES = [None, [X], [Y, Z], [U], [X, Y, Z, U]]
PARTICIPANT_SCOPES = [None, [P1], [P2], [P1, P3]]
CODER_SCOPES = [None, [ADA], [BEN], [ADA, BEN], [MODEL]]
LAYERS = [None, "human", "consensus", "machine"]


@pytest.mark.parametrize("layer_scope", LAYERS)
def test_the_one_pass_equals_the_three_statements_in_every_scope(db_session, layer_scope):
    _seed(db_session)
    checked = 0
    for code_ids, participant_ids, coder_ids in itertools.product(
        CODE_SCOPES, PARTICIPANT_SCOPES, CODER_SCOPES,
    ):
        scope = dict(code_ids=code_ids, participant_ids=participant_ids, coder_ids=coder_ids,
                     layer_scope=layer_scope)
        assert ca._get_comment_frequencies(db_session, PID, **scope) == \
            _expected(db_session, PID, **scope), scope
        checked += 1
    assert checked == len(CODE_SCOPES) * len(PARTICIPANT_SCOPES) * len(CODER_SCOPES)


def test_the_differential_is_not_comparing_nothing(db_session):
    # POPULATION: the scopes above reach non-empty answers in each arm of every axis,
    # so "equal" is never two empty dicts agreeing.
    _seed(db_session)
    for scope in (dict(), dict(code_ids=[Y, Z]), dict(participant_ids=[P2]), dict(coder_ids=[BEN]),
                  dict(layer_scope="consensus"), dict(layer_scope="machine")):
        old = _old_comment_frequencies(db_session, PID, **scope)
        assert old["freq_map"] and old["total_coded_texts"] > 0, scope


def test_the_fixture_can_tell_the_wrong_forms_apart(db_session):
    """#707a: on a fixture where the plausible-wrong forms agree with the right one,
    the differential above would pass them too."""
    _seed(db_session)
    old = _old_comment_frequencies(db_session, PID)
    x_answers, x_records = old["freq_map"][X]
    x_applications = sum(1 for _n, _v, row, col, codings in ANSWERS
                         if col in (T1, T2) and row != R_OTHER
                         for code, coder in codings if code == X and coder not in ("consensus",))
    assert x_applications > x_answers, "counting applications must differ from counting answers"
    assert x_answers > x_records, "counting answers must differ from counting records"
    # The prototype's defect: totals filtered by the requested codes.
    filtered = _old_comment_frequencies(db_session, PID, code_ids=[Y])
    assert filtered["total_coded_texts"] != filtered["freq_map"][Y][0], (
        "the totals must ignore code_ids, so a filtered total would differ")
    # #1526 D78: answer d carries only the universal code, so the J-A total must differ from
    # the old "any code" total — in the default scope AND under a participant filter.
    assert _j_a_total_coded_texts(db_session, PID) < old["total_coded_texts"]
    assert _j_a_total_coded_texts(db_session, PID, participant_ids=[P3]) < \
        _old_comment_frequencies(db_session, PID, participant_ids=[P3])["total_coded_texts"]


class TestTheAnswersAreTheFixturesOwn:
    """Literal answers from the fixture, not from either implementation (an oracle)."""

    def test_the_human_layer_all_coders(self, db_session):
        _seed(db_session)
        # Human layer: a, b, c (Ben's Y — the model's Z is not a person's), d (universal), f
        # (no coder). Not e (consensus), h (the model only), g (nominal), i (other project).
        # The TOTAL leaves out d — marked only with the universal code (#1526 D78).
        assert ca._get_comment_frequencies(db_session, PID) == {
            "freq_map": {X: (3, 2), Y: (2, 2), U: (1, 1)},   # X on a, b (both R1) and f (R4)
            "total_coded_texts": 4,
        }

    def test_blind_one_coder(self, db_session):
        _seed(db_session)
        # Ada alone: a, b (both R1), d (R3, universal only — not in the total).
        assert ca._get_comment_frequencies(db_session, PID, coder_ids=[ADA]) == {
            "freq_map": {X: (2, 1), Y: (1, 1), U: (1, 1)},
            "total_coded_texts": 2,
        }

    def test_a_code_filter_keeps_the_totals(self, db_session):
        _seed(db_session)
        result = ca._get_comment_frequencies(db_session, PID, code_ids=[Y])
        assert result == {"freq_map": {Y: (2, 2)}, "total_coded_texts": 4}

    def test_the_universal_code_alone_still_counts_its_answers_and_not_the_total(self, db_session):
        _seed(db_session)
        # Asking for the universal code alone: its own count is d; the total stays J-A's.
        assert ca._get_comment_frequencies(db_session, PID, code_ids=[U]) == {
            "freq_map": {U: (1, 1)}, "total_coded_texts": 4,
        }

    def test_the_machine_and_consensus_layers(self, db_session):
        _seed(db_session)
        assert ca._get_comment_frequencies(db_session, PID, layer_scope="machine") == {
            "freq_map": {Z: (2, 1)}, "total_coded_texts": 2,   # c and h, both R2
        }
        assert ca._get_comment_frequencies(db_session, PID, layer_scope="consensus") == {
            "freq_map": {X: (1, 1)}, "total_coded_texts": 1,   # e
        }

    def test_a_participant_filter(self, db_session):
        _seed(db_session)
        # P1 holds R1 and P3 holds R3: a, b, d in the human layer (e is consensus); d is
        # universal only, so the total is a and b.
        assert ca._get_comment_frequencies(db_session, PID, participant_ids=[P1, P3]) == {
            "freq_map": {X: (2, 1), Y: (1, 1), U: (1, 1)},
            "total_coded_texts": 2,
        }

    def test_the_public_payload(self, db_session):
        _seed(db_session)
        result = ca.get_code_frequencies(db_session, PID, source="text")
        rows = {r["code_id"]: r for r in result["frequencies"]}
        assert (rows[X]["text_count"], rows[X]["row_count"]) == (3, 2)
        assert (rows[Z]["text_count"], rows[Z]["row_count"]) == (0, 0)
        assert result["total_coded_texts"] == 4
        # #1526 D81: the never-read percentages and their base are gone from the payload.
        assert "total_rows" not in result
        assert not {"text_percentage", "row_percentage"} & set(rows[X])


class TestTheTally:
    NONE = frozenset()

    def test_an_answer_that_returns_after_it_closed_is_refused(self):
        # The ORDER BY is load-bearing: an answer seen again would be counted twice.
        with pytest.raises(ca.CommentFrequencyOrderError):
            ca._tally_comment_frequencies([(2, X, 10), (1, X, 10), (2, Y, 10)], None, self.NONE)

    def test_rows_of_one_answer_may_arrive_in_any_code_order(self):
        rows = [(5, Y, 10), (5, X, 10), (5, Y, 10), (6, X, 10), (7, X, 11)]
        assert ca._tally_comment_frequencies(rows, None, self.NONE) == {
            "freq_map": {X: (3, 2), Y: (1, 1)}, "total_coded_texts": 3,
        }

    def test_a_code_filter_narrows_the_codes_and_not_the_totals(self):
        rows = [(5, Y, 10), (6, X, 11)]
        assert ca._tally_comment_frequencies(rows, [X], self.NONE) == {
            "freq_map": {X: (1, 1)}, "total_coded_texts": 2,
        }

    def test_nothing_in_nothing_out(self):
        assert ca._tally_comment_frequencies([], None, self.NONE) == {
            "freq_map": {}, "total_coded_texts": 0,
        }

    def test_a_universal_only_answer_is_counted_under_its_code_and_not_in_the_total(self):
        # #1526 D78 — answer 5 holds only U; answer 6 holds U AND X (coded: X is real);
        # answer 7 holds only U, the LAST answer (the close after the loop must apply it too).
        rows = [(5, U, 10), (6, U, 11), (6, X, 11), (7, U, 12)]
        assert ca._tally_comment_frequencies(rows, None, {U}) == {
            "freq_map": {U: (3, 3), X: (1, 1)}, "total_coded_texts": 1,
        }

    def test_the_universal_ids_are_a_required_argument(self):
        # A caller that forgot them would count every universal-only answer again, silently.
        with pytest.raises(TypeError):
            ca._tally_comment_frequencies([(5, U, 10)], None)   # type: ignore[call-arg]


def test_the_read_the_tally_streams_is_ordered():
    """The ORDER BY, pinned in the SOURCE as well as by behaviour — a query plan is not a
    contract (#1021; #1335's session C saw SQLite return rows in order without one).
    Read through `ast.unparse`, which drops comments: a commented-out ORDER BY must not
    satisfy the pin (it did, in this session's first mutant run)."""
    code = ast.unparse(ast.parse(textwrap.dedent(inspect.getsource(ca._get_comment_frequencies))))
    assert ".order_by(CodeApplication.dataset_value_id)" in code
    assert "_tally_comment_frequencies(rows, code_ids, universal_ids)" in code


def test_the_order_pin_cannot_be_satisfied_by_a_comment():
    # PREDICATE falsifier for the pin above.
    code = ast.unparse(ast.parse("x = stmt  # .order_by(CodeApplication.dataset_value_id)\n"))
    assert ".order_by(CodeApplication.dataset_value_id)" not in code
