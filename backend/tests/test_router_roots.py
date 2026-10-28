"""The router-root rule — an endpoint at a router's root is declared `""`, never `"/"`.

`backend-invariants.md` §4: on a slash-less prefix `"/"` registers `.../resource/`,
so a slash-less request 307-redirects to the absolute backend origin — cross-origin
under Vite dev, which silently drops the credentialed body. Two legacy GET roots are
tolerated because the client deliberately calls them WITH the slash.

`statistical_tests.py::create_test` was a third, at `POST "/"`, that no rule named
(10-19 pending-decisions row 4). It worked only because the client sent the slash.

Asserted against the ROUTE TABLE, not an HTTP status: with ``frontend/dist`` present
the SPA catch-all answers paths no router declares, so a status measures the
catch-all, not the route.
"""

from fastapi.routing import APIRoute

# (method, path) — the two legacy GET roots the client calls WITH the slash.
TOLERATED_SLASH_ROOTS = {
    ("GET", "/api/projects/{project_id}/datasets/"),
    ("GET", "/api/projects/{project_id}/statistical-tests/"),
}


def _slash_routes():
    from app.main import app

    found = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue  # the SPA catch-all, docs and mounts are not router roots
        if route.path.endswith("/"):
            for method in route.methods:
                found.add((method, route.path))
    return found


def test_the_route_table_is_readable():
    # Self-check: the scan sees the app's API routes at all, so an empty
    # population cannot pass the assertion below.
    from app.main import app

    api_routes = [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api/")]
    assert len(api_routes) > 100


def test_no_endpoint_beyond_the_two_tolerated_roots_ends_in_a_slash():
    unexpected = _slash_routes() - TOLERATED_SLASH_ROOTS
    assert not unexpected, f"router-root endpoints declared with '/': {sorted(unexpected)}"


def test_the_tolerated_roots_are_still_there():
    # If one is converted to "", drop it from the allow-list in the same change,
    # so the list cannot keep tolerating a route that no longer exists.
    assert TOLERATED_SLASH_ROOTS <= _slash_routes()


def test_creating_a_saved_test_is_declared_at_the_bare_root():
    from app.main import app

    posts = {
        r.path for r in app.routes
        if isinstance(r, APIRoute) and "POST" in r.methods and r.path.startswith("/api/projects/{project_id}/statistical-tests")
    }
    assert "/api/projects/{project_id}/statistical-tests" in posts
