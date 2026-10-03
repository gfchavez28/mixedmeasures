"""#1102 — a column whose answers all come from one known scale has every answer numbered.

`_match_scale` ranked qualifying scales by FEWEST LABELS first. That was right
while matching was a strict subset (every qualifying scale held every value) and
wrong once #364 let a scale qualify with a stray or two: a smaller scale could
then win with a REAL answer counted as the stray. `agreement-5pt`'s own five
labels matched `agreement-4pt`, so the midpoint imported with no number and
Agree / Strongly agree scored 3 / 4 — in every release since v1.0.0. Nine of the
library's 76 scales failed to recognise their own labels (measured before the
fix). The ranking now puts FEWEST UNMATCHED values first.

The library-wide sweeps below are the guard: they walk EVERY scale, so a scale
added later is covered without anyone naming it here.
"""
import itertools
import json
import math

from app.models.dataset import DatasetColumn, DatasetValue
from app.models.project import Project
from app.services.dataset_import import (
    KNOWN_SCALES,
    _match_scale,
    _scale_match_within_tolerance,
    import_dataset_csv,
    preview_dataset_csv,
)

_AGREE_5 = [
    "Strongly disagree", "Disagree", "Neither agree nor disagree",
    "Agree", "Strongly agree",
]


def _lower(labels) -> frozenset[str]:
    return frozenset(label.lower() for label in labels)


class TestTheLibraryAgainstItself:
    def test_the_library_is_the_population_this_file_claims(self):
        # A floor, not a count: 76 before #1102, which added four spellings.
        assert len(KNOWN_SCALES) >= 80

    def test_every_scale_given_its_own_labels_is_recognised_as_itself(self):
        wrong = []
        for scale in KNOWN_SCALES:
            match = _match_scale(set(scale["labels"]))
            # The LIST, not the set: the order is the numbering.
            if match is None or match[1] != scale["labels"]:
                wrong.append((scale["name"], match and match[0]))
        assert wrong == []

    def test_no_answer_from_one_scale_is_left_without_a_number(self):
        """Every subset of a scale that covers at least half of it: the winner
        must account for every value. Leaving a label out is the ordinary case —
        nobody chose "Strongly disagree" — and must not orphan the rest."""
        orphaned = []
        checked = 0
        for scale in KNOWN_SCALES:
            labels = scale["labels"]
            smallest = max(2, math.ceil(len(labels) / 2))
            for size in range(smallest, len(labels) + 1):
                for subset in itertools.combinations(labels, size):
                    checked += 1
                    match = _match_scale(set(subset))
                    left_out = set(_lower(subset)) - _lower(match[1]) if match else set(subset)
                    if left_out:
                        orphaned.append((scale["name"], subset, match and match[0]))
        assert checked > 1000  # the sweep ran over the library, not over nothing
        assert orphaned == []

    def test_the_library_holds_the_shape_that_broke(self):
        """Discrimination: the sweeps above can only catch the old ranking if the
        library holds a scale nested inside a larger one with the difference
        inside #364's tolerance — the shape on which "fewest labels" picked the
        smaller scale. Were that shape ever gone, the sweeps would pass under
        either ranking and prove nothing."""
        nested = [
            (small["name"], big["name"])
            for small in KNOWN_SCALES for big in KNOWN_SCALES
            if _lower(small["labels"]) < _lower(big["labels"])
            and _scale_match_within_tolerance(
                _lower(small["labels"]), _lower(big["labels"]) - _lower(small["labels"]),
            )
        ]
        assert ("agreement-4pt", "agreement-5pt") in nested

    def test_no_two_scales_share_a_label_set(self):
        """Two entries with one label set would number a column by whichever the
        tiebreak picks — and if their ORDERS differ, by different numbers."""
        by_set: dict[frozenset[str], str] = {}
        clashes = []
        for scale in KNOWN_SCALES:
            key = _lower(scale["labels"])
            if key in by_set:
                clashes.append((by_set[key], scale["name"]))
            by_set[key] = scale["name"]
        assert clashes == []

    def test_names_are_unique_and_labels_distinct_within_a_scale(self):
        names = [s["name"] for s in KNOWN_SCALES]
        assert len(names) == len(set(names))
        assert [s["name"] for s in KNOWN_SCALES
                if len(_lower(s["labels"])) != len(s["labels"])] == []


