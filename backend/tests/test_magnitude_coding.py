"""#35 magnitude coding — the declared instrument and the per-application rating.

Scope: `services/magnitude.py` (the three questions), the scale-declaration
endpoint, and the rating write paths on `routers/coding.py`.

🔴 **The fixture scale is deliberately −1…+1, not 0–10.** The headline rule of this
feature is that an UNRATED application and a rating of ZERO are different facts, and
on a 0–10 scale that distinction is easy to assert accidentally — `0` sits on the
boundary, so a `if not magnitude` slip and a correct implementation agree about
almost everything. On −1…+1 zero is INTERIOR and meaningful ("neither"), which makes
the two implementations produce different answers. The degenerate-fixture rule from
`tests/the internal design notes, applied to the axis this feature actually generalises.
"""
import asyncio

import pytest

from app.models.project import Project
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.user import User

from app.services import magnitude
from app.schemas.code import MagnitudeScaleUpdate, MagnitudeScale, MagnitudeAnchor
from app.schemas.coding import ApplyCodeRequest, MagnitudeValueUpdate
from app.routers.codes import set_magnitude_scale
from app.routers.coding import apply_code, set_code_magnitude


BIPOLAR = {
    "min": -1.0,
    "max": 1.0,
    "step": 0.5,
    "anchors": [
        {"value": -1.0, "label": "strongly negative"},
        {"value": 0.0, "label": "neither"},
        {"value": 1.0, "label": "strongly positive"},
    ],
}


