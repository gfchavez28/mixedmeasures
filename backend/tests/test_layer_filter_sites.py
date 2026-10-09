"""Every `non_consensus_filter()` call is a DECISION to keep a machine coder's rows (#1029).

`coding_layers` offers two clauses that look alike and answer different questions:

* `layer_scope_filter()` (the human arm) — *people's* coding: drops the derived
  consensus layer AND a machine coder's labels. Every "how much is coded" figure.
* `non_consensus_filter()` — drops consensus ONLY, so a machine's rows STAY. Right
  where the rows are attributed (chips, the per-coder breakdown), where a machine is
  excluded some other way (the voter roster), or where every row is data a warning
  must count.

#1029 was seven count surfaces holding the second where they meant the first — so a
model that labelled a whole column read as "every response coded". No test could see
it until a machine coder existed, and the rules file that stated the rule named ONE
module (`coding_counts.py`), so the other seven were never asked.

So this is a POPULATION pin rather than a list of the surfaces that were fixed: every
call site in `app/` is counted per file and must match the table below, whose entries
each say WHY a machine's rows belong there. A new call site fails until someone makes
that decision; a removed one fails until the table is re-derived (a stale entry would
otherwise excuse a future site in the same file).

⚠️ The export rows are open (#1060): whether each export should mean people is a
decision per export, and the table records today's state rather than endorsing it.
"""
import ast

from tests.guard_support import APP_DIR, app_files

NAME = "non_consensus_filter"

#: file (relative to app/) → (call count, why a machine's rows belong there).
ALLOWED: dict[str, tuple[int, str]] = {
    "services/coding_layers.py": (2, "the definition — the human and machine arms are built on it"),
    "services/consensus.py": (2, "the voter gather — machines are kept out at the roster (reliability_coder_clause)"),
    "services/irr.py": (1, "the rater gather — machines are kept out at the roster (reliability_coder_clause)"),
    "services/open_cut_reliability.py": (1, "the rater gather — machines are kept out at the roster"),
    "services/reconciliation.py": (1, "the grid's gather — machines are kept out at the roster"),
    "services/machine_agreement.py": (1, "names its coder set explicitly; the machine is the point"),
    "services/rating_queue.py": (1, "the caller's OWN applications only"),
    "services/coding_coverage.py": (1, "WHO coded — attribution, which names a machine by design"),
    "routers/text_coding.py": (3, "the chips payload, the per-coder breakdown, the CSV export (#1060)"),
    "routers/observations.py": (1, "freezing marks consensus stale — a mutation; over-marking is safe"),
    "services/consensus_staleness.py": (1, "marking a coder's voting passages stale (#1074) — machines are "
                                           "kept out by reliability_coder_clause beside it; a mutation"),
    "routers/search.py": (2, "a code's usage count, and one response's codes as its chips list them (#1060)"),
    "routers/codes.py": (2, "a code's usage count (a delete warning counts what it removes) and the rating strand count"),
    "routers/export.py": (3, "the codebook's usage counts and the coded-segments CSV (#1060)"),
    "routers/export_excel.py": (3, "the Ratings sheet's two arms and the codebook usage counts (#1060)"),
    "routers/export_helpers.py": (1, "the per-source code frequencies an export writes (#1060)"),
    "routers/export_r.py": (1, "the R codebook's usage counts (#1060)"),
    "services/project_portability.py": (1, "the merge reconcile's local usage figure (#1060)"),
}


def _calls(source: str) -> int:
    """How many times `non_consensus_filter` is CALLED — an AST walk, so a comment or
    a string naming it (this module's own docstring, several call sites' comments)
    is not a call."""
    count = 0
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == NAME:
                count += 1
    return count


def _sites() -> dict[str, int]:
    found: dict[str, int] = {}
    for path in app_files(
        floor=150, sentinels=("routers/text_coding.py", "services/coding_layers.py"),
    ):
        n = _calls(path.read_text())
        if n:
            found[path.relative_to(APP_DIR).as_posix()] = n
    return found


def test_every_call_site_is_a_recorded_decision():
    found = _sites()
    expected = {f: n for f, (n, _) in ALLOWED.items()}
    new = {f: n for f, n in found.items() if expected.get(f) != n}
    assert not new, (
        f"non_consensus_filter() call counts changed: {new} (the table expects "
        f"{ {f: expected.get(f) for f in new} }). It KEEPS a machine coder's rows. If "
        "the query counts how much is coded, use layer_scope_filter() (the human arm) "
        "instead — #1029. If the rows are attributed or a machine is excluded another "
        "way, add the site to ALLOWED with the reason."
    )
    gone = sorted(set(expected) - set(found))
    assert not gone, (
        f"{gone} no longer call non_consensus_filter(); remove them from ALLOWED so a "
        "stale entry cannot excuse a future call in the same file."
    )


def test_the_scan_is_not_blind():
    """POPULATION: the scan must find the definition's own two uses, or it is
    reading the wrong tree or has stopped matching calls."""
    assert _sites().get("services/coding_layers.py") == 2


def test_the_predicate_counts_calls_and_nothing_else():
    """PREDICATE falsifier: a call counts; prose and a bare reference do not."""
    assert _calls("q.filter(non_consensus_filter())") == 1
    assert _calls("q.filter(coding_layers.non_consensus_filter())") == 1
    assert _calls("# non_consensus_filter() in a comment\nx = 'non_consensus_filter()'") == 0
    assert _calls("from x import non_consensus_filter\nf = non_consensus_filter") == 0
