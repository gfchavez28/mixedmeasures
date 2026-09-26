"""#1007: the client refuses an over-limit file at SELECTION, so its number must
be the server's.

`frontend/src/lib/upload-limits.ts::MAX_IMPORT_FILE_BYTES` mirrors
`routers/helpers.py::MAX_UPLOAD_SIZE`. If the client's is SMALLER it refuses files
the server would take; if LARGER it accepts files and times them, and the server
refuses after Next — which is the defect #1007 fixed. This reads the TypeScript
rather than pinning a literal on each side, so the two cannot disagree without
this failing.
"""

import re
from pathlib import Path

from app.routers.helpers import MAX_UPLOAD_SIZE

_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "upload-limits.ts"
def _client_limit(name: str = "MAX_IMPORT_FILE_BYTES") -> int:
    match = re.search(rf"export const {name} = ([0-9 *]+)\n", _TS.read_text(encoding="utf-8"))
    assert match, f"{name} not found as a product of integers in {_TS}"
    product = 1
    for factor in match.group(1).split("*"):
        product *= int(factor.strip())
    return product


def test_the_client_limit_is_the_servers():
    assert _client_limit() == MAX_UPLOAD_SIZE


def test_the_parse_reads_a_real_number():
    # Guard the guard: a regex that matched something else would still compare.
    assert _client_limit() > 1024 * 1024


def test_the_client_project_file_limit_is_the_servers():
    # #1012: the merge page refuses an over-limit .mmproject at selection, so its
    # number must be the server's — a larger client number would let the server
    # refuse after the upload and report it as "could not be read".
    from app.services.project_portability import MAX_UPLOAD_SIZE as PROJECT_MAX

    assert _client_limit("MAX_PROJECT_FILE_BYTES") == PROJECT_MAX
    assert PROJECT_MAX != MAX_UPLOAD_SIZE  # the two limits are distinct on purpose