@pytest.fixture
def project(db_session):
    """One project, one conversation, one segment, a scaled code and a plain one."""
    db = db_session
    db.add_all([
        Project(id=900, name="Magnitude", user_id=1),
        Conversation(id=900, project_id=900, name="Interview"),
        Segment(id=9000, conversation_id=900, sequence_order=0, text="a segment"),
        Segment(id=9001, conversation_id=900, sequence_order=1, text="another"),
        # The scaled code. −1…+1 so zero is interior (see module docstring).
        Code(id=901, project_id=900, name="District support", numeric_id=2,
             is_active=True, is_universal=False,
             magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
        # No scale declared.
        Code(id=902, project_id=900, name="Pacing adherence", numeric_id=3,
             is_active=True, is_universal=False),
        # Universal — refused a scale by construction.
        Code(id=903, project_id=900, name="Unclear", numeric_id=1,
             is_active=True, is_universal=True),
        User(id=2, username="colleague", password_hash=None),
    ])
    db.flush()
    return db


def _user(db, uid=1):
    return db.get(User, uid)


# ───────────────────────────── 1. the declaration ──────────────────────────────

class TestNormalizeScale:
    def test_a_well_formed_scale_round_trips(self):
        out = magnitude.normalize_scale(BIPOLAR)
        assert out["min"] == -1.0 and out["max"] == 1.0 and out["step"] == 0.5
        assert [a["value"] for a in out["anchors"]] == [-1.0, 0.0, 1.0]

    def test_none_passes_through_as_CLEAR(self):
        """🔴 `None` means "this code no longer has a scale" and must not become {}.

        Normalising it to an empty object would turn a clear instruction into its
        opposite — the inverted-instruction failure #816 documents for
        `treat_as_empty`, where collapsing `None` to `[]` reversed the meaning.
        """
        assert magnitude.normalize_scale(None) is None

    def test_max_must_exceed_min(self):
        with pytest.raises(magnitude.MagnitudeError, match="greater than"):
            magnitude.normalize_scale({"min": 5, "max": 5})

    def test_non_finite_bounds_are_refused(self):
        """A bare `Infinity` is legal JSON on the way in and cannot be serialized out.

        starlette renders with `allow_nan=False`, so one that reaches the wire
        raises at RESPONSE time — a 500 on a request that computed fine (#689).
        """
        with pytest.raises(magnitude.MagnitudeError, match="finite"):
            magnitude.normalize_scale({"min": 0, "max": float("inf")})
        with pytest.raises(magnitude.MagnitudeError, match="finite"):
            magnitude.normalize_scale({"min": float("nan"), "max": 1})

    def test_an_anchor_outside_the_range_is_refused(self):
        with pytest.raises(magnitude.MagnitudeError, match="outside"):
            magnitude.normalize_scale(
                {"min": 0, "max": 10, "anchors": [{"value": 11, "label": "off the end"}]}
            )

    def test_two_anchors_on_one_value_are_refused(self):
        with pytest.raises(magnitude.MagnitudeError, match="both label"):
            magnitude.normalize_scale({
                "min": 0, "max": 10,
                "anchors": [{"value": 5, "label": "mid"}, {"value": 5, "label": "middle"}],
            })

    def test_a_step_larger_than_the_range_is_refused(self):
        with pytest.raises(magnitude.MagnitudeError, match="Step"):
            magnitude.normalize_scale({"min": 0, "max": 2, "step": 5})

    def test_anchors_are_sorted_so_display_order_is_not_a_caller_concern(self):
        out = magnitude.normalize_scale({
            "min": 0, "max": 10,
            "anchors": [{"value": 10, "label": "high"}, {"value": 0, "label": "low"}],
        })
        assert [a["value"] for a in out["anchors"]] == [0.0, 10.0]


class TestHasScale:
    def test_a_half_declared_scale_is_not_a_scale(self, project):
        """Both bounds or neither — a min with no max has no range to normalise against."""
        code = project.get(Code, 902)
        code.magnitude_min = 0.0
        assert magnitude.has_scale(code) is False


# ───────────────────────────── 2. the value ────────────────────────────────────

class TestValidateValue:
    def test_none_is_always_legal_and_means_unrated(self, project):
        assert magnitude.validate_value(project.get(Code, 901), None) is None

    def test_none_is_legal_even_on_a_code_with_no_scale(self, project):
        """An explicit skip must not depend on a scale existing."""
        assert magnitude.validate_value(project.get(Code, 902), None) is None

    def test_zero_is_a_REAL_RATING_on_a_scale_that_contains_it(self, project):
        """🔴 The headline rule, asserted where a falsy-zero slip would show.

        On this fixture's −1…+1 scale, 0 is "neither" — an interior, meaningful
        answer. An implementation that treats `not value` as "unrated" returns
        None here and passes on any 0–10 fixture where 0 is the floor.
        """
        assert magnitude.validate_value(project.get(Code, 901), 0.0) == 0.0

    def test_a_value_outside_the_declared_range_is_refused(self, project):
        with pytest.raises(magnitude.MagnitudeError, match="outside"):
            magnitude.validate_value(project.get(Code, 901), 2.0)

    def test_a_code_with_no_scale_cannot_be_rated(self, project):
        with pytest.raises(magnitude.MagnitudeError, match="no rating scale"):
            magnitude.validate_value(project.get(Code, 902), 1.0)

    def test_a_universal_code_cannot_be_rated(self, project):
        with pytest.raises(magnitude.MagnitudeError, match="Universal"):
            magnitude.validate_value(project.get(Code, 903), 1.0)

    def test_non_finite_ratings_are_refused(self, project):
        with pytest.raises(magnitude.MagnitudeError, match="finite"):
            magnitude.validate_value(project.get(Code, 901), float("inf"))


class TestStranding:
    def test_narrowing_counts_the_ratings_it_would_orphan(self):
        assert magnitude.scale_change_would_strand(
            [-1.0, 0.0, 1.0], {"min": 0.0, "max": 1.0, "step": 1, "anchors": []}
        ) == 1

    def test_clearing_a_scale_strands_nothing(self):
        """Values survive a clear; they merely stop being interpretable. Recoverable."""
        assert magnitude.scale_change_would_strand([-1.0, 0.0, 1.0], None) == 0


class TestDescribeValue:
    def test_unrated_says_so_and_never_says_zero(self, project):
        assert magnitude.describe_value(project.get(Code, 901), None) == "not rated"

    def test_a_bare_number_is_not_a_rating_so_the_scale_travels_with_it(self, project):
        """The visible track is decorative; this string carries the whole fact (#753)."""
        spoken = magnitude.describe_value(project.get(Code, 901), 0.0)
        assert "scale from -1 to 1" in spoken

    def test_an_anchor_label_is_spoken_when_the_value_has_one(self, project):
        code = project.get(Code, 901)
        magnitude.write_scale(code, magnitude.normalize_scale(BIPOLAR))
        assert "neither" in magnitude.describe_value(code, 0.0)

    def test_formatting_is_integer_aware(self, project):
        """`str(10.0)` reads aloud as "ten point oh out of ten point oh"."""
        code = project.get(Code, 902)
        magnitude.write_scale(code, magnitude.normalize_scale({"min": 0, "max": 10}))
        assert magnitude.describe_value(code, 8.0) == "8 out of 10"


# ───────────────────────────── 3. the endpoints ────────────────────────────────

class TestScaleEndpoint:
    def test_declaring_a_scale_returns_it_on_the_code(self, project):
        db = project
        resp = set_magnitude_scale(
            900, 902,
            MagnitudeScaleUpdate(scale=MagnitudeScale(
                min=0, max=10, step=1,
                anchors=[MagnitudeAnchor(value=0, label="none")],
            )),
            user=_user(db), db=db,
        )
        assert resp.magnitude_scale is not None
        assert resp.magnitude_scale.max == 10
        assert resp.magnitude_scale.anchors[0].label == "none"

    def test_a_universal_code_is_refused_a_scale_with_a_reason(self, project):
        from fastapi import HTTPException
        db = project
        with pytest.raises(HTTPException) as exc:
            set_magnitude_scale(
                900, 903,
                MagnitudeScaleUpdate(scale=MagnitudeScale(min=0, max=10)),
                user=_user(db), db=db,
            )
        assert exc.value.status_code == 400
        assert "Universal" in exc.value.detail

    def test_narrowing_a_scale_that_would_strand_ratings_is_refused_by_COUNT(self, project):
        """The refusal names how many, because "some" is not actionable.

        Clamping was rejected: a clamped rating is a number no coder ever gave and
        is indistinguishable afterwards from one they did.
        """
        from fastapi import HTTPException
        db = project
        db.add_all([
            CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=-1.0),
            CodeApplication(segment_id=9001, code_id=901, user_id=1, magnitude=0.0),
        ])
        db.flush()
        with pytest.raises(HTTPException) as exc:
            set_magnitude_scale(
                900, 901,
                MagnitudeScaleUpdate(scale=MagnitudeScale(min=0, max=1)),
                user=_user(db), db=db,
            )
        assert exc.value.status_code == 400
        assert "1 existing rating" in exc.value.detail

    def test_clearing_a_scale_is_allowed_even_with_ratings_present(self, project):
        db = project
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=-1.0))
        db.flush()
        resp = set_magnitude_scale(
            900, 901, MagnitudeScaleUpdate(scale=None), user=_user(db), db=db,
        )
        assert resp.magnitude_scale is None
        # The rating itself survives — it is the researcher's data, not the scale's.
        app = db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one()
        assert app.magnitude == -1.0