class TestTheFiledCases:
    def test_a_five_point_agreement_column_is_five_point(self):
        assert _match_scale(set(_AGREE_5))[0] == "agreement-5pt"

    def test_the_batch_11_smoke_column(self):
        # The column that found #1102: no one chose "Strongly disagree", and
        # the midpoint is spelled "Neutral".
        match = _match_scale({"Agree", "Strongly agree", "Neutral", "Disagree"})
        assert match[0] == "agreement-5pt-neutral"

    def test_the_neutral_spelling_at_three_five_and_seven_points(self):
        assert _match_scale({"Disagree", "Neutral", "Agree"})[0] == "agreement-3pt-neutral"
        assert _match_scale(
            {"Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"},
        )[0] == "agreement-5pt-neutral"
        assert _match_scale({
            "Strongly disagree", "Disagree", "Somewhat disagree", "Neutral",
            "Somewhat agree", "Agree", "Strongly agree",
        })[0] == "agreement-7pt-neutral"

    def test_a_three_point_neither_column_is_three_point(self):
        match = _match_scale({"Disagree", "Neither agree nor disagree", "Agree"})
        assert match[0] == "agreement-3pt-neither"

    def test_a_typo_beside_the_midpoint_is_still_the_only_stray(self):
        # #364's tolerance is untouched: a misspelling still matches, and it is
        # the misspelling — not the midpoint — that is left over.
        match = _match_scale(set(_AGREE_5[:4]) | {"Srongly agree"})
        assert match[0] == "agreement-5pt"


class TestThroughTheImport:
    """Entered at the pipeline's mouth: preview → the configs the wizard sends →
    import → the numbers stored. The matcher alone could be right while the
    import numbered cells from something else."""

    @staticmethod
    def _preview_and_import(db_session, cells: list[str]):
        csv_text = "Q1\n" + "\n".join(cells) + "\n"
        col = preview_dataset_csv(csv_text)["columns"][0]
        project = Project(name="P", user_id=1)
        db_session.add(project)
        db_session.flush()
        result = import_dataset_csv(
            db=db_session,
            project_id=project.id,
            name="Scale test",
            # What `DatasetImport.tsx::buildColumnConfigs` sends back.
            column_configs=[{
                "column_index": 0,
                "column_type": col["suggested_type"],
                "column_text": col["suggested_column_text"],
                "column_code": col["suggested_column_code"],
                "scale_labels": col["suggested_scale_labels"],
                "scale_values": col["suggested_scale_values"],
            }],
            file_contents=csv_text,
        )
        column = db_session.query(DatasetColumn).filter_by(dataset_id=result["dataset_id"]).one()
        numbers = {
            v.value_text: v.value_numeric
            for v in db_session.query(DatasetValue).filter_by(column_id=column.id)
        }
        return col, column, numbers

    def test_every_answer_of_a_five_point_column_is_numbered_one_to_five(self, db_session):
        col, column, numbers = self._preview_and_import(db_session, _AGREE_5 + ["Agree"])
        assert col["suggested_scale_unmatched"] is None
        assert len(json.loads(column.scale_labels)) == 5
        assert numbers == {
            "Strongly disagree": 1.0, "Disagree": 2.0,
            "Neither agree nor disagree": 3.0,
            "Agree": 4.0, "Strongly agree": 5.0,
        }

    def test_a_neutral_midpoint_is_three(self, db_session):
        _, _, numbers = self._preview_and_import(
            db_session, ["Agree", "Strongly agree", "Neutral", "Disagree", "Agree"],
        )
        assert numbers == {"Disagree": 2.0, "Neutral": 3.0, "Agree": 4.0, "Strongly agree": 5.0}

    def test_a_real_stray_is_still_reported_and_left_without_a_number(self, db_session):
        col, _, numbers = self._preview_and_import(db_session, _AGREE_5 + ["Stongly agree"])
        assert col["suggested_scale_name"] == "agreement-5pt"
        assert col["suggested_scale_unmatched"] == ["Stongly agree"]
        assert numbers["Stongly agree"] is None
        assert numbers["Neither agree nor disagree"] == 3.0
