"""#1534 D110 (1.5.9) — the committed map of every route's declared request names equals the app.

`frontend/src/lib/api/route-params.json` is what the client's request-contract test
(`lib/api/request-contract.test.ts`) holds every `lib/api` request against. It is only a
guard while it is TRUE, so this side fails the moment a route's declared names change and
the map was not regenerated — like a lockfile. The why (two silent drops, one since the
feature was written) is in `scripts/route_params.py`'s docstring.

⚠️ The frontend tree must be PRESENT, and its absence FAILS rather than skips (#642: a skip
reports green) — the same stance as `test_wire_fields_reach_the_client.py`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND / "scripts"))
import route_params  # noqa: E402

from app.main import app  # noqa: E402


def test_the_committed_map_equals_the_app():
    assert route_params.MAP_PATH.exists(), f"{route_params.MAP_PATH} is missing"
    committed = route_params.MAP_PATH.read_text(encoding="utf-8")
    built = route_params.render(route_params.build_route_params(app))
    if committed != built:
        old, new = json.loads(committed), json.loads(built)
        changed = sorted(
            k for k in set(old) | set(new) if old.get(k) != new.get(k)
        )
        raise AssertionError(
            "frontend/src/lib/api/route-params.json is out of date for "
            f"{len(changed)} operation(s), e.g. {changed[:5]}. Regenerate it from backend/: "
            "`python scripts/route_params.py --write` — then the client's "
            "request-contract.test.ts checks every request against the new names."
        )


def test_the_map_is_the_api_population():
    """POPULATION + DISCRIMINATION: the map holds the API (a build that walked nothing would
    equal an empty file), and it carries the two names #1534 was about — so a map built
    from the wrong app, or one that lost its query arm, cannot pass."""
    built = route_params.build_route_params(app)
    assert len(built) > 300, len(built)
    assert all(k.split(" ", 1)[1].startswith("/api/") for k in built)
    assert "filters_json" in built["GET /api/projects/{project_id}/text-analysis/export"]["query"]
    assert "include_sources" in built["GET /api/projects/{project_id}/export/excel"]["query"]
    body = built["POST /api/projects/{project_id}/text-analysis/filtered-frequencies"]["body"]
    assert body is not None and "filters" in body


def test_the_catch_all_and_health_are_left_out():
    """`GET /{full_path:path}` exists only where `frontend/dist` was built (never in CI's
    backend job); keeping it out keeps the map machine-independent."""
    built = route_params.build_route_params(app)
    assert not any("{full_path" in k for k in built)
    assert "GET /health" not in built