class TestApplyWithRating:
    def test_a_rating_supplied_at_apply_time_is_stored(self, project):
        db = project
        resp = asyncio.run(apply_code(
            9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db,
        ))
        assert resp.magnitude == 0.5

    def test_an_out_of_range_rating_refuses_BEFORE_the_code_is_applied(self, project):
        """A bad value must not half-apply a code."""
        from fastapi import HTTPException
        db = project
        with pytest.raises(HTTPException):
            asyncio.run(apply_code(
                9000, 901, ApplyCodeRequest(magnitude=99), user=_user(db), db=db,
            ))
        assert db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).count() == 0

    def test_omitting_the_field_leaves_an_existing_rating_ALONE(self, project):
        """🔴 Omitted and explicit-null are different instructions.

        If they were collapsed, every ordinary re-apply (the chord pressed twice,
        a retry) would silently unrate an already-rated application.
        """
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        app = db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one()
        assert app.magnitude == 0.5

    def test_an_explicit_null_clears_the_rating(self, project):
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=None), user=_user(db), db=db))
        app = db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one()
        assert app.magnitude is None


class TestRatingEndpoint:
    def test_setting_a_rating_on_an_applied_code(self, project):
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        resp = set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=-0.5), user=_user(db), db=db,
        )
        assert resp.magnitude == -0.5

    def test_zero_survives_the_round_trip(self, project):
        """The falsy-zero trap, at the write path rather than the validator."""
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=0.0), user=_user(db), db=db,
        )
        app = db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one()
        assert app.magnitude == 0.0
        assert app.magnitude is not None

    def test_null_unrates_and_does_not_write_zero(self, project):
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=None), user=_user(db), db=db,
        )
        app = db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one()
        assert app.magnitude is None

    def test_rating_a_code_you_have_not_applied_is_a_404_that_says_why(self, project):
        from fastapi import HTTPException
        db = project
        with pytest.raises(HTTPException) as exc:
            set_code_magnitude(
                9000, 901, MagnitudeValueUpdate(magnitude=0.5), user=_user(db), db=db,
            )
        assert exc.value.status_code == 404
        assert "nothing to rate" in exc.value.detail

    def test_a_rating_NEVER_touches_a_COLLEAGUES_application(self, project):
        """🔴 A rating is one coder's judgement.

        Overwriting a colleague's would fabricate agreement — the one thing a
        reliability statistic must never be handed.

        🔴 **THE CALLER IS USER 2 AND THE COLLEAGUE IS USER 1, DELIBERATELY. Do not
        "simplify" this by making the caller user 1.** Mutation-testing found the
        obvious arrangement to be DEGENERATE on the exact axis under test:
        `ix_code_applications_seg_code_user_unique` is keyed
        `(segment_id, code_id, user_id)`, so SQLite satisfies this filter from that
        index and an unscoped `.first()` returns the LOWEST `user_id`'s row. With
        user 1 calling, a query that had lost its `user_id` filter still picked
        user 1's row — by luck — and the test passed under the mutant.

        Measured: with the filter removed, `BEFORE [(1, user 2, 1.0), (2, user 1,
        None)]` → `.first()` returned row 2. Inverting the ids makes the wrong row
        the one the index offers first, and the mutant dies.

        (Local-roster mode is the default, so a non-owner coder legitimately acts
        on the project — that is what the shared roster is for.)
        """
        db = project
        # The colleague is user 1: LOWER id, so an unscoped query reaches them first.
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=1.0))
        db.flush()
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db, 2), db=db))
        set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=-1.0), user=_user(db, 2), db=db,
        )
        colleague = db.query(CodeApplication).filter_by(
            segment_id=9000, code_id=901, user_id=1).one()
        assert colleague.magnitude == 1.0, "a colleague's rating was overwritten"
        # Positive control: the test must not pass by the endpoint doing nothing.
        mine = db.query(CodeApplication).filter_by(
            segment_id=9000, code_id=901, user_id=2).one()
        assert mine.magnitude == -1.0

    def test_a_rating_change_marks_consensus_stale(self, project, monkeypatch):
        """Every code-application mutation site staleizes consensus — a rating moves
        what a consensus over this target would say, so it is one of those sites.

        Spied rather than driven end-to-end because the sweep is a background task;
        the claim under test is that the call happens, which is exactly the wiring
        that #757 shows unit-testing the callee cannot prove.
        """
        called = []
        import app.routers.coding as coding_mod
        monkeypatch.setattr(
            coding_mod, "_mark_segment_consensus_stale",
            lambda db, pid, seg: called.append((pid, seg.id)),
        )
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        called.clear()
        set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=0.5), user=_user(db), db=db,
        )
        assert called == [(900, 9000)]


