"""
The risk model the scorer runs: a logistic regression per prediction point,
stored as plain JSON (no pickles), and its SHAP explanations from the shap
library's LinearExplainer.

A model file holds everything needed to turn a feature row into a probability:

    {
      "format": "connected-logreg-v1",
      "feature_names": [...],                  the feature contract's columns, in order
      "imputer":  {"strategy": "median", "statistics": [...]},   one fill value per column
      "scaler":   {"mean": [...], "scale": [...]},               standardisation
      "coef": [...], "intercept": number,      on the standardised inputs, in log-odds
      "background": {"mean": [...], "cov": [[...]]}              training rows after
                                               imputing and scaling (SHAP's reference)
    }

Prediction, the same steps as the sklearn pipeline it was exported from
(SimpleImputer(median) -> StandardScaler -> LogisticRegression), except how a
missing value is filled:

    x (NaN where a result is missing)
      -> each missing value filled from the student's own results (below)
      -> z = (x - mean) / scale
      -> log-odds = intercept + coef . z
      -> probability = sigmoid(log-odds)

Explanations: shap.LinearExplainer((coef, intercept), (mean, cov)) on z. With
the default (interventional) perturbation every feature's SHAP value is
coef_j * (z_j - background mean_j), and base value + the contributions equals
the model's log-odds, the same additive contract the gradebook already relies
on (backend/library/explanations.js). A missing input is explained at the
value it was filled with.

Filling a missing value. The training snapshots have no missing values, so the
model learned nothing about missingness and the pipeline's median imputer never
acted during training: how a gap is filled is a choice made here, at scoring
time, and changing it needs no retraining. The training median would make a
missing mark look like a typical student's, which pulls a struggling student's
estimate down (fewer students flagged the more marks are missing). Instead a
gap is filled from the student's own results, first that applies:
  1. the same subject (or year-to-date attendance) at the student's most recent
     earlier checkpoint that has it;
  2. a subject mark: the student's average of the marks they do have at that
     checkpoint;
  3. the column's training median.
It is an estimate, not a result: the gradebook still reports the column as
missing and the screens say so.

from_pipeline() builds the file from a fitted pipeline; ml/package_logreg.py
and the tests use it, so packaging and scoring cannot drift apart.
"""
import math

import numpy as np

FORMAT = "connected-logreg-v1"
FRAMEWORK = "sklearn-logistic-regression"

# Checkpoints in school-year order; feature columns are T1M_<Subject> and Attendance_T1M.
POINT_ORDER = ("T1M", "T1F", "T2M", "T2F", "T3M", "T3F")


def fill_plan(feature_names):
    """Per column: (earlier columns to try, most recent first; same-checkpoint subject columns)."""
    index = {f: i for i, f in enumerate(feature_names)}
    parsed = []
    for f in feature_names:
        if f.startswith("Attendance_"):
            parsed.append(("attendance", f[len("Attendance_"):], None))
            continue
        point, _, subject = f.partition("_")
        parsed.append(("subject", point, subject) if point in POINT_ORDER and subject else (None, None, None))
    peers = {}
    for i, (kind, point, _) in enumerate(parsed):
        if kind == "subject":
            peers.setdefault(point, []).append(i)
    plan = []
    for i, (kind, point, subject) in enumerate(parsed):
        if kind is None or point not in POINT_ORDER:
            plan.append(((), ()))
            continue
        earlier = []
        for p in reversed(POINT_ORDER[:POINT_ORDER.index(point)]):
            name = f"{p}_{subject}" if kind == "subject" else f"Attendance_{p}"
            if name in index:
                earlier.append(index[name])
        same = tuple(j for j in peers.get(point, ()) if j != i) if kind == "subject" else ()
        plan.append((tuple(earlier), same))
    return plan


def _vector(values, n, name):
    v = np.asarray(values, dtype=np.float64)
    if v.shape != (n,) or not np.all(np.isfinite(v)):
        raise RuntimeError(f"model file: {name} must be {n} finite numbers")
    return v


