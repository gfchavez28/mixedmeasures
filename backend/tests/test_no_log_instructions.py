"""#1268 — no sentence the backend can send a researcher tells them to check a log.

There is no log a desktop user can open: the backend logs to stderr only (`main.py`'s
`basicConfig`) and the Electron shell forwards that to its own console. Five sentences
did it anyway (`routers/project_portability.py` ×3, `routers/backup.py` before #1025, and
the Data Quality tab on the client), each a dead end at the moment the researcher is
already stuck. `routers/backup.py::BACKUP_WRITE_FAILED` is the precedent for the fix:
say the likeliest cause and the one thing they can do.

An AST scan of every STRING CONSTANT in `app/` that is not a docstring — so prose in a
comment or docstring explaining the rule (several do, e.g. `routers/backup.py`) is never
read as an offence (#772). Guarded both ways (#729/#730): a POPULATION floor on what the
walk read, and a PREDICATE falsifier that the matcher fires on each historical sentence
in every shape it took (a call argument, an f-string, a returned value).

The client and the shell are scanned by `frontend/src/lib/no-log-instructions.test.ts`.
"""

import ast
import re

from tests.guard_support import APP_DIR, app_files

#: What an instruction to read a log looks like. Deliberately broad: a false positive
#: is a sentence to reword, a false negative is the dead end this file exists to stop.
LOG_INSTRUCTION = re.compile(
    r"\bserver[\s-]?logs?\b|\b(check|see|read|open)\s+(the\s+)?(app\s+|application\s+)?logs?\b"
    r"|\blog\s+files?\b",
    re.IGNORECASE,
)

#: The five sentences #1268 found, verbatim — the falsifier's material.
HISTORICAL = (
    "Project duplicate failed. Check server logs for details.",
    "Project import failed, and nothing was changed. Check server logs for details.",
    "The merge could not be completed, and nothing was changed. Check server logs for details.",
    "Codebook import failed. Check server logs for details.",
    "Try adjusting your variable selection or check the server logs.",
)


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """`id()`s of every bare string statement (docstrings, and stray prose literals)."""
    out: set[int] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            out.add(id(node.value))
    return out


def _string_constants(tree: ast.AST) -> list[tuple[int, str]]:
    """Every string a module could put on the wire: each `str` constant that is not a
    bare statement. An f-string's literal parts are `Constant`s inside its `JoinedStr`,
    so they are reached too — and joined, so a phrase split by a placeholder is seen."""
    skip = _docstring_nodes(tree)
    # An f-string's literal parts are `Constant`s too; read once, as the joined whole.
    skip |= {
        id(v) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr)
        for v in node.values
    }
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = "".join(
                v.value for v in node.values
                if isinstance(v, ast.Constant) and isinstance(v.value, str)
            )
            found.append((node.lineno, text))
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in skip
        ):
            found.append((node.lineno, node.value))
    return found


def _offences(tree: ast.AST) -> list[tuple[int, str]]:
    return [(line, s) for line, s in _string_constants(tree) if LOG_INSTRUCTION.search(s)]


def test_no_backend_string_sends_a_researcher_to_a_log():
    files = app_files(
        floor=150,
        sentinels=("routers/project_portability.py", "routers/backup.py"),
    )
    offences: list[str] = []
    strings_read = 0
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        strings_read += len(_string_constants(tree))
        offences += [
            f"{path.relative_to(APP_DIR)}:{line}: {text!r}" for line, text in _offences(tree)
        ]
    # POPULATION: the walk read strings at all. Thousands exist (every error sentence,
    # every query fragment); the floor detects a scan gone blind, not growth.
    assert strings_read > 3000, f"only {strings_read} string constants read — the scan is blind"
    assert not offences, (
        "A sentence tells the researcher to check a log, and a desktop install has none they "
        "can open (#1268). Say the likeliest cause and what they can do instead — "
        "routers/backup.py::BACKUP_WRITE_FAILED is the precedent:\n  " + "\n  ".join(offences)
    )


def test_the_matcher_fires_on_every_historical_sentence_in_every_shape():
    """PREDICATE falsifier: each of #1268's five sentences, as a call argument, an
    f-string with a placeholder before the phrase, and a returned value, is found."""
    for sentence in HISTORICAL:
        head, _, tail = sentence.partition(". ")
        src = "\n".join([
            f"raise HTTPException(500, {sentence!r})",
            f"def f(failed):\n    return f'{{failed}}. {tail}'" if tail else "",
            f"MESSAGE = ({head!r} '. ' {tail!r})" if tail else "",
        ])
        hits = _offences(ast.parse(src))
        assert hits, f"the matcher missed {sentence!r}"
        assert len(hits) == (3 if tail else 1), (sentence, hits)


def test_prose_about_the_rule_is_not_an_offence():
    """A docstring or comment explaining why a sentence must not say "check the server
    logs" is the rule's own documentation, never a violation (#772)."""
    src = (
        '"""Module prose: it used to end "Check server logs for details."."""\n'
        "def f():\n"
        '    """It said check the server logs, which a desktop user cannot."""\n'
        "    # and a comment: check the server logs\n"
        '    return "The backup could not be written."\n'
    )
    assert _offences(ast.parse(src)) == []
    assert [s for _, s in _string_constants(ast.parse(src))] == ["The backup could not be written."]