class TestMergeConflictAdjudication:
    """#35 — a merge conflict is cleared by the coder rating again (or unrating).

    The flag exists so the coder can decide; the decision IS the rating they give
    next, so nothing else may be required of them to clear it.
    """

    def _flagged(self, db, *, magnitude=0.5, conflict=-1.0):
        app = CodeApplication(segment_id=9000, code_id=901, user_id=1,
                              magnitude=magnitude, magnitude_conflict=conflict)
        db.add(app)
        db.flush()
        return app

    def test_re_rating_clears_the_flag(self, project):
        db = project
        app = self._flagged(db)
        set_code_magnitude(9000, 901, MagnitudeValueUpdate(magnitude=1.0), user=_user(db), db=db)
        db.refresh(app)
        assert app.magnitude == 1.0 and app.magnitude_conflict is None

    def test_rating_it_the_SAME_value_again_still_clears_the_flag(self, project):
        """Confirming the kept rating is an adjudication too."""
        db = project
        app = self._flagged(db, magnitude=0.5)
        set_code_magnitude(9000, 901, MagnitudeValueUpdate(magnitude=0.5), user=_user(db), db=db)
        db.refresh(app)
        assert app.magnitude == 0.5 and app.magnitude_conflict is None

    def test_unrating_clears_the_flag(self, project):
        db = project
        app = self._flagged(db)
        set_code_magnitude(9000, 901, MagnitudeValueUpdate(magnitude=None), user=_user(db), db=db)
        db.refresh(app)
        assert app.magnitude is None and app.magnitude_conflict is None

    def test_re_applying_with_a_rating_clears_the_flag(self, project):
        """Variant A's strip arrives through `apply_code` on an existing row."""
        db = project
        app = self._flagged(db, magnitude=0.5)
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        db.refresh(app)
        assert app.magnitude == 0.5 and app.magnitude_conflict is None

    def test_re_applying_WITHOUT_a_rating_leaves_the_flag_alone(self, project):
        """A plain re-apply (the chord pressed twice) is not a decision."""
        db = project
        app = self._flagged(db)
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        db.refresh(app)
        assert app.magnitude == 0.5 and app.magnitude_conflict == -1.0

    def test_the_flag_reaches_the_workbench_payload(self, project):
        """The chip renders the flag from `applied_code_details`; a field the
        payload does not carry is a flag nobody sees."""
        from app.routers.segments import segment_to_response

        db = project
        self._flagged(db, magnitude=0.5, conflict=0.0)   # a copy that rated it ZERO
        db.refresh(db.get(Segment, 9000))
        resp = segment_to_response(db.get(Segment, 9000))
        detail = next(d for d in resp.applied_code_details if d.code_id == 901)
        assert detail.magnitude == 0.5
        assert detail.magnitude_conflict == 0.0 and detail.magnitude_conflict is not None


