"""SPSS ``.sav`` → CSV adapter (#28).

Import formats are ADAPTERS at the router boundary (#523/#524): a new format
converts into CSV text in ``routers/dataset.py::_upload_to_csv_text`` and the
inference/import pipeline downstream runs unchanged. Never fork it.

Two behaviours below are load-bearing, established empirically against
pyreadstat 1.3.5 (see ``tests/test_sav_import.py``):

* **Read raw codes, never formatted labels.** ``meta.missing_ranges`` is
  populated ONLY when reading with ``user_missing=True`` — and that same read
  renders a user-missing code as its *label*. So ``apply_value_formats=True``
  cannot distinguish a real scale point from a "Refused" code, and would
  silently import "Refused" as a valid 6th point of a 5-point scale — shifting
  every mean computed on that variable, with nothing on screen to show for it.
  We take raw codes, the label map, and the missing ranges in ONE pass, then
  apply labels ourselves, blanking anything inside a missing range.

* **``output_format="dict"`` avoids importing pandas.** pandas is already an
  installed transitive (statsmodels pulls it), but nothing on a hot path
  imports it, and pyreadstat's default DataFrame output would — costing tens of
  MB of RSS against a <256 MB backend target for no gain. pyreadstat itself
  needs only narwhals (MIT) + numpy (already direct). dict output also hands
  back system-missing as ``None`` (not ``float("nan")``) and dates as
  ``datetime.date``, which keeps the cell stringifier simple.

pyreadstat is Apache-2.0 (wrapping ReadStat, MIT) — permissive, per the
license-compatibility policy.
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Structural caps: a .sav is compressed, so a small upload can inflate a lot.
# These bound the parse work independently of the 50 MB upload cap. Mirrors the
# .xlsx adapter's caps so the two formats fail the same way.
MAX_SAV_ROWS = 100_000
MAX_SAV_COLS = 500

# Widest label SPAN (max code - min code + 1) we'll fill in when an ordinal's
# labels don't cover the observed codes (#536). Endpoint-anchored Likert-style
# items (labels on 1 and 7 only) sit well under this; a 1="Low"/100="High"
# slider is far over it and is a continuous variable wearing two labels — for
# those, promotion is abandoned and the column imports as plain numbers.
MAX_SYNTH_SCALE_SPAN = 15

SAV_MAGIC = b"$FL2"  # SPSS .sav files open with this 4-byte signature


class SavImportError(ValueError):
    """User-facing .sav parse/validation failure (surfaced as HTTP 400)."""


@dataclass(frozen=True)
class SavColumnMeta:
    """Per-variable SPSS metadata the CSV text alone cannot carry.

    ``ordered_labels`` / ``ordered_values`` are parallel arrays sorted by SPSS
    code ascending, with user-missing codes removed — i.e. the real scale points
    in the order SPSS recorded them.
    """

    name: str
    measure: str | None = None          # 'nominal' | 'ordinal' | 'scale' | None
    column_label: str | None = None     # SPSS variable label (the question text)
    ordered_labels: list[str] = field(default_factory=list)
    ordered_values: list[float] = field(default_factory=list)
    # Observed codes OUTSIDE the scale (or non-integer) — #536: these import as
    # missing, so the preview must WARN (#364), never stay silent.
    stray_values: list[str] = field(default_factory=list)

    @property
    def is_labelled_ordinal(self) -> bool:
        """SPSS says ordinal AND gave us at least two real scale points.

        The gate for promoting a column to MM's ``ordinal`` type with SPSS's own
        ordering (decision D1: SPSS informs, MM infers everything else).
        """
        return self.measure == "ordinal" and len(self.ordered_labels) >= 2


def is_sav_upload(filename: str | None, content: bytes) -> bool:
    """True when the upload should take the .sav adapter path.

    Requires BOTH the extension and the magic bytes — a mis-renamed CSV falls
    through to the text path (where it may still parse), and a renamed non-SPSS
    binary fails fast instead of confusing ReadStat.
    """
    return bool(filename) and filename.lower().endswith(".sav") and content[:4] == SAV_MAGIC


def _sav_cell_to_str(value) -> str:
    """Stringify a cell the way SPSS's own save-as-CSV would (CSV parity).

    Mirrors ``dataset_import._xlsx_cell_to_str``; the two adapters must produce
    the same text for the same logical value or the shared inference downstream
    would type them differently.
    """
    if value is None:
        return ""
    if isinstance(value, bool):  # bool before int — bool is a subclass of int
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        if value != value:  # NaN — belt and braces; dict output yields None
            return ""
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return str(value)
    if isinstance(value, _dt.datetime):
        if (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (_dt.date, _dt.time)):
        return value.isoformat()
    return str(value)


def _in_missing_range(value, ranges: list[dict]) -> bool:
    """True when a raw code falls inside any declared user-missing range.

    SPSS encodes discrete missing values (up to three) as degenerate lo==hi
    ranges, so one check covers both discrete and range forms. String variables
    declare discrete missing VALUES only (no ordered ranges), which pyreadstat
    reports as lo==hi string dicts — equality, never a lexicographic range
    (#541b: these previously fell through the numeric-only guard and imported
    as data). Both branches type-check the range bound so a numeric range never
    compares against a string cell or vice versa.
    """
    if not ranges or isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return any(
            isinstance(r["lo"], (int, float)) and r["lo"] <= value <= r["hi"]
            for r in ranges
        )
    if isinstance(value, str):
        return any(isinstance(r["lo"], str) and value == r["lo"] == r["hi"] for r in ranges)
    return False


def _dedupe_labels(labels_by_code: dict) -> dict:
    """Disambiguate value labels that duplicate a string across codes (#541a).

    Two codes sharing one label are legal in SPSS (usually a copy-paste typo).
    The CSV carries label TEXT as the cell value, so once two codes emit
    identical text nothing downstream can tell them apart — the label→numeric
    map collapses last-wins and rows silently swap codes. The adapter is the
    last place the codes are known: suffix every duplicated label with its code
    ("Agree (1)" / "Agree (2)"); unique labels pass through untouched. The
    de-duped map feeds BOTH the scale points and the cell substitution, so
    cell text and scale labels stay equal.
    """
    counts: dict[str, int] = {}
    for label in labels_by_code.values():
        counts[str(label)] = counts.get(str(label), 0) + 1
    if all(n == 1 for n in counts.values()):
        return labels_by_code

    deduped = {
        code: (
            f"{label} ({_sav_cell_to_str(code)})" if counts[str(label)] > 1 else label
        )
        for code, label in labels_by_code.items()
    }
    if len({str(v) for v in deduped.values()}) != len(deduped):
        # A suffixed label collided with a pre-existing literal ("Agree (1)"
        # already taken). Degenerate input — suffix everything; codes are
        # unique, so this always resolves.
        deduped = {
            code: f"{label} ({_sav_cell_to_str(code)})"
            for code, label in labels_by_code.items()
        }
    return deduped


def _ordered_scale_points(
    labels_by_code: dict, ranges: list[dict]
) -> tuple[list[str], list[float]]:
    """Real scale points in SPSS code order, user-missing codes removed.

    Sorting by code is what recovers the order the CSV path has to guess at:
    a custom Likert scale reaches MM as 1='Strongly disagree' … 5='Strongly
    agree' rather than alphabetically.

    SPSS *string* variables may also carry value labels, keyed by string. Those
    codes sort happily but carry no numeric order to claim (and would blow up on
    ``float()``), so such a map yields no scale points at all.
    """
    if not all(
        isinstance(code, (int, float)) and not isinstance(code, bool)
        for code in labels_by_code
    ):
        return [], []

    points = sorted(
        (
            (code, label)
            for code, label in labels_by_code.items()
            if not _in_missing_range(code, ranges)
        ),
        key=lambda p: p[0],
    )
    return [str(label) for _, label in points], [float(code) for code, _ in points]


def apply_sav_metadata(
    columns: list[dict], meta_by_column: dict[str, SavColumnMeta]
) -> None:
    """Overlay SPSS's own knowledge onto MM's inferred column preview, in place.

    Decision D1 — **SPSS informs ordinal only; MM infers everything else.** The
    ``measure`` field is authoritative when it says ordinal (SPSS recorded a real
    order), but researchers routinely leave it at whatever SPSS auto-assigned, so
    nominal/scale are left to MM's inference, which already handles them.

    This is worth the threading: MM's known-scale matcher maps a 5-point agreement
    scale onto a 4-point library entry (nulling "Neutral"), and drops an unmatched
    0..3 scale to alphabetically-ordered nominal. SPSS knew both exactly.

    Identity: the SPSS variable NAME is a name, so it lands in
    ``suggested_column_name`` (which the R export uses as its identifier
    fallback), and the variable LABEL — the human-readable question — becomes
    ``suggested_column_text``. Overwriting the text without keeping the name
    would lose "satisfied" entirely, leaving only an auto-assigned "C003".
    """
    for col in columns:
        meta = meta_by_column.get(col.get("column_name") or "")
        if meta is None:
            continue

        col["suggested_column_name"] = meta.name
        if meta.column_label:
            col["suggested_column_text"] = meta.column_label

        if not meta.is_labelled_ordinal:
            continue

        col["suggested_type"] = "ordinal"
        col["suggested_scale_labels"] = list(meta.ordered_labels)
        col["suggested_scale_values"] = list(meta.ordered_values)
        # SPSS supplied the scale, so MM's guessed name and its "stray values"
        # list (#364, computed against the guessed scale) no longer describe it —
        # but observed codes OUTSIDE the SPSS scale (#536) DO need the warning:
        # they import as missing, and silence here was the data-loss bug.
        col["suggested_scale_name"] = None
        col["suggested_scale_unmatched"] = list(meta.stray_values) or None


def _reconcile_scale_coverage(
    ordered_labels: list[str],
    ordered_values: list[float],
    observed: set[float],
) -> tuple[list[str], list[float], list[str], bool]:
    """Reconcile an SPSS ordinal's label map against the codes actually observed.

    #536: SPSS practice routinely labels only the endpoints of a scale
    (1="Not at all" … 7="Extremely"). Promoting the raw label map as-is imports
    a 2-point scale and silently nulls every mid-scale response. Rules:

    * Labels cover every observed code → unchanged (D1: trust SPSS).
    * Unlabelled INTEGER codes strictly inside the labelled range → real scale
      points SPSS didn't bother labelling; synthesize them (label = the code's
      CSV string, so the cell text and the scale label meet downstream).
    * Observed codes OUTSIDE the range, or non-integer → strays: they import as
      missing (existing #364 semantics), but the preview must WARN — returned
      so ``apply_sav_metadata`` can populate ``suggested_scale_unmatched``.
    * Label span wider than ``MAX_SYNTH_SCALE_SPAN`` when filling is needed →
      a continuous variable wearing two labels, not a scale. Demote: no
      promotion, and the caller suppresses label substitution for the whole
      column so it imports as plain numbers instead of mixed text/number cells.

    Returns ``(labels, values, stray_strings, demoted)``.
    """
    labelled = set(ordered_values)
    unlabelled = observed - labelled
    if not unlabelled:
        return ordered_labels, ordered_values, [], False

    lo, hi = min(labelled), max(labelled)
    interior = {
        v for v in unlabelled if lo < v < hi and float(v).is_integer()
    }
    strays = sorted(unlabelled - interior)

    if interior and (hi - lo + 1) > MAX_SYNTH_SCALE_SPAN:
        return [], [], [], True

    by_code = dict(zip(ordered_values, ordered_labels))
    for code in interior:
        by_code[code] = _sav_cell_to_str(code)
    merged = sorted(by_code.items())
    return (
        [label for _, label in merged],
        [code for code, _ in merged],
        [_sav_cell_to_str(v) for v in strays],
        False,
    )


def sav_to_csv_text(content: bytes) -> tuple[str, dict[str, SavColumnMeta]]:
    """Convert an SPSS ``.sav`` upload into CSV text plus per-column metadata.

    Returns ``(csv_text, meta_by_column_name)``. The CSV carries value LABELS as
    cell text (matching how MM keys everything on ``value_text``); the metadata
    carries what CSV cannot express — SPSS's measure, variable label, and the
    ordered scale points.

    Raises SavImportError for anything the user should fix (unreadable file,
    empty data, over-cap dimensions).
    """
    import pyreadstat

    # Cap BEFORE the full read: the upload is capped at 50 MB, but .sav is
    # compressed, so a small file can still declare millions of rows.
    # output_format="dict" here too — the DEFAULT is a DataFrame, so omitting it
    # imports pandas even for a metadata-only read (measured, not assumed).
    try:
        _, meta = pyreadstat.read_sav(
            io.BytesIO(content), metadataonly=True, output_format="dict"
        )
    except Exception as e:  # pyreadstat raises ReadstatError + assorted others
        logger.warning("sav metadata read failed: %s", e)
        raise SavImportError(f"Unable to read the SPSS file: {e}") from e

    if meta.number_columns and meta.number_columns > MAX_SAV_COLS:
        raise SavImportError(f"The SPSS file has more than {MAX_SAV_COLS} variables.")
    if meta.number_rows and meta.number_rows > MAX_SAV_ROWS:
        raise SavImportError(
            f"The SPSS file has more than {MAX_SAV_ROWS:,} rows. "
            "Split the data into smaller files and import them separately."
        )

    # user_missing=True is what populates `missing_ranges`; apply_value_formats
    # stays OFF so we see raw codes and can tell a scale point from a missing
    # code. See the module docstring — this pairing is not optional.
    # row_limit bounds the read ITSELF (#539): the header cap above trusts
    # meta.number_rows, which SPSS writers may legally record as -1 ("unknown"),
    # and an unbounded dict-of-lists read of such a file is the OOM vector the
    # cap exists to close. +1 so "we hit the limit" is distinguishable below.
    try:
        data, meta = pyreadstat.read_sav(
            io.BytesIO(content),
            user_missing=True,
            apply_value_formats=False,
            output_format="dict",
            row_limit=MAX_SAV_ROWS + 1,
        )
    except Exception as e:
        logger.warning("sav read failed: %s", e)
        raise SavImportError(f"Unable to read the SPSS file: {e}") from e

    names: list[str] = list(meta.column_names or [])
    if not names:
        raise SavImportError("The SPSS file contains no variables.")

    row_count = len(data[names[0]]) if names[0] in data else 0
    if row_count > MAX_SAV_ROWS:
        raise SavImportError(
            f"The SPSS file has more than {MAX_SAV_ROWS:,} rows. "
            "Split the data into smaller files and import them separately."
        )

    # #541a: de-dup ONCE at the source so scale points and cell substitution
    # consume the same disambiguated map.
    value_labels = {
        name: _dedupe_labels(labels)
        for name, labels in (meta.variable_value_labels or {}).items()
    }
    missing = meta.missing_ranges or {}
    measures = meta.variable_measure or {}
    col_labels = dict(zip(names, meta.column_labels or []))

    meta_by_column: dict[str, SavColumnMeta] = {}
    suppress_labels: set[str] = set()  # #536 demoted columns import as raw numbers
    for name in names:
        ordered_labels, ordered_values = _ordered_scale_points(
            value_labels.get(name, {}), missing.get(name, [])
        )
        stray_values: list[str] = []
        # Ordinal-promotion candidates get their label map reconciled against
        # the codes actually observed (#536) — partial labelling is routine in
        # SPSS and must not silently null the unlabelled responses.
        if measures.get(name) == "ordinal" and len(ordered_labels) >= 2:
            ranges = missing.get(name, [])
            observed = {
                float(v)
                for v in data.get(name, [])
                if isinstance(v, (int, float))
                and not isinstance(v, bool)
                and v == v  # NaN guard — dict output yields None, belt and braces
                and not _in_missing_range(v, ranges)
            }
            ordered_labels, ordered_values, stray_values, demoted = (
                _reconcile_scale_coverage(ordered_labels, ordered_values, observed)
            )
            if demoted:
                suppress_labels.add(name)
        elif measures.get(name) == "ordinal" and len(ordered_labels) == 1:
            # #555c: a lone labelled code (an anchor like 1="Not at all" on a
            # 1..7 slider) is not a scale — substituting it would leave mixed
            # text/number cells, the exact shape the demote branch above
            # exists to prevent. Suppress substitution column-wide: the column
            # imports as plain numbers, the SPSS variable label still overlays
            # the preview, and the anchor stays available on this meta record.
            suppress_labels.add(name)
        meta_by_column[name] = SavColumnMeta(
            name=name,
            measure=measures.get(name),
            column_label=col_labels.get(name) or None,
            ordered_labels=ordered_labels,
            ordered_values=ordered_values,
            stray_values=stray_values,
        )

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(names)

    for i in range(row_count):
        row: list[str] = []
        for name in names:
            raw = data[name][i]
            if _in_missing_range(raw, missing.get(name, [])):
                row.append("")  # a user-missing code is missing, not a scale point
                continue
            # A demoted column (#536) emits raw codes throughout — substituting
            # its two endpoint labels would leave mixed text/number cells.
            labels = None if name in suppress_labels else value_labels.get(name)
            if labels and raw in labels:
                row.append(str(labels[raw]))
                continue
            row.append(_sav_cell_to_str(raw))
        writer.writerow(row)

    if row_count == 0:
        raise SavImportError("The SPSS file has no data rows.")

    return out.getvalue(), meta_by_column
