"""Single source for on-disk media location + stat, shared by every media owner.

A recording lives at ``{MM_DATA_DIR}/media/{project_id}/{owner_seg}/original.{fmt}``.
``owner_seg`` is the conversation id for a conversation (legacy layout, unchanged
on disk) and ``obs-{id}`` for an observation — the prefix keeps an observation's
id from colliding with a conversation id under the same project directory
(independent PK sequences). This is the ONE place that path is computed; media.py
(conversation upload/stream/delete) and both response builders route through it.
"""
from pathlib import Path

from ..config import get_media_dir

# Owner kinds (singular — match the audit entity_type, not the URL prefix).
CONVERSATION = "conversation"
OBSERVATION = "observation"

# Observation dirs are prefixed so an observation id can't collide with a
# conversation id under the same project dir (independent PK sequences).
OBSERVATION_DIR_PREFIX = "obs-"


def media_owner_segment(owner_kind: str, owner_id: int) -> str:
    """The per-owner directory NAME under ``media/{project_id}/``.

    Split out from :func:`media_owner_dir` because `.mmproject` export/import
    needs the NAME without the base dir — portability is handed its own
    ``media_dir`` (tests pass a tmp path), so it cannot call `media_owner_dir`,
    which resolves the base from settings. Keeping the convention here means the
    archive layout and the on-disk layout can never drift apart.
    """
    if owner_kind == CONVERSATION:
        return str(owner_id)                 # legacy layout — do NOT change
    if owner_kind == OBSERVATION:
        return f"{OBSERVATION_DIR_PREFIX}{owner_id}"
    raise ValueError(f"unknown media owner_kind: {owner_kind!r}")


def parse_media_owner_segment(name: str) -> tuple[str, int] | None:
    """Inverse of :func:`media_owner_segment`: a directory name → ``(owner_kind,
    owner_id)``, or ``None`` when the name owns no media (e.g. the ``canvas``
    image dir, or a stray dir a user dropped in).

    Callers MUST treat ``None`` as "not an owner dir" rather than assuming a
    conversation — a bare ``int()`` parse is what silently swallowed observation
    media on `.mmproject` import before the Observations track.
    """
    if name.startswith(OBSERVATION_DIR_PREFIX):
        try:
            return OBSERVATION, int(name[len(OBSERVATION_DIR_PREFIX):])
        except ValueError:
            return None
    try:
        return CONVERSATION, int(name)
    except ValueError:
        return None


def media_owner_dir(project_id: int, owner_kind: str, owner_id: int) -> Path:
    """Directory holding one owner's media file."""
    return get_media_dir() / str(project_id) / media_owner_segment(owner_kind, owner_id)


def media_file_stat(
    project_id: int, owner_kind: str, owner_id: int, media_format: str | None
) -> tuple[int | None, str | None]:
    """Return ``(media_size_bytes, media_version)`` for the owner's
    ``original.{fmt}`` file, or ``(None, None)`` when nothing is attached or the
    file is missing on disk.

    ``media_version`` (#549) is an opaque ``{mtime_ns}-{size}`` cache token —
    it changes on EVERY replace (os.replace refreshes mtime), even a same-name
    re-export that ``media_filename`` can't detect, so the client can cache-bust
    the stream URL and reload mounted media.
    """
    if not media_format:
        return None, None
    path = media_owner_dir(project_id, owner_kind, owner_id) / f"original.{media_format}"
    try:
        st = path.stat()
        return st.st_size, f"{st.st_mtime_ns}-{st.st_size}"
    except OSError:
        return None, None