class LogisticModel:
    """One prediction point's logistic regression, loaded from its JSON file."""

    def __init__(self, spec):
        if spec.get("format") != FORMAT:
            raise RuntimeError(f"model file format is {spec.get('format')}, expected {FORMAT}")
        self.feature_names = list(spec["feature_names"])
        n = len(self.feature_names)
        self.fill = _vector(spec["imputer"]["statistics"], n, "imputer.statistics")
        self.mean = _vector(spec["scaler"]["mean"], n, "scaler.mean")
        self.scale = _vector(spec["scaler"]["scale"], n, "scaler.scale")
        if np.any(self.scale <= 0):
            raise RuntimeError("model file: scaler.scale must be positive")
        self.coef = _vector(spec["coef"], n, "coef")
        self.intercept = float(spec["intercept"])
        if not math.isfinite(self.intercept):
            raise RuntimeError("model file: intercept must be a finite number")
        self.background_mean = _vector(spec["background"]["mean"], n, "background.mean")
        self.background_cov = np.asarray(spec["background"]["cov"], dtype=np.float64)
        if self.background_cov.shape != (n, n):
            raise RuntimeError(f"model file: background.cov must be {n} x {n}")
        self._plan = fill_plan(self.feature_names)
        self._explainer = None

    def num_features(self):
        return len(self.feature_names)

    def fill_missing(self, X):
        """Raw inputs (NaN = missing) with every gap filled from the student's own results (see the module notes)."""
        X = np.array(X, dtype=np.float64, copy=True)
        if X.ndim != 2 or X.shape[1] != self.num_features():
            raise ValueError(f"expected rows of {self.num_features()} inputs")
        observed = X.copy()  # fill only from real results, never from another filled value
        for r, c in zip(*np.nonzero(np.isnan(observed))):
            X[r, c] = self._fill_value(observed[r], c)
        return X

    def _fill_value(self, row, c):
        earlier, same = self._plan[c]
        for j in earlier:
            if np.isfinite(row[j]):
                return row[j]
        present = [row[j] for j in same if np.isfinite(row[j])]
        if present:
            return float(np.mean(present))
        return self.fill[c]

    def standardise(self, X):
        """Raw inputs (NaN = missing) -> the standardised matrix the coefficients apply to."""
        return (self.fill_missing(X) - self.mean) / self.scale

    def margin(self, X):
        """Log-odds of the at-risk class, before the sigmoid."""
        return self.standardise(X) @ self.coef + self.intercept

    def predict_proba(self, X):
        """Probability of the at-risk class for every row."""
        return 1.0 / (1.0 + np.exp(-self.margin(X)))

    def explainer(self):
        if self._explainer is None:
            import shap  # scoring alone does not need it
            self._explainer = shap.LinearExplainer(
                (self.coef, self.intercept), (self.background_mean, self.background_cov)
            )
        return self._explainer

    def explain(self, X):
        """(base value, contributions per row and feature), in log-odds."""
        explainer = self.explainer()
        values = np.asarray(explainer.shap_values(self.standardise(X)), dtype=np.float64).reshape(len(X), -1)
        return float(np.ravel(explainer.expected_value)[0]), values


def from_pipeline(pipeline, features, X_train):
    """The model file for a fitted SimpleImputer(median) -> StandardScaler -> LogisticRegression pipeline."""
    imputer, scaler, model = (pipeline.named_steps[k] for k in ("imp", "sc", "m"))
    if getattr(imputer, "strategy", None) != "median":
        raise ValueError("the imputer must use the median")
    if model.coef_.shape != (1, len(features)):
        raise ValueError("expected a binary logistic regression on the given features")
    Z = scaler.transform(imputer.transform(np.asarray(X_train, dtype=np.float64)))
    return {
        "format": FORMAT,
        "feature_names": list(features),
        "imputer": {"strategy": "median", "statistics": [float(v) for v in imputer.statistics_]},
        "scaler": {"mean": [float(v) for v in scaler.mean_], "scale": [float(v) for v in scaler.scale_]},
        "coef": [float(v) for v in model.coef_[0]],
        "intercept": float(model.intercept_[0]),
        "background": {
            "mean": [float(v) for v in Z.mean(axis=0)],
            "cov": [[float(v) for v in row] for row in np.atleast_2d(np.cov(Z, rowvar=False))],
        },
    }
