"""#1534 D110 (1.5.9) — the map of every `/api` route's declared request names.

**Why it exists.** FastAPI drops a query parameter a route does not declare, and a
Pydantic body model (production keeps ``extra='ignore'``) drops an undeclared field —
both without a word. The Cross-analysis CSV's client sent ``filters`` to a route reading
``filters_json`` from the day it was written, so no release ever filtered the file; the
Export dialog's *Summaries* box sent ``include_summaries`` after #895 renamed the route's
option to ``include_sources``. Each half's tests passed against its own idea of the
name: the backend tests call endpoints directly (no query string is parsed), the
frontend tests mock the request.

**What it is.** One JSON file, ``frontend/src/lib/api/route-params.json``, mapping
``"METHOD /api/path"`` to the route's declared query names and JSON body field names
(``"*"`` for a body with no named fields, ``null`` for none). Two consumers hold it
honest from both sides:

- ``backend/tests/test_route_params_map.py`` — the committed map must EQUAL this
  module's build from ``app.openapi()``, so a route change fails until the map is
  regenerated (like a lockfile);
- ``frontend/src/lib/api/request-contract.test.ts`` — every ``lib/api`` request's
  keys, resolved with the TypeScript checker, must be declared in it.

**Only ``/api/`` paths.** ``main.py``'s SPA catch-all (``GET /{full_path:path}``) exists
only where ``frontend/dist`` has been built — never in CI's backend job — and ``/health``
has no client caller here; including either would make the map depend on the machine.

Usage (from ``backend/``, the venv active)::

    python scripts/route_params.py            # check: exit 1 and say what differs
    python scripts/route_params.py --write    # regenerate the committed map

The app's writable paths are pointed at a temporary folder and the database at
``:memory:`` BEFORE any app import (``get_settings()`` is cached), so the script never
opens ``dev.db`` or writes beside it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
MAP_PATH = BACKEND.parent / "frontend" / "src" / "lib" / "api" / "route-params.json"


def _body_fields(op: dict, components: dict) -> list[str] | str | None:
    content = (op.get("requestBody") or {}).get("content") or {}
    if "application/json" not in content:
        return None
    schema = content["application/json"].get("schema") or {}
    # `Model | None` bodies arrive as anyOf; the named model is the shape.
    for alt in schema.get("anyOf", []):
        if "$ref" in alt:
            schema = alt
            break
    if "$ref" in schema:
        schema = components["schemas"][schema["$ref"].rsplit("/", 1)[1]]
    props = schema.get("properties")
    return sorted(props) if props else "*"


def build_route_params(app) -> dict[str, dict]:
    """``{"METHOD /api/path": {"query": [...], "body": [...] | "*" | None}}``, sorted."""
    spec = app.openapi()
    components = spec.get("components", {})
    out: dict[str, dict] = {}
    for path, item in spec["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, op in item.items():
            query = sorted({p["name"] for p in op.get("parameters", []) if p.get("in") == "query"})
            out[f"{method.upper()} {path}"] = {"query": query, "body": _body_fields(op, components)}
    return dict(sorted(out.items()))


def render(route_params: dict) -> str:
    return json.dumps(route_params, indent=1, sort_keys=True) + "\n"


def _load_app():
    scratch = tempfile.mkdtemp(prefix="mm-route-params-")
    os.environ.setdefault("MM_DATABASE_PATH", ":memory:")
    os.environ.setdefault("MM_DATA_DIR", os.path.join(scratch, "data"))
    os.environ.setdefault("MM_BACKUP_DIR", os.path.join(scratch, "backups"))
    sys.path.insert(0, str(BACKEND))
    from app.main import app  # noqa: E402 — after the env pins, on purpose
    return app


def main(argv: list[str]) -> int:
    built = render(build_route_params(_load_app()))
    if "--write" in argv:
        MAP_PATH.write_text(built, encoding="utf-8")
        print(f"route_params: wrote {MAP_PATH} ({built.count(chr(10))} lines)")
        return 0
    current = MAP_PATH.read_text(encoding="utf-8") if MAP_PATH.exists() else ""
    if current == built:
        print("route_params: the committed map matches the app")
        return 0
    print(f"route_params: {MAP_PATH} is out of date — run: python scripts/route_params.py --write")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
