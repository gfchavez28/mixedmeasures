"""#414 slab 1 — identifier-column inference (DEC-9).

Header-hint-gated: value shape alone must never trigger. Runs BEFORE the skip
check in `_detect_column_type` because the skip lists swallow id-family headers
("id", "respondent id") — pre-#414 the identity column was auto-discarded.

Two keyword tiers: strong (participant/respondent/subject/pid — a PERSON
concept, trusted even over 1..N values) vs weak (bare id-words — demoted back
to skip when the values are a dense sequential row counter, e.g. LimeSurvey's
`id`). "response" is a negative signal (a platform response key, not a person).
"""
from app.services.dataset_import import (
    _detect_column_type,
    _is_identifier_column,
    _is_sequential_counter,
)


def _parsed(header: str) -> dict:
    return {"column_text": header, "raw_code": None}


def _detect(header: str, values: list[str], raw_code: str | None = None):
    parsed = {"column_text": header, "raw_code": raw_code}
    return _detect_column_type(header, parsed, set(values), values, 0)


# ── The #414 symptom: participant_id must stop masquerading ────────────────────

def test_participant_id_codes_detected_as_identifier():
    values = [f"P{i:03d}" for i in range(1, 41)]  # P001..P040, unique short codes
    res = _detect("participant_id", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_respondent_id_header_beats_the_skip_list():
    """'Respondent ID' is in _SKIP_HEADERS — identifier detection must run
    FIRST or the identity column is silently discarded."""
    values = [f"R-{i:02d}" for i in range(1, 31)]
    res = _detect("Respondent ID", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_strong_header_trusts_sequential_numeric_ids():
    """A participant_id of 1..N is a real identity other files may reference —
    the strong person-word wins over the row-counter demotion."""
    values = [str(i) for i in range(1, 43)]
    res = _detect("participant_id", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_respondent_full_names_detected_as_identifier():
    """Names ARE identifiers (the speaker convention writes names into
    Participant.identifier). Two tokens pass the token gate."""
    values = [f"Person {chr(65 + i)} Smith" for i in range(26)]
    res = _detect("Respondent", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_underscore_headers_match_despite_word_boundary():
    """`\\b` treats `_` as a word char — 'staff_id' only matches after
    separator normalization (the _header_signals_percentage lesson)."""
    values = [f"S{i:04d}" for i in range(1, 21)]
    res = _detect("staff_id", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


# ── Platform metadata must STAY skip ───────────────────────────────────────────

def test_bare_id_sequential_counter_stays_skip():
    """LimeSurvey's `id` column (dense 1..N) is a row counter, not an identity."""
    values = [str(i) for i in range(1, 51)]
    res = _detect("id", values)
    assert res["suggested_type"] == "skip", res["suggested_type"]


def test_bare_id_with_real_codes_is_identifier():
    """A bare `id` header over non-sequential codes IS an identity column."""
    values = [f"HH-{i * 7 + 100}" for i in range(30)]
    res = _detect("id", values)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_token_and_submitdate_stay_skip():
    token_values = [f"tok{i}x9q" for i in range(20)]
    assert _detect("token", token_values)["suggested_type"] == "skip"
    date_values = [f"2026-01-{i:02d} 09:00" for i in range(1, 21)]
    assert _detect("submitdate", date_values)["suggested_type"] == "skip"


def test_response_id_is_negative_signal():
    """Qualtrics-style 'Response ID' keys the RESPONSE, not the person —
    stays on today's skip path."""
    values = [f"R_x{i}Qz{i * 3}" for i in range(40)]
    res = _detect("Response ID", values)
    assert res["suggested_type"] == "skip", res["suggested_type"]


# ── Value-shape gates: header hint alone must not overreach ────────────────────

def test_repeated_values_under_participant_header_not_identifier():
    """'Participant Role' repeats labels → uniqueness gate fails → falls
    through to the demographic branch (role keyword)."""
    values = (["Teacher", "Admin", "Counselor"] * 12)
    res = _detect("Participant Role", values)
    assert res["suggested_type"] == "demographic", res["suggested_type"]


def test_near_unique_numeric_without_header_hint_stays_numeric():
    """No id-word in the header → never identifier, whatever the values."""
    values = [f"{i * 3 + 11}" for i in range(40)]  # near-unique integers ≥ 11
    res = _detect("Reaction_Time_ms", values)
    assert res["suggested_type"] == "numeric", res["suggested_type"]


def test_prose_under_subject_header_stays_open_text():
    """'Subject' (email-style) with sentence values fails the token/length
    gates → open_text, not identifier."""
    values = [
        f"Following up on the meeting notes from last week regarding item {i}"
        for i in range(20)
    ]
    res = _detect("Subject", values)
    assert res["suggested_type"] == "open_text", res["suggested_type"]


def test_too_few_rows_to_judge_uniqueness():
    assert not _is_identifier_column("participant_id", None, {"P1", "P2"}, ["P1", "P2"])


# ── Helper unit coverage ───────────────────────────────────────────────────────

def test_sequential_counter_detection():
    assert _is_sequential_counter({str(i) for i in range(1, 11)})
    assert _is_sequential_counter({str(i) for i in range(0, 10)})
    assert not _is_sequential_counter({"1", "2", "4"})           # gap
    assert not _is_sequential_counter({"100", "101", "102"})     # offset start
    assert not _is_sequential_counter({"P1", "P2", "P3"})        # non-numeric
