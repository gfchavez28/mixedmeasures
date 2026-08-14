"""Shared safety checks for every archive we ingest — `.mmproject` and `.mmbackup`.

TWO surfaces accept a ZIP from outside this install (`project_portability.py` for
`.mmproject`, `backup.py` for `.mmbackup`), and both are files researchers routinely
mail each other, drop in shared drives, and hand to a colleague to code. They had
drifted: a bypassable path guard in one, no guard at all in the other, and no
expansion cap in either.

Keeping the two checks HERE, rather than inline at each call site, is the point of
the module — the policy has to mean the same thing on both surfaces, and the next
ingest surface should not have to rediscover it.

── Why containment, not pattern-matching (#688) ────────────────────────────────
`project_portability.py` guarded with::

    if name.startswith("/") or ".." in name:   # bypassable

That passes ``documents/1/C:/evil.txt``, and ``pathlib`` DROPS THE BASE when joined
onto a drive-qualified or UNC segment::

    PureWindowsPath('C:/Users/me/AppData/MixedMeasures/documents/7') / 'C:/evil.txt'
      -> WindowsPath('C:/evil.txt')                  <-- base discarded
    PurePosixPath('/home/me/.mm/documents/7')        / 'C:/evil.txt'
      -> PosixPath('/home/me/.mm/documents/7/C:/evil.txt')   <-- POSIX is fine

So on Windows a crafted `.mmproject` was a write-anywhere primitive. UNC
(``//server/share/...``) escapes the same way. The guard was genuinely load-bearing
there because extraction uses ``zf.open()`` + a manual join, which bypasses CPython's
own member sanitisation (``zf.extract`` applies it; ``zf.open`` does not).

Resolving both sides and asking "is the target still under the base?" subsumes the
old checks, covers drive letters, UNC, symlink-ish tricks and normalisation quirks in
one place — and stops rejecting legitimate names that merely CONTAIN ``..``
(``interview..final.wav`` was refused before).

⚠️ The check must run against the SAME path that gets opened for writing. That is why
`project_portability._extract_zip_member` calls it internally rather than each of its
three call sites doing so — a fourth call site cannot forget what it never has to
remember.

── Why an expansion cap (#696) ────────────────────────────────────────────────
``MAX_UPLOAD_SIZE`` caps the ARCHIVE, not what it expands to. Extraction streams in
1 MiB chunks so MEMORY is bounded (#567 made that deliberate), but disk is not: a
modest archive can expand to fill the volume. `.mmbackup` restore had no cap of any
kind. The `#550` staging design is careful about failure ATOMICITY — an ENOSPC
aborts with the install untouched — but "aborts cleanly after filling the disk" is
still exhaustion.

The cap reads the ZIP's own declared sizes, so it refuses BEFORE writing a byte.
That is deliberately advisory-input: a lying header cannot make us write MORE than
the real content, only less, so trusting it fails safe.
"""

from __future__ import annotations

from pathlib import Path
import zipfile

# Generous enough that no honest project or backup hits it, small enough that a
# zip bomb cannot fill a research laptop. `.mmproject`/`.mmbackup` payloads are
# dominated by media, which is already capped at 4 GB per recording upstream.
MAX_ARCHIVE_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024  # 20 GB


class ArchiveMemberEscapesError(ValueError):
    """A member would be written outside the directory it was meant to land in."""


class ArchiveTooLargeError(ValueError):
    """The archive's declared expanded size exceeds the cap."""


def assert_member_within(base_dir: Path, target_path: Path, member: str) -> None:
    """Refuse a member whose resolved target escapes ``base_dir`` (#688).

    ``base_dir`` is the directory the member is supposed to land inside;
    ``target_path`` is where the caller is about to write. Both are resolved before
    comparison so ``..`` segments, drive letters, UNC prefixes and symlinked parents
    are all judged on the real destination rather than on the string.

    Raises ``ArchiveMemberEscapesError`` (a ``ValueError``, so the existing
    ``except ValueError`` paths in both importers keep catching it).
    """
    # strict=False: neither the target nor its parents exist yet at check time —
    # we are deciding whether we are ALLOWED to create them.
    base_resolved = Path(base_dir).resolve(strict=False)
    target_resolved = Path(target_path).resolve(strict=False)

    if not target_resolved.is_relative_to(base_resolved):
        raise ArchiveMemberEscapesError(
            f"Invalid archive: member {member!r} would be written outside the "
            f"project directory (resolved to {target_resolved}). The file is "
            f"malformed or crafted; nothing was extracted."
        )


def assert_expanded_size_within_limit(
    zf: zipfile.ZipFile,
    *,
    limit: int = MAX_ARCHIVE_EXPANDED_BYTES,
    members: list[str] | None = None,
) -> int:
    """Refuse an archive whose members declare more than ``limit`` bytes (#696).

    Pass ``members`` to scope the check to the subset actually being extracted
    (restore stages `documents/` and `media/` separately); omit it to sum the whole
    archive. Returns the declared total so callers can log it.
    """
    infos = zf.infolist()
    if members is not None:
        wanted = set(members)
        infos = [i for i in infos if i.filename in wanted]

    total = sum(i.file_size for i in infos)
    if total > limit:
        raise ArchiveTooLargeError(
            f"Invalid archive: contents expand to {total / 1024 ** 3:.1f} GB, over "
            f"the {limit / 1024 ** 3:.0f} GB limit. Nothing was extracted."
        )
    return total
