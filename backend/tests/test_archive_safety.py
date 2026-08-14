"""#688 / #696 — archive ingest safety, shared by `.mmproject` and `.mmbackup`.

**#688 (containment).** `project_portability.py` guarded members with
``name.startswith("/") or ".." in name``. A Windows drive-absolute member
(``documents/1/C:/evil.txt``) passes BOTH tests, and ``pathlib`` drops the base when
joined onto a drive-qualified segment — so on Windows a crafted `.mmproject` was a
write-anywhere primitive. Extraction uses ``zf.open()`` + a manual join, which
bypasses the sanitisation CPython applies inside ``zf.extract``, so that guard was
the only defence.

**#696 (expansion cap).** ``MAX_UPLOAD_SIZE`` bounds the archive, not what it
expands to. Streaming keeps MEMORY bounded (#567); disk was not bounded at all, and
`.mmbackup` restore had no cap of any kind.

⚠️ **Why the Windows cases use ``PureWindowsPath`` rather than the real check.**
The escape is platform-dependent: ``'C:/evil.txt'`` is an ordinary relative name on
POSIX and an absolute path on Windows. Running the real `assert_member_within` on
Linux and asserting "it raises" would pass for the WRONG REASON — or not at all —
and would tell us nothing about the platform where the bug lives. So the drive-letter
and UNC cases pin the *join semantics* that make the escape possible, which is the
platform-specific half, and the containment tests pin the *check* on the host
platform. Both halves are needed; neither is sufficient.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import PurePosixPath, PureWindowsPath

import pytest

from app.services.archive_safety import (
    ArchiveMemberEscapesError,
    ArchiveTooLargeError,
    assert_expanded_size_within_limit,
    assert_member_within,
)


# ── The platform-specific half: why the old guard was bypassable ─────────────

@pytest.mark.parametrize("member_tail", ["C:/evil.txt", "C:/Windows/Temp/evil.txt"])
def test_old_pattern_guard_passes_a_drive_absolute_member(member_tail):
    """Both legs of the retired guard return False — it never had a chance."""
    name = f"documents/1/{member_tail}"
    assert not name.startswith("/")
    assert ".." not in name


def test_windows_join_discards_the_base_for_a_drive_absolute_member():
    base = PureWindowsPath("C:/Users/me/AppData/MixedMeasures/documents/7")
    escaped = base / "C:/evil.txt"
    assert str(escaped) == r"C:\evil.txt", "the base must be shown to vanish"
    assert not escaped.is_relative_to(base)


def test_windows_join_discards_the_base_for_a_unc_member():
    """UNC escapes the same way and was equally invisible to the old guard."""
    base = PureWindowsPath("C:/Users/me/AppData/MixedMeasures/documents/7")
    escaped = base / "//server/share/evil.txt"
    assert not escaped.is_relative_to(base)


def test_posix_join_is_unaffected():
    """Pins the scope of the finding: POSIX was never exposed to this."""
    base = PurePosixPath("/home/me/.mm/documents/7")
    joined = base / "C:/evil.txt"
    assert joined.is_relative_to(base)


# ── The check itself, on the host platform ──────────────────────────────────

def test_containment_allows_a_normal_nested_member(tmp_path):
    base = tmp_path / "documents" / "7"
    assert_member_within(base, base / "sub" / "original.pdf", "documents/7/sub/original.pdf")


def test_containment_refuses_a_dotdot_escape(tmp_path):
    base = tmp_path / "documents" / "7"
    with pytest.raises(ArchiveMemberEscapesError):
        assert_member_within(base, base / ".." / ".." / "evil.txt", "documents/7/../../evil.txt")


def test_containment_refuses_an_absolute_target(tmp_path):
    base = tmp_path / "documents" / "7"
    with pytest.raises(ArchiveMemberEscapesError):
        assert_member_within(base, tmp_path / "elsewhere" / "evil.txt", "evil.txt")


def test_containment_allows_a_filename_containing_dotdot(tmp_path):
    """The retired guard rejected this legitimate name; containment does not.

    `"interview..final.wav"` is a perfectly ordinary filename. Refusing it was a
    real (if minor) usability cost of pattern-matching, and fixing it is part of
    why containment is the right shape.
    """
    base = tmp_path / "media" / "3"
    assert_member_within(base, base / "interview..final.wav", "media/3/interview..final.wav")


def test_containment_message_names_the_member(tmp_path):
    """A refusal a user cannot act on is only half a fix."""
    base = tmp_path / "documents" / "7"
    with pytest.raises(ArchiveMemberEscapesError) as exc:
        assert_member_within(base, tmp_path / "evil.txt", "documents/7/../evil.txt")
    assert "documents/7/../evil.txt" in str(exc.value)
    assert "nothing was extracted" in str(exc.value).lower()


# ── The wiring: the check must be unforgettable, not merely available ────────

def test_extract_zip_member_refuses_an_escaping_target(tmp_path):
    """The containment check lives INSIDE `_extract_zip_member` (#688).

    This is the load-bearing design point. Three call sites build their own target
    path; putting the check at the call sites means a fourth one can omit it
    silently. Here it cannot: `base_dir` is a REQUIRED positional argument, so a new
    caller that forgets it fails at the call, not at runtime on a crafted file.
    """
    from app.services.project_portability import _extract_zip_member

    archive = tmp_path / "a.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("documents/1/original.pdf", b"payload")

    base = tmp_path / "out"
    escaping = tmp_path / "outside" / "evil.pdf"
    with zipfile.ZipFile(archive, "r") as zf:
        with pytest.raises(ArchiveMemberEscapesError):
            _extract_zip_member(zf, "documents/1/original.pdf", escaping, base)

    assert not escaping.exists(), "nothing may be written on a refused member"


def test_extract_zip_member_requires_base_dir():
    """Pins the signature itself — the arg must stay REQUIRED.

    A default of `None` would make the guard opt-in and silently reintroduce the
    class the moment someone adds a call site.
    """
    import inspect
    from app.services.project_portability import _extract_zip_member

    param = inspect.signature(_extract_zip_member).parameters["base_dir"]
    assert param.default is inspect.Parameter.empty


# ── #696 expansion cap ──────────────────────────────────────────────────────

def _archive_declaring(sizes: dict[str, int]) -> zipfile.ZipFile:
    """A ZIP whose members really are the declared sizes (compressible zeros)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, size in sizes.items():
            zf.writestr(name, b"\0" * size)
    buf.seek(0)
    return zipfile.ZipFile(buf, "r")


def test_expansion_cap_allows_an_ordinary_archive():
    with _archive_declaring({"database.db": 5_000, "media/1/a.mp4": 20_000}) as zf:
        assert assert_expanded_size_within_limit(zf) == 25_000


def test_expansion_cap_refuses_an_over_limit_archive():
    with _archive_declaring({"media/1/a.mp4": 50_000}) as zf:
        with pytest.raises(ArchiveTooLargeError) as exc:
            assert_expanded_size_within_limit(zf, limit=10_000)
        assert "nothing was extracted" in str(exc.value).lower()


def test_expansion_cap_is_a_zip_bomb_guard_not_a_file_size_guard():
    """The point is the RATIO: a small archive that expands enormously.

    Highly-compressible content is the whole attack — a few KB on disk declaring
    gigabytes on extraction. Asserting the compressed size is far under the limit
    while the declared size is far over it is what distinguishes this from a plain
    upload-size check (which already exists as MAX_UPLOAD_SIZE and does not help).
    """
    with _archive_declaring({"media/1/bomb.bin": 5_000_000}) as zf:
        compressed = sum(i.compress_size for i in zf.infolist())
        assert compressed < 100_000, "fixture must actually be a compression bomb"
        with pytest.raises(ArchiveTooLargeError):
            assert_expanded_size_within_limit(zf, limit=1_000_000)


def test_expansion_cap_can_be_scoped_to_a_member_subset():
    """Restore stages `documents/` and `media/` separately."""
    with _archive_declaring(
        {"database.db": 1_000, "media/1/a.mp4": 90_000, "documents/1/d.pdf": 2_000}
    ) as zf:
        media_only = assert_expanded_size_within_limit(
            zf, limit=100_000, members=["media/1/a.mp4"]
        )
        assert media_only == 90_000
        with pytest.raises(ArchiveTooLargeError):
            assert_expanded_size_within_limit(zf, limit=50_000, members=["media/1/a.mp4"])
