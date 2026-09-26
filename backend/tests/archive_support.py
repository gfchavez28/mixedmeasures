"""Reading and hand-editing a `.mmproject` in tests, after the v7 entity split (#958).

**Why this module exists.** Format v7 moved the five data-scaled entities —
`segments`, `code_applications`, `dataset_rows`, `dataset_values`, `row_scores` — out of
`project.json` into one newline-delimited zip member each. A test that reaches into an
archive to inspect or doctor a fixture used to do it with one `json.loads` of
`project.json`; after v7 that document does not contain those keys at all, so the same
line raises `KeyError` — or, worse in a test that uses `.get`, silently reads an empty
list and asserts nothing.

🔴 **So the layout is described in ONE place for tests, as it is for the product.** Every
archive-surgery site imports from here; a sixth entity, or a change of member naming, is
then one edit rather than a hunt through the suite. The product-side constant
(`project_portability.JSONL_ENTITY_KEYS`) is the source — never re-list the five here.
"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from app.services import project_portability as pp


def _zipfile(source) -> zipfile.ZipFile:
    if isinstance(source, zipfile.ZipFile):
        return source
    if isinstance(source, (bytes, bytearray)):
        return zipfile.ZipFile(io.BytesIO(source))
    if isinstance(source, io.BytesIO):
        return zipfile.ZipFile(io.BytesIO(source.getvalue()))
    return zipfile.ZipFile(str(source))


def archive_payload(source) -> dict:
    """`project.json` with every entity entry folded back in under its own key.

    The union a pre-v7 test already expected, so assertions about CONTENT are unchanged.
    Takes a path, a `BytesIO` (what `export_project` returns), raw bytes, or an open
    `ZipFile`.

    ⚠️ This MATERIALISES the entities, which is exactly what the product stopped doing.
    That is right for a fixture of a few dozen rows and wrong for a corpus — a scale
    measurement goes through `backend/scripts/measure_portability.py`, never this.
    """
    zf = _zipfile(source)
    data = json.loads(zf.read("project.json"))
    for key in pp.JSONL_ENTITY_KEYS:
        name = f"{key}.jsonl"
        if name in zf.namelist():
            data[key] = [
                json.loads(line)
                for line in zf.read(name).splitlines() if line.strip()
            ]
        else:
            data.setdefault(key, [])  # a v<=6 archive already carries it inline
    return data


def write_archive(dst: Path, manifest: dict, payload: dict, extras: dict | None = None,
                  *, inline: bool = False) -> Path:
    """Write a `.mmproject` from an edited manifest + payload.

    `inline=True` produces the v<=6 shape (every entity inside `project.json`, no
    `.jsonl` members) — that is what a test wants when the thing under test is the
    BACKWARD-COMPATIBLE path, and it is a faithful old file because every field came from
    this build's own exporter rather than from a hand-written literal.
    """
    data = dict(payload)
    entities = {key: data.pop(key, []) for key in pp.JSONL_ENTITY_KEYS}
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        zout.writestr("manifest.json", json.dumps(manifest, indent=2))
        if inline:
            zout.writestr(
                "project.json",
                json.dumps({**data, **entities}, separators=(",", ":")),
            )
        else:
            zout.writestr("project.json", json.dumps(data, separators=(",", ":")))
            for key, rows in entities.items():
                zout.writestr(
                    f"{key}.jsonl",
                    "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows),
                )
        for name, blob in (extras or {}).items():
            zout.writestr(name, blob)
    return dst


def archive_extras(source) -> dict[str, bytes]:
    """Every member that is not the manifest, `project.json` or an entity entry."""
    zf = _zipfile(source)
    entries = {f"{k}.jsonl" for k in pp.JSONL_ENTITY_KEYS}
    return {
        name: zf.read(name)
        for name in zf.namelist()
        if name not in entries and name not in ("manifest.json", "project.json")
    }


def rewrite_as_v6(src: Path, dst: Path) -> Path:
    """Turn a v7 archive into the v<=6 inline shape, manifest version included."""
    zf = _zipfile(src)
    manifest = json.loads(zf.read("manifest.json"))
    manifest["format_version"] = 6
    return write_archive(dst, manifest, archive_payload(zf), archive_extras(zf),
                         inline=True)
