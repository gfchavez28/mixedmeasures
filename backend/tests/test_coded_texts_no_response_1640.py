"""#1640 — the By Code list keeps a coded answer the project counts as no response, and marks it.

The filed Direction was to leave such an answer ("N/A", …) out of the list. Probed on #1526's
fixture (2026-11-16b), that would have made the screen disagree with ITSELF: its header
("2 texts") and the code list's badge read `get_code_frequencies`' `text_count`, which keeps a
coded no-response on purpose — a usage count, not a share (#1526 D80, `dataset-semantics.md`
§3) — while the Descriptives summary table, a share over a base without such answers, says 1.
Decided (2026-11-16b): the answer stays listed — it is a coding, and this list is where a
researcher finds it to remove it — and each text says whether the project counts it as no
response (`counted_as_no_response`), decided by the ONE rule, `is_empty_text` (#519).

The fixture is #1526's: a1 "a real answer" and a6 "N/A" both carry code A.
"""
from __future__ import annotations

import json

from app.models.text_coding_config import TextCodingConfig
from app.schemas.code_analysis import CodeTextsResponse
from app.services import code_analysis as ca
from tests.test_frequency_bases_1526 import A, PID, world  # noqa: F401  (the fixture)


def _marks(db) -> dict[str, bool]:
    result = ca.get_coded_comments_with_context(db, PID, A)
    CodeTextsResponse(**result)        # the wire carries it (pytest runs extra='forbid')
    return {t["value_text"]: t["counted_as_no_response"]
            for ds in result["datasets"] for t in ds["texts"]}


def test_the_list_keeps_a_coded_no_response_and_marks_it(world):
    assert _marks(world) == {"a real answer": False, "N/A": True}


def test_the_list_agrees_with_the_header_and_badge_beside_it(world):
    """The screen's own count: the list's total equals the usage count above it."""
    result = ca.get_coded_comments_with_context(world, PID, A)
    freq = ca.get_code_frequencies(world, PID, source="text")
    usage = next(f["text_count"] for f in freq["frequencies"] if f["code_id"] == A)
    assert result["total_texts"] == usage == 2


def test_the_mark_follows_the_projects_declared_list_not_the_defaults(world):
    """REPLACE semantics (#816), two-sided: a declared list that names the real answer and
    not "N/A" moves BOTH marks — a hardcoded default list would keep "N/A" marked."""
    world.add(TextCodingConfig(project_id=PID, treat_as_empty=json.dumps(["a real answer"])))
    world.flush()
    assert _marks(world) == {"a real answer": True, "N/A": False}
