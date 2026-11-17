"""D207 — the joint display's server vocabulary and its client mirror are ONE list.

`services/joint_display.py` declares the keys it puts on the wire (`UNIT_*`, `SUMMARY_*`,
`VARIABLE_*`, `EFFECT_*`, `FORMED_BY_*`, `RATING_*`, `STRAND_*`); the Compact view reads them
through `frontend/src/lib/joint-display-vocabulary.ts::SERVER_VOCABULARY`. A key the server
adds and the client lacks renders as nothing, silently, so Python reads the TypeScript and
holds the two equal by NAME and VALUE, both ways (`test_reconciliation_groups.py`'s pattern).
"""
from __future__ import annotations

import re
from pathlib import Path

from app.services import joint_display as jd
from app.services import joint_display_cases as jdc  # joint display slice 2 (D173)
from app.services import joint_display_pins as jdp  # joint display slice 2 (R8, r4-4)

REPO = Path(__file__).resolve().parents[2]
TS = REPO / "frontend" / "src" / "lib" / "joint-display-vocabulary.ts"
PREFIXES = ("UNIT_", "SUMMARY_", "VARIABLE_", "EFFECT_", "FORMED_BY_", "RATING_", "STRAND_",
            "GROUPING_")  # #1639 (r1-5)
#: Joint display slice 2 (D173): the case view's module states its own (C7 — one list).
CASE_PREFIXES = ("CASE_", "MISFIT_")
#: Joint display slice 2 (R8): a pinned quote's source kind (`pin-facts`' `source_kind`); #1653
#: (D346): why the attribution variable could not be read (`pin-facts`' `column_unusable`).
PIN_PREFIXES = ("PIN_SOURCE_", "PIN_ATTRIBUTION_")


def _server() -> dict[str, str]:
    out = {name: value for name, value in vars(jd).items()
           if name.startswith(PREFIXES) and isinstance(value, str)}
    out.update({name: value for name, value in vars(jdc).items()
                if name.startswith(CASE_PREFIXES) and isinstance(value, str)})
    out.update({name: value for name, value in vars(jdp).items()
                if name.startswith(PIN_PREFIXES) and isinstance(value, str)})
    return out


def _client(source: str) -> dict[str, str]:
    block = re.search(r"export const SERVER_VOCABULARY = \{(.*?)\n\} as const", source, re.S)
    assert block, "SERVER_VOCABULARY's block was not found — the reader must not pass vacuously"
    return dict(re.findall(r"^\s*([A-Z_]+):\s*'([^']*)',?\s*$", block.group(1), re.M))


def test_the_client_mirrors_every_server_key_by_name_and_value():
    server, client = _server(), _client(TS.read_text(encoding="utf-8"))
    assert len(server) >= 31, "population floor: the walk must find the module's vocabulary"
    assert client == server, (
        "services/joint_display.py and lib/joint-display-vocabulary.ts disagree — "
        f"server only: {sorted(set(server) - set(client))}, "
        f"client only: {sorted(set(client) - set(server))}, "
        f"values: {sorted(k for k in server.keys() & client.keys() if server[k] != client[k])}")


CASES_TS = REPO / "frontend" / "src" / "lib" / "joint-display-cases.ts"


def _ts_ints(source: str) -> dict[str, int]:
    return {name: int(value) for name, value in
            re.findall(r"^export const ([A-Z_]+) = (\d+)\s*$", source, re.M)}


def test_the_client_limits_are_the_servers():
    """The builder and the case view stop where the server would 422 — a client copy of a
    server bound that drifts makes the request fail instead of the control saying why (a
    51st code made the whole display fail to compute before D317). Equal where the client
    states the SAME bound; at most where the client's is its own, lower, one (R13)."""
    from app.schemas import joint_display as wire
    client = _ts_ints(TS.read_text(encoding="utf-8")) | _ts_ints(CASES_TS.read_text(encoding="utf-8"))
    for name in ("MAX_IDS_PER_BINDING", "MAX_STRANDS_IN_BUILDER", "MAX_RULE_CONDITIONS",
                 "MAX_LISTED_CASES", "CASE_PAGE_SIZE"):
        assert name in client, f"{name} was not read from the client — the reader must not pass vacuously"
    assert client["MAX_IDS_PER_BINDING"] == wire.MAX_IDS_PER_STRAND
    assert client["MAX_RULE_CONDITIONS"] == jdc.MAX_RULE_CONDITIONS
    assert client["MAX_LISTED_CASES"] == jdc.MAX_LISTED_CASES
    assert client["MAX_STRANDS_IN_BUILDER"] <= wire.MAX_STRANDS_PER_REQUEST
    assert 0 < client["CASE_PAGE_SIZE"] <= jdc.MAX_CASE_PAGE
    # #1644 review (r3-3): the builder's construct cap is the compute's row bound.
    assert "MAX_CONSTRUCTS" in client, "MAX_CONSTRUCTS was not read from the client"
    assert client["MAX_CONSTRUCTS"] == wire.MAX_DISPLAY_ROWS


def test_the_limit_reader_sees_a_planted_difference():
    """Falsifier for the reader above."""
    source = TS.read_text(encoding="utf-8").replace(
        "export const MAX_IDS_PER_BINDING = 50", "export const MAX_IDS_PER_BINDING = 51", 1)
    assert _ts_ints(source)["MAX_IDS_PER_BINDING"] == 51


def test_the_reader_sees_a_planted_difference():
    """Falsifier: the parser must fail on a block that differs from the server."""
    source = TS.read_text(encoding="utf-8").replace(
        "STRAND_COVERS: 'covers',", "STRAND_COVERS: 'covered',", 1)
    assert _client(source) != _server()
