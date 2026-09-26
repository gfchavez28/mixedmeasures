"""Peak memory of `preview_dataset_csv`, by corpus shape (#973 b).

`MAX_DATASET_CELLS` is enforced during the preview, and #973 asked what a
SECOND bound — on the parse itself — would have to count: "bytes? columns?
widest row?". This harness answers it by falsification rather than by fitting:
the shapes are chosen so that each candidate unit predicts a DIFFERENT
ordering, so a wrong candidate produces a visibly wrong prediction.

  F  50,000 x  40 x  8ch   2.0M cells,  18 MB   the baseline
  I   5,000 x 400 x  8ch   2.0M cells,  18 MB   same cells + bytes, 10x columns
  H  50,000 x  40 x 32ch   2.0M cells,  66 MB   same cells, 3.7x bytes
  G  12,500 x  40 x  8ch   0.5M cells, 4.5 MB   a quarter of everything
  CAP  100,000 x  40 x 8ch  4.0M cells, 36 MB   AT the cap
  CAPW  10,000 x 400 x 8ch  4.0M cells, 36 MB   at the cap, wide-shallow

  columns / widest row  ⇒ I >> F  and  CAPW >> CAP
  cells                 ⇒ F ≈ I ≈ H,  G ≈ F/4
  bytes                 ⇒ H >> F ≈ I

🔴 **Run ONE CASE PER PROCESS** — `ru_maxrss` is a high-water mark and cannot be
reset, so a second case in the same process reports the first one's peak:

    for k in F G H I CAP CAPW; do python scripts/measure_preview_memory.py $k preview; done

⚠️ **Compare against the REAL corpora before drawing a bound from this.** The
synthetic cases are denser than survey data (distinct 8-char values everywhere),
and a two-term fit taken from them over-predicts the real BES corpus by 1.6x —
which is how a bound derived here would refuse a file that works today. Results,
the real-corpus figures, and what they refute: ISSUES #973.

A real corpus is its own case, so the same harness reports both (#973 b'):

    python scripts/measure_preview_memory.py file ../testdata/bes/BES_W30_most_important_issue.csv
    python scripts/measure_preview_memory.py file ../testdata/gss/GSS_with_union.xlsx

⚠️ **`after-str` is a FLOOR, not the file's size.** The synthetic builder holds a
list of row strings and the joined result at the same moment, and the `.xlsx` arm
holds the workbook and the converted text — so the gap between `after-str` and
`peak` is the number this harness exists to move, and the two columns must be
read together. Comparing one build's `peak` against another's is only honest
when `after-str` is unchanged.
"""
import resource
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SHAPES = {
    "F": (50_000, 40, 8),
    "G": (12_500, 40, 8),
    "H": (50_000, 40, 32),
    "I": (5_000, 400, 8),
    "CAP": (100_000, 40, 8),
    "CAPW": (10_000, 400, 8),
}


def build(rows: int, cols: int, width: int) -> str:
    """DISTINCT cell values.

    ⚠️ The first version of this harness wrote one repeated literal into every
    cell, and its numbers had to be thrown away: equal short values collapse
    under the allocator in a way real survey data does not, so it understated
    peak memory by roughly a third.
    """
    header = ",".join(f"C{i:04d}" for i in range(cols))
    out = [header]
    for r in range(rows):
        out.append(",".join(f"{r * cols + c:0{width}d}"[-width:] for c in range(cols)))
    return "\n".join(out) + "\n"


def peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def load_real(path: Path) -> tuple[str, str]:
    """A real corpus as CSV text, plus a label saying how it got there.

    The `.xlsx` arm goes through the SAME adapter the upload endpoint uses, so
    the workbook read (#799, 231 MB on GSS) is inside the measurement exactly as
    it is in production. That is why a `.xlsx` figure is not comparable with a
    `.csv` one of the same cell count.
    """
    if path.suffix.lower() == ".xlsx":
        from app.services.dataset_import import xlsx_to_csv_text
        text, _sheets = xlsx_to_csv_text(path.read_bytes())
        return text, "xlsx→csv"
    return path.read_text(encoding="utf-8", errors="replace").lstrip("﻿"), "csv"


def main() -> None:
    key = sys.argv[1]

    if key == "file":
        path = Path(sys.argv[2])
        phase = sys.argv[3] if len(sys.argv) > 3 else "preview"
        base = peak_mb()
        text, how = load_real(path)
        after_text = peak_mb()
        first_nl = text.find("\n")
        cols = text.count(",", 0, first_nl if first_nl >= 0 else len(text)) + 1
        rows = text.count("\n") - 1
        label = f"{path.name} ({how})"
    else:
        # "text" materialises the whole-file str only; "preview" adds the parse.
        # The gap between them is the accumulation, which is ~78% of peak at the
        # cap BEFORE #973 (b'), and is what that rewrite exists to remove.
        phase = sys.argv[2] if len(sys.argv) > 2 else "preview"
        rows, cols, width = SHAPES[key]
        base = peak_mb()
        text = build(rows, cols, width)
        after_text = peak_mb()
        label = f"{key} ({rows:,}r x {cols}c x {width}ch)"

    nbytes = len(text.encode())

    parsed_mb = None
    elapsed = None
    if phase == "preview":
        from app.services.dataset_import import preview_dataset_csv
        t = time.perf_counter()
        result = preview_dataset_csv(text)
        elapsed = time.perf_counter() - t
        parsed_mb = peak_mb()
        if key != "file":
            assert result["total_rows"] == rows, result["total_rows"]
        rows = result["total_rows"]
        cols = len(result["columns"])

    print(
        f"{label:<44} {phase:<8} "
        f"{rows * cols:>9,} cells, {nbytes / 1e6:>6.1f} MB text | "
        f"base {base:>6.1f} | after-str {after_text:>7.1f} | "
        f"peak {(parsed_mb if parsed_mb else after_text):>7.1f} MB"
        + (f" | {elapsed:>5.1f}s" if elapsed else "")
    )


if __name__ == "__main__":
    main()
