"""
How the scorer fills a missing result (linear_model.LogisticModel.fill_missing):
the same subject at the student's most recent earlier checkpoint, else their own
average at that checkpoint, else the training median; and the explanation still
adds up to the model's log-odds when a value was filled.

Run: python -m pytest -q test_linear_model.py
"""
import json
import os

import numpy as np
import pytest

from linear_model import LogisticModel, fill_plan

PACKAGE = os.path.join(os.path.dirname(__file__), "..", "..", "..", "ml", "models", "logreg-v1")


def load(point):
    path = os.path.join(PACKAGE, f"{point}.json")
    if not os.path.exists(path):
        pytest.skip("ml/models/logreg-v1 is not in this checkout")
    with open(path) as f:
        return LogisticModel(json.load(f))


def row(model, values):
    """A one-row matrix in the model's column order; unnamed columns are 50, None is missing."""
    return np.array([[np.nan if values.get(f, 50.0) is None else values.get(f, 50.0) for f in model.feature_names]])


def col(model, name):
    return model.feature_names.index(name)


def test_plan_looks_back_through_earlier_checkpoints_most_recent_first():
    plan = fill_plan(["T1M_Physics", "T1F_Physics", "T2M_Physics", "T2M_Mathematics", "Attendance_T1M", "Attendance_T2M"])
    earlier, same = plan[2]  # T2M_Physics
    assert earlier == (1, 0)  # T1F, then T1M
    assert same == (3,)  # the other T2M subject
    assert plan[5] == ((4,), ())  # attendance: earlier attendance only, never subject marks
    assert plan[0] == ((), ())  # T1M_Physics has nothing earlier and no T1M peers in this list


def test_missing_mark_uses_the_same_subject_at_the_previous_checkpoint():
    m = load("T2M")
    x = row(m, {"T1F_Physics": 31.0, "T2M_Physics": None})
    assert m.fill_missing(x)[0, col(m, "T2M_Physics")] == 31.0


def test_skips_back_past_a_checkpoint_that_is_also_missing():
    m = load("T2M")
    x = row(m, {"T1M_Physics": 27.0, "T1F_Physics": None, "T2M_Physics": None})
    filled = m.fill_missing(x)[0]
    assert filled[col(m, "T2M_Physics")] == 27.0
    assert filled[col(m, "T1F_Physics")] == 27.0  # T1F looks back to T1M too


def test_first_checkpoint_uses_the_students_own_average():
    m = load("T1M")
    subjects = [f for f in m.feature_names if f.startswith("T1M_")]
    values = {f: 30.0 for f in subjects}
    values["T1M_Mathematics"] = 40.0
    values["T1M_Physics"] = None
    filled = m.fill_missing(row(m, values))[0]
    present = [v for f, v in values.items() if v is not None]
    assert filled[col(m, "T1M_Physics")] == pytest.approx(np.mean(present))


def test_nothing_of_the_students_own_falls_back_to_the_training_median():
    m = load("T1M")
    values = {f: None for f in m.feature_names}
    filled = m.fill_missing(row(m, values))[0]
    np.testing.assert_allclose(filled, m.fill)


def test_missing_attendance_uses_the_previous_attendance_not_marks():
    m = load("T2M")
    x = row(m, {"Attendance_T1F": 71.5, "Attendance_T2M": None})
    assert m.fill_missing(x)[0, col(m, "Attendance_T2M")] == 71.5


def test_complete_rows_are_unchanged():
    m = load("T3M")
    x = np.random.default_rng(3).uniform(0, 100, size=(5, m.num_features()))
    np.testing.assert_array_equal(m.fill_missing(x), x)


def test_filled_values_never_come_from_another_filled_value():
    # T1F_Physics is missing and gets T1M's 27; T2M_Physics must still look past it to T1M's real 27, not chain.
    m = load("T2M")
    x = row(m, {"T1M_Physics": 27.0, "T1F_Physics": None, "T2M_Physics": None, "T2M_Mathematics": 90.0})
    assert m.fill_missing(x)[0, col(m, "T2M_Physics")] == 27.0


def test_a_struggling_students_gap_no_longer_lowers_their_estimate_towards_average():
    m = load("T2M")
    weak = {f: 25.0 for f in m.feature_names if not f.startswith("Attendance_")}
    weak.update({f: 60.0 for f in m.feature_names if f.startswith("Attendance_")})
    complete = m.predict_proba(row(m, weak))[0]
    gap = dict(weak, **{"T2M_Physics": None, "T2M_Chemistry": None})
    filled = m.predict_proba(row(m, gap))[0]
    median_only = 1 / (1 + np.exp(-(((np.where(np.isnan(row(m, gap)), m.fill, row(m, gap)) - m.mean) / m.scale) @ m.coef + m.intercept)))[0]
    assert abs(filled - complete) < abs(median_only - complete)


def test_explanation_still_adds_up_when_values_were_filled():
    m = load("T2M")
    x = row(m, {"T1F_Physics": 31.0, "T2M_Physics": None, "Attendance_T2M": None})
    base, contributions = m.explain(x)
    assert base + contributions[0].sum() == pytest.approx(m.margin(x)[0], abs=1e-6)