class TestCodedSegmentsCsvCarriesTheRating:
    """#35 — the coded-segments CSV is the one coded-data export at the
    application grain, so the rating rides it: three APPENDED columns."""

    def _export(self, db):
        import csv
        import io
        from app.routers.export import export_coded_segments_csv
        from tests.test_export_formula_injection import _stream_to_text

        resp = asyncio.run(export_coded_segments_csv(
            project_id=900, code_ids=None, exclude_facilitator=False,
            conversation_ids=None, participant_ids=None, user=_user(db), db=db,
        ))
        return list(csv.DictReader(io.StringIO(_stream_to_text(resp))))

    def test_the_rating_its_scale_and_its_anchor_are_appended(self, project):
        db = project
        code = db.get(Code, 901)
        magnitude.write_scale(code, magnitude.normalize_scale(BIPOLAR))
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=0.0))   # ZERO, at an anchor
        db.add(CodeApplication(segment_id=9001, code_id=901, user_id=1, magnitude=-0.5))  # no anchor
        db.add(CodeApplication(segment_id=9000, code_id=902, user_id=1))                  # no scale
        db.flush()
        rows = self._export(db)
        assert list(rows[0].keys())[-3:] == ["Rating", "Rating Scale", "Rating Anchor"]
        by = {(r["Code"], r["Segment Text"]): r for r in rows}
        zero = by[("District support", "a segment")]
        assert zero["Rating"] == "0" and zero["Rating Scale"] == "-1 to 1" and zero["Rating Anchor"] == "neither"
        half = by[("District support", "another")]
        assert half["Rating"] == "-0.5" and half["Rating Anchor"] == ""
        plain = by[("Pacing adherence", "a segment")]
        assert plain["Rating"] == "" and plain["Rating Scale"] == "" and plain["Rating Anchor"] == ""

    def test_an_unrated_application_on_a_scaled_code_exports_a_blank_never_0(self, project):
        db = project
        code = db.get(Code, 901)
        magnitude.write_scale(code, magnitude.normalize_scale(BIPOLAR))
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1))
        db.flush()
        row = self._export(db)[0]
        assert row["Rating"] == "" and row["Rating Scale"] == "-1 to 1"


class TestPortabilityRoundTrip:
    """🔴 v6 carries #35, and that claim is only worth as much as this test.

    `_build_entity` is reflection-driven, so the five new columns *should* ride the
    round trip with no export branch — and "should" is exactly the assumption the
    #757 lesson says to enter at the pipeline's MOUTH and prove. A rating that
    silently failed to round-trip would take every reliability figure computed from
    it with no error at any point.
    """

    def test_the_scale_AND_the_rating_survive_an_export_and_reimport(self, project, tmp_path):
        db = project
        code = db.get(Code, 901)
        magnitude.write_scale(code, magnitude.normalize_scale(BIPOLAR))
        # ZERO on purpose: the value most likely to be lost by a falsy-check
        # anywhere in the export/import chain, and legal on this scale.
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=0.0))
        db.flush()
        db.commit()

        from app.services.project_portability import export_project, import_project

        docs = tmp_path / "docs"
        docs.mkdir()
        buf = export_project(db, 900, docs_dir=docs, media_dir=None)
        archive = tmp_path / "p.mmproject"
        archive.write_bytes(buf.getvalue())

        new_id, _ = import_project(db, archive, docs_dir=docs, media_dir=None, user_id=1)
        db.commit()

        imported = db.query(Code).filter(
            Code.project_id == new_id, Code.name == "District support"
        ).one()
        scale = magnitude.read_scale(imported)
        assert scale is not None, "the declared scale did not survive the round trip"
        assert (scale["min"], scale["max"], scale["step"]) == (-1.0, 1.0, 0.5)
        assert any(a["label"] == "neither" for a in scale["anchors"])

        ratings = [
            a.magnitude for a in db.query(CodeApplication)
            .filter(CodeApplication.code_id == imported.id).all()
        ]
        assert ratings == [0.0], f"the rating did not survive the round trip: {ratings}"


class TestGroupFanOut:
    def test_a_rating_fans_out_across_a_segment_group(self, project):
        """A group is CODED as one unit, so it is RATED as one unit.

        Rating its members differently would be a distinction the interface never
        offered the coder a way to make.
        """
        db = project
        db.add(SegmentGroup(id=77, conversation_id=900))
        db.flush()
        for sid in (9000, 9001):
            db.get(Segment, sid).group_id = 77
        db.flush()
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        values = {
            a.segment_id: a.magnitude
            for a in db.query(CodeApplication).filter_by(code_id=901, user_id=1).all()
        }
        assert values == {9000: 0.5, 9001: 0.5}

    def test_a_later_rating_change_fans_out_too(self, project):
        db = project
        db.add(SegmentGroup(id=77, conversation_id=900))
        db.flush()
        for sid in (9000, 9001):
            db.get(Segment, sid).group_id = 77
        db.flush()
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        set_code_magnitude(
            9000, 901, MagnitudeValueUpdate(magnitude=-1.0), user=_user(db), db=db,
        )
        values = {
            a.segment_id: a.magnitude
            for a in db.query(CodeApplication).filter_by(code_id=901, user_id=1).all()
        }
        assert values == {9000: -1.0, 9001: -1.0}


