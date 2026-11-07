"""#1545 (1.6.0) — a file the analysis page exports under a participant filter SAYS so.

Until 1.6.0 the Co-occurrence, Source Data and Comparison CSVs exported with and without
"Group = Y" had the same first line and the same name; only the numbers differed. Since #1536 a
filter also leaves out every clip and every passage linked to no one, so an unmarked file read as
project-wide (#499's own reason). Each now carries ONE scope line from
`routers/export_helpers.py::file_scope_line`: the coder and layer parts it already had (the
co-occurrence file's words since #499/#512), the participant part
(`services/participant_filter.py::participant_filter_scope_bit` — the panel's description of the
values, sent as `participant_filter_label`, and the server's own count of the ids), then the
panel's rule line. A file nothing narrows is unchanged: the two that had no scope line still
open on their header.

The Coded Segments CSV is NOT here: the coding import reads its line 1 as the header, so it says
its selection in its NAME (#1535 D115, `test_coded_segments_selection_1535.py`).

The words are the client's (`frontend/src/lib/participant-filter.ts`) — the last test pins the
rule sentence across the two languages.
"""
from __future__ import annotations

import csv
import io
import re
from pathlib import Path

from tests.test_participant_filter_1536 import site, P1, P2, A, B, UNC  # noqa: F401  (fixture)

from app.services.participant_filter import PARTICIPANT_FILTER_RULE, participant_filter_scope_bit
from app.services.code_analysis import COOCCURRENCE_RULE

TS_FILTER = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "participant-filter.ts"

COOC = "/api/projects/{pid}/export/code-cooccurrence"
SOURCE_DATA = "/api/projects/{pid}/code-analysis/source-frequencies/csv"
COMPARISON = "/api/projects/{pid}/code-analysis/demographic-comparison/csv"

BASE_PARAMS = {
    COOC: {"source": "all"},
    SOURCE_DATA: {"code_ids": f"{A},{B},{UNC}"},
    COMPARISON: {"code_ids": f"{A},{B}", "group_by_subtype": "group"},
}
FILES = (COOC, SOURCE_DATA, COMPARISON)


def _rows(client, pid, route, **extra):
    resp = client.get(route.format(pid=pid), params={**BASE_PARAMS[route], **extra})
    assert resp.status_code == 200, (route, resp.status_code, resp.text[:300])
    return list(csv.reader(io.StringIO(resp.text.lstrip("﻿")))), resp


# ── what the line says ──────────────────────────────────────────────────────────────────────────

def test_the_participant_part_names_the_values_and_the_servers_own_count():
    assert participant_filter_scope_bit(None) is None
    assert participant_filter_scope_bit([]) is None
    assert participant_filter_scope_bit([7]) == "participant filter: 1 participant"
    assert participant_filter_scope_bit([7, 8, 8]) == "participant filter: 2 participants"
    assert participant_filter_scope_bit([7, 8], "Group: Y; Site: South") == \
        "participant filter: Group: Y; Site: South (2 participants)"
    # a blank label is no label: the count stands alone
    assert participant_filter_scope_bit([7], "   ") == "participant filter: 1 participant"


def test_every_file_says_the_filter_on_its_first_line(site):
    client, pid, _ = site
    for route in FILES:
        rows, _ = _rows(client, pid, route, participant_ids=str(P2), participant_filter_label="Group: Y")
        first = rows[0][0]
        assert first.startswith("Scope: participant filter: Group: Y (1 participant)."), (route, first)
        assert PARTICIPANT_FILTER_RULE in first, (route, first)


def test_without_a_label_the_count_alone_is_said(site):
    """A filter from a link or a saved analysis keeps ids only (D124): the client sends no
    label, and the file still says it is filtered, and to how many."""
    client, pid, _ = site
    for route in FILES:
        rows, _ = _rows(client, pid, route, participant_ids=f"{P1},{P2}")
        assert rows[0][0].startswith("Scope: participant filter: 2 participants."), (route, rows[0][0])


