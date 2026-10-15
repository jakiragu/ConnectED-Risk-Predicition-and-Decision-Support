"""
The risk scorer: model inputs in; at-risk probabilities and their SHAP
explanations out. Nothing else.

It receives feature rows built by the gradebook (risk-prediction Lambda) for
one prediction point, without names or student ids (rows carry an opaque
row_id), and returns one probability per row from the current published
model. Decisions about students are not made here: the probability and the
model's threshold are returned as a decision-support signal.

Explanations are SHAP values from XGBoost's built-in TreeSHAP
(pred_contribs), which gives the same values as shap.TreeExplainer on these
models (ml/verify_shap.py checks it). They are in log-odds: the base value plus
every feature's contribution equals the model's output before the sigmoid.

Actions
  score     {prediction_point, rows: [{row_id, features: {column: number|null}}]}
            -> {model_version, prediction_point, threshold, explainer,
                predictions: [{row_id, probability, at_risk, base_value, contributions: {column: number}}]}
  selftest  {model_version}  load every point of that version and score sample rows
  describe  {}               the current model's manifest summary
"""
import math

import numpy as np
import xgboost

import model_store

EXPLAINER = "xgboost-treeshap"


class InputError(Exception):
    pass


def _matrix(rows, features):
    if not isinstance(rows, list) or not rows:
        raise InputError("rows must be a non-empty list")
    data = np.full((len(rows), len(features)), np.nan, dtype=np.float32)
    for i, row in enumerate(rows):
        given = row.get("features") or {}
        unknown = set(given) - set(features)
        if unknown:
            raise InputError(f"row {row.get('row_id')}: unknown feature columns {sorted(unknown)[:5]}")
        for j, name in enumerate(features):
            value = given.get(name)
            if value is None:
                continue
            value = float(value)
            if not math.isfinite(value):
                raise InputError(f"row {row.get('row_id')}: {name} is not a finite number")
            data[i, j] = value
    return xgboost.DMatrix(data, feature_names=features, missing=np.nan)


def score(event):
    point = event.get("prediction_point")
    model = model_store.load()
    spec = model.point(point)
    rows = event.get("rows")
    features = spec["features"]
    booster = model.booster(point)
    matrix = _matrix(rows, features)
    probabilities = booster.predict(matrix)
    contributions = booster.predict(matrix, pred_contribs=True)  # (rows, features + 1); the last column is the base value
    threshold = float(spec["threshold"])
    return {
        "model_version": model.version,
        "prediction_point": point,
        "threshold": threshold,
        "explainer": EXPLAINER,
        "predictions": [
            {
                "row_id": row.get("row_id"),
                "probability": round(float(p), 6),
                "at_risk": bool(p >= threshold),
                "base_value": round(float(c[-1]), 6),
                "contributions": {name: round(float(v), 6) for name, v in zip(features, c[:-1])},
            }
            for row, p, c in zip(rows, probabilities, contributions)
        ],
    }


def selftest(event):
    version = event.get("model_version")
    if not version:
        raise InputError("model_version is required")
    model = model_store.load(version)
    report = {}
    for point, spec in model.manifest["points"].items():
        features = spec["features"]
        rows = [
            {"row_id": "all-missing", "features": {}},
            {"row_id": "typical", "features": {f: (85.0 if f.startswith("Attendance") else 55.0) for f in features}},
        ]
        p = model.booster(point).predict(_matrix(rows, features))
        if not all(0.0 <= float(x) <= 1.0 for x in p):
            raise RuntimeError(f"{point}: probabilities outside [0, 1]")
        report[point] = {"features": len(features), "threshold": spec["threshold"], "sample": [round(float(x), 4) for x in p]}
    return {"model_version": version, "ok": True, "points": report}


def describe(_event):
    model = model_store.load()
    m = model.manifest
    return {
        "model_version": model.version,
        "framework": m.get("framework"),
        "xgboost_version": m.get("xgboost_version"),
        "created_at": m.get("created_at"),
        "source": m.get("source"),
        "points": [
            {
                "point": p,
                "features": len(s["features"]),
                "threshold": s["threshold"],
                "metrics": s.get("metrics"),
                "global_importance": s.get("global_importance"),
            }
            for p, s in m["points"].items()
        ],
    }


ACTIONS = {"score": score, "selftest": selftest, "describe": describe}


def handler(event, context=None):
    action = (event or {}).get("action", "score")
    if action not in ACTIONS:
        raise InputError(f"unknown action {action}")
    return ACTIONS[action](event)