class TestTheRatingReachesTheWire:
    """The payload builders, tested because a claim without a guard is a hope.

    Three surfaces build `applied_code_details` and all three had to learn the new
    field. The text-coding one is the risky member: it projects explicit COLUMNS
    and unpacks a tuple, so adding one is an arity change — if the column order and
    the unpack disagree, every detail silently carries the wrong value in the wrong
    field and nothing raises.
    """

    def test_the_conversation_segment_payload_carries_the_rating(self, project):
        from app.routers.segments import segment_to_response
        db = project
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=0.0))
        db.flush()
        db.refresh(db.get(Segment, 9000))
        resp = segment_to_response(db.get(Segment, 9000))
        detail = next(d for d in resp.applied_code_details if d.code_id == 901)
        # 🔴 ZERO, not a truthy value: a builder that dropped the field would give
        # None here and a fixture using 5.0 could not tell that from a real 5.0.
        assert detail.magnitude == 0.0
        assert detail.magnitude is not None

    def test_an_unrated_application_reports_None_not_zero(self, project):
        from app.routers.segments import segment_to_response
        db = project
        db.add(CodeApplication(segment_id=9000, code_id=902, user_id=1))
        db.flush()
        db.refresh(db.get(Segment, 9000))
        resp = segment_to_response(db.get(Segment, 9000))
        detail = next(d for d in resp.applied_code_details if d.code_id == 902)
        assert detail.magnitude is None

    def test_the_text_coding_projection_and_its_unpack_agree(self):
        """An ARITY check on the query whose tuple I widened.

        Asserted against the SOURCE rather than behaviourally, because the failure
        mode is a mis-ALIGNMENT: with the wrong order the endpoint still returns a
        200 and every field still holds *a* value, so a behavioural test on one
        fixture can pass while `attribution` holds a rating. Counting both sides
        is what makes a future column addition fail loudly.
        """
        import re
        from pathlib import Path
        src = Path(__file__).resolve().parents[1] / "app" / "routers" / "text_coding.py"
        text = src.read_text(encoding="utf-8")

        block = re.search(r"ca_query = \(\s*db\.query\((.*?)\)\s*\.join", text, re.S)
        assert block, "the ca_query projection moved; update this arity guard"
        selected = [
            ln.strip().rstrip(",")
            for ln in block.group(1).splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        ]

        unpack = re.search(r"for (.+?) in ca_query:", text)
        assert unpack, "the ca_query unpack moved; update this arity guard"
        names = [n.strip() for n in unpack.group(1).split(",")]

        assert len(selected) == len(names), (
            f"the projection selects {len(selected)} columns but the loop unpacks "
            f"{len(names)} names — every detail after the mismatch carries the wrong "
            f"value in the wrong field, with no error.\n"
            f"  selected: {selected}\n  unpacked: {names}"
        )
        # And the rating must be the LAST of both, which is where it was appended.
        assert "magnitude" in selected[-1]
        assert "magnitude" in names[-1]


# ───────────────────── 5. what the 2026-09-02 review found (#869) ───────────────

from fastapi import HTTPException  # noqa: E402

from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType  # noqa: E402
from app.schemas.segment import SegmentSplitRange  # noqa: E402
from app.services.segment_operations import (  # noqa: E402
    merge_segments,
    split_segment,
    unmerge_segment,
    unsplit_segment,
)


def _apps_by_key(db, segment_id):
    return {
        (a.code_id, a.user_id): a
        for a in db.query(CodeApplication).filter(CodeApplication.segment_id == segment_id).all()
    }