def test_the_filtered_and_the_unfiltered_file_differ_on_line_one(site):
    """The defect as filed (the audit's F5 probe): only the numbers differed."""
    client, pid, _ = site
    for route in FILES:
        plain, _ = _rows(client, pid, route)
        filt, _ = _rows(client, pid, route, participant_ids=str(P2), participant_filter_label="Group: Y")
        assert plain != filt, f"{route}: control — the filter must change the numbers"
        assert plain[0] != filt[0], route


def test_a_file_nothing_narrows_is_unchanged(site):
    """POSITIVE CONTROL: no scope, no line — the Source Data and Comparison CSVs still open on
    their header, and the co-occurrence file on its rule alone."""
    client, pid, _ = site
    cooc, _ = _rows(client, pid, COOC)
    assert cooc[0] == [COOCCURRENCE_RULE]
    source_data, _ = _rows(client, pid, SOURCE_DATA)
    assert source_data[0][:5] == ["Source", "Source Type", "Total Segments", "Total Word Count", "Coded Segments"]
    comparison, _ = _rows(client, pid, COMPARISON)
    assert comparison[0][:2] == ["Code", "Category"]


def test_the_co_occurrence_rule_still_follows_the_scope(site):
    client, pid, _ = site
    rows, _ = _rows(client, pid, COOC, participant_ids=str(P2), participant_filter_label="Group: Y")
    assert rows[0][0].endswith(COOCCURRENCE_RULE), rows[0][0]
    assert rows[1][0] == "", "the matrix header follows the one scope line"


def test_the_header_follows_the_scope_line_in_the_two_files_that_had_none(site):
    client, pid, _ = site
    rows, _ = _rows(client, pid, SOURCE_DATA, participant_ids=str(P2))
    assert rows[1][:2] == ["Source", "Source Type"]
    rows, _ = _rows(client, pid, COMPARISON, participant_ids=str(P2))
    assert rows[1][:2] == ["Code", "Category"]


def test_a_coder_scope_is_said_by_the_two_files_that_said_nothing(site):
    """The same builder: a blind coder's or a coder-filtered Source Data / Comparison file said
    no scope at all (#499's sibling, missed by #1530's D97 table). The co-occurrence wording is
    the one they now share."""
    client, pid, _ = site
    status = client.get("/api/auth/status").json()
    uid, name = status["user"]["id"], status["user"]["username"]
    for route in FILES:
        rows, _ = _rows(client, pid, route, coder_ids=str(uid))
        first = rows[0][0]
        assert first.startswith(f"Scope: coders: {name}."), (route, first)
        assert PARTICIPANT_FILTER_RULE not in first, "no participant filter, no rule"


def test_a_label_cannot_break_the_file(site):
    """The label is researcher text riding a request: it lands INSIDE the line (never its first
    character), and a comma or quote in it stays in the one cell."""
    client, pid, _ = site
    for route in FILES:
        rows, _ = _rows(client, pid, route, participant_ids=str(P2),
                        participant_filter_label='=HYPERLINK("x"), Site: "North, East"')
        assert rows[0][0].startswith("Scope: participant filter: =HYPERLINK"), rows[0][0]
        assert len(rows[0]) == 1, rows[0]


# ── one wording, two languages ──────────────────────────────────────────────────────────────────

def test_the_rule_sentence_is_the_panels_word_for_word():
    source = TS_FILTER.read_text(encoding="utf-8")
    match = re.search(r"export const PARTICIPANT_FILTER_RULE =(.*?)\n\n", source, re.S)
    assert match, f"PARTICIPANT_FILTER_RULE not found in {TS_FILTER}"
    pieces = re.findall(r"'([^']*)'", match.group(1))
    assert pieces, "no string literals in the constant"
    assert "".join(pieces) == PARTICIPANT_FILTER_RULE