class TestStructuralOpsCarryTheRating:
    """#869 (a) — `_carried_app_fields` feeds every writer in `segment_operations.py`,
    and it carried five fields and not the two rating fields, so every merge /
    split / unmerge / unsplit re-created the application UNRATED.

    🔴 Every fixture rates ZERO on the −1…+1 scale and carries a conflict value:
    a carry that drops the field yields `None`, which a 5.0 fixture could not
    tell from a real drop-to-None, and a truthiness slip drops exactly the zero.
    """

    def test_merge_carries_rating_and_flag_and_records_a_dropped_duplicates_rating(self, project):
        db = project
        db.add_all([
            # Coder 1 rated BOTH originals, differently: first wins, other flagged.
            CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=0.0),
            CodeApplication(segment_id=9001, code_id=901, user_id=1, magnitude=0.5),
            # Coder 2's row carries a pre-existing merge flag — verbatim.
            CodeApplication(segment_id=9001, code_id=901, user_id=2,
                            magnitude=0.0, magnitude_conflict=1.0),
        ])
        db.flush()
        merged, _ = merge_segments(
            db, segment_ids=[9000, 9001], parent_type="conversation",
            parent_id=900, project_id=900, user_id=1,
        )
        by = _apps_by_key(db, merged.id)
        assert by[(901, 1)].magnitude == 0.0 and by[(901, 1)].magnitude is not None
        assert by[(901, 1)].magnitude_conflict == 0.5, "the dropped duplicate's rating is the flag"
        assert by[(901, 2)].magnitude == 0.0 and by[(901, 2)].magnitude_conflict == 1.0

    def test_unmerge_projects_a_post_merge_rating_back_with_its_value(self, project):
        db = project
        db.add(CodeApplication(segment_id=9000, code_id=902, user_id=1))
        db.flush()
        merged, _ = merge_segments(
            db, segment_ids=[9000, 9001], parent_type="conversation",
            parent_id=900, project_id=900, user_id=1,
        )
        # A colleague codes AND rates the merged whole (with a flag from a merge).
        db.add(CodeApplication(segment_id=merged.id, code_id=901, user_id=2,
                               magnitude=0.0, magnitude_conflict=-0.5))
        db.flush()
        unmerge_segment(
            db, segment_id=merged.id, parent_type="conversation",
            parent_id=900, project_id=900, user_id=1,
        )
        back = _apps_by_key(db, 9000)[(901, 2)]
        assert back.magnitude == 0.0 and back.magnitude is not None
        assert back.magnitude_conflict == -0.5

    def test_split_copies_the_rating_to_every_child_and_unsplit_projects_back(self, project):
        db = project
        db.get(Segment, 9000).text = "alpha beta gamma"
        db.add(CodeApplication(segment_id=9000, code_id=901, user_id=1,
                               magnitude=0.0, magnitude_conflict=1.0))
        db.flush()
        new_segs, _ = split_segment(
            db, ranges=[SegmentSplitRange(segment_id=9000, start_offset=6, end_offset=10)],
            parent_type="conversation", parent_id=900, project_id=900, user_id=1,
        )
        assert len(new_segs) == 3
        for seg in new_segs:
            app = _apps_by_key(db, seg.id)[(901, 1)]
            assert app.magnitude == 0.0 and app.magnitude is not None
            assert app.magnitude_conflict == 1.0

        # A colleague rates one child after the split; unsplit carries it back.
        selected = next(s for s in new_segs if s.text == "beta")
        db.add(CodeApplication(segment_id=selected.id, code_id=901, user_id=2, magnitude=0.0))
        db.flush()
        restored, _ = unsplit_segment(
            db, segment_id=selected.id, parent_type="conversation",
            parent_id=900, project_id=900, user_id=1,
        )
        by = _apps_by_key(db, restored.id)
        assert by[(901, 1)].magnitude == 0.0 and by[(901, 1)].magnitude_conflict == 1.0
        assert by[(901, 2)].magnitude == 0.0 and by[(901, 2)].magnitude is not None


class TestStrandCountScope:
    """#869 (e) — the stranding count is scoped like every other count surface.

    A merged-away original's rating is one the UI can neither reach nor clear,
    so a refusal naming it is unsatisfiable; the consensus row's median is
    DERIVED from the coders' ratings, not a rating anyone gave. A dataset-cell
    rating is neither and MUST count — it passes `visible_target_filter` by the
    NULL-safe arm, which only the outerjoin makes reachable.
    """

    def _seed(self, db):
        # Hidden original (merged into 9000), rated out of the proposed range.
        db.add(Segment(id=9002, conversation_id=900, sequence_order=2,
                       text="hidden", merged_into_id=9000))
        db.add_all([
            Dataset(id=900, project_id=900, name="Survey"),
        ])
        db.flush()
        db.add_all([
            DatasetColumn(id=9010, dataset_id=900, column_code="Q", column_name="Q",
                          column_text="Open", column_type=ColumnType.OPEN_TEXT,
                          sequence_order=0, display_order=0),
            DatasetRow(id=9011, dataset_id=900),
        ])
        db.flush()
        db.add(DatasetValue(id=90110, row_id=9011, column_id=9010, value_text="alpha"))
        db.flush()
        db.add_all([
            CodeApplication(segment_id=9002, code_id=901, user_id=1, magnitude=1.0),   # hidden
            CodeApplication(segment_id=9001, code_id=901, user_id=None,
                            origin="consensus", magnitude=1.0),                        # derived
            CodeApplication(segment_id=9000, code_id=901, user_id=1, magnitude=0.0),   # in range
            CodeApplication(dataset_value_id=90110, code_id=901, user_id=1, magnitude=1.0),  # counts
        ])
        db.flush()

    def _narrow(self, db):
        return set_magnitude_scale(
            900, 901, MagnitudeScaleUpdate(scale=MagnitudeScale(min=-1, max=0.5, step=0.5)),
            user=_user(db), db=db,
        )

    def test_hidden_and_consensus_ratings_do_not_count_and_a_dataset_cell_rating_does(self, project):
        db = project
        self._seed(db)
        with pytest.raises(HTTPException) as exc:
            self._narrow(db)
        assert exc.value.status_code == 400
        # ONE — the dataset-cell rating. Two hidden/consensus ratings sit out of
        # range and must not be named, because nothing on screen can clear them.
        assert exc.value.detail.startswith("1 existing rating "), exc.value.detail

    def test_clearing_the_one_that_counts_lets_the_narrowing_through(self, project):
        db = project
        self._seed(db)
        db.query(CodeApplication).filter(CodeApplication.dataset_value_id == 90110).one().magnitude = None
        db.flush()
        resp = self._narrow(db)
        assert resp.magnitude_scale.max == 0.5


class TestEveryRatingDoorFansOut:
    """#869 (f) — three doors write a rating; the re-rate-on-existing branch of
    `apply_code` was the one that updated a single row. All three now route
    through `_fan_out_rating`."""

    def _group(self, db):
        db.add(SegmentGroup(id=77, conversation_id=900))
        db.flush()
        for sid in (9000, 9001):
            db.get(Segment, sid).group_id = 77
        db.flush()

    def _values(self, db):
        return {
            a.segment_id: (a.magnitude, a.magnitude_conflict)
            for a in db.query(CodeApplication).filter_by(code_id=901, user_id=1).all()
        }

    def test_a_re_rate_through_apply_fans_out_and_clears_the_siblings_flag(self, project):
        db = project
        self._group(db)
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(), user=_user(db), db=db))
        # A merge left a flag on the SIBLING only; the coder re-rates from 9000.
        db.query(CodeApplication).filter_by(segment_id=9001, code_id=901, user_id=1).one().magnitude_conflict = 1.0
        db.flush()
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.0), user=_user(db), db=db))
        assert self._values(db) == {9000: (0.0, None), 9001: (0.0, None)}

    def test_a_first_apply_with_a_rating_reaches_a_sibling_that_was_already_coded(self, project):
        """The sibling was coded before it joined the group, so the apply loop
        skips it (it exists); the group is rated as one unit, so the rating
        given now must reach it anyway."""
        db = project
        self._group(db)
        db.add(CodeApplication(segment_id=9001, code_id=901, user_id=1))  # unrated, pre-existing
        db.flush()
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=-1.0), user=_user(db), db=db))
        assert self._values(db) == {9000: (-1.0, None), 9001: (-1.0, None)}


class TestAnInactiveCodeCannotBeRated:
    """#869 (g) — the refusal lives in `validate_value` so every caller inherits it;
    `set_code_magnitude` never asked `is_active` and was the door that skipped it.
    ⚠️ Unrating stays legal: clearing is recoverable and takes no judgement."""

    def test_the_service_refuses_a_new_rating_and_allows_a_clear(self, project):
        db = project
        code = db.get(Code, 901)
        code.is_active = False
        with pytest.raises(magnitude.MagnitudeError, match="inactive"):
            magnitude.validate_value(code, 0.0)
        assert magnitude.validate_value(code, None) is None

    def test_the_rating_endpoint_inherits_the_refusal(self, project):
        db = project
        asyncio.run(apply_code(9000, 901, ApplyCodeRequest(magnitude=0.5), user=_user(db), db=db))
        db.get(Code, 901).is_active = False
        db.flush()
        with pytest.raises(HTTPException) as exc:
            set_code_magnitude(9000, 901, MagnitudeValueUpdate(magnitude=0.0), user=_user(db), db=db)
        assert exc.value.status_code == 400 and "inactive" in exc.value.detail
        # Withdrawing the rating is still allowed on a retired code.
        resp = set_code_magnitude(9000, 901, MagnitudeValueUpdate(magnitude=None), user=_user(db), db=db)
        assert resp.magnitude is None
        assert db.query(CodeApplication).filter_by(segment_id=9000, code_id=901).one().magnitude is None


class TestTheDocumentPayloadCarriesTheRating:
    """#868 (a) — the FOURTH payload builder.

    `routers/documents.py` builds a per-application code list in two places
    (`get_document` and `_segment_to_doc_response`), and neither carried the
    rating while the rules file said "all three builders carry it". The workbench
    then fabricated details from that payload and announced "not rated" over a
    rating it could not see. Both call paths go through ONE constructor now;
    both are pinned here, seeded with a rating of ZERO and a conflict value.
    """

    def _document(self, db):
        from app.models.document import Document
        db.add(Document(id=950, project_id=900, name="Field notes",
                        source_filename="notes.docx", source_format="docx"))
        db.flush()
        db.add(Segment(id=9500, document_id=950, sequence_order=0, text="a paragraph"))
        db.flush()
        db.add(CodeApplication(segment_id=9500, code_id=901, user_id=1,
                               magnitude=0.0, magnitude_conflict=-0.5))
        db.flush()
        seg = db.get(Segment, 9500)
        db.refresh(seg)
        return seg

    def test_the_segment_op_converter_carries_both_fields(self, project):
        from app.routers.documents import _segment_to_doc_response
        seg = self._document(project)
        resp = _segment_to_doc_response(seg)
        entry = next(c for c in resp.codes if c.id == 901)
        assert entry.magnitude == 0.0 and entry.magnitude is not None
        assert entry.magnitude_conflict == -0.5

    def test_the_document_endpoint_carries_both_fields(self, project):
        from app.routers.documents import get_document
        db = project
        self._document(db)
        resp = asyncio.run(get_document(900, 950, user=_user(db), db=db))
        seg = next(s for s in resp.segments if s.id == 9500)
        entry = next(c for c in seg.codes if c.id == 901)
        assert entry.magnitude == 0.0 and entry.magnitude is not None
        assert entry.magnitude_conflict == -0.5
