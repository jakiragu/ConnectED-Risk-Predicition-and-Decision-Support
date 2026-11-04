"""
Packages logistic regression risk models for the gradebook's risk scorer.

The same job as ml/package_xgboost.py, with the model swapped: on the same
student split (seed and 80/20 stratified split unchanged) and exactly the
feature contract's columns (ml/feature-contract.json), it fits, per prediction
point, the Logistic Regression configuration from the model comparison
(tests/ml/Prediction Strategy Evaluation.ipynb):

    SimpleImputer(median) -> StandardScaler -> LogisticRegression(max_iter=2000)

and writes it in the scorer's JSON model format
(backend/lambdas/risk-scorer/linear_model.py, from_pipeline), so the file the
scorer loads is built by the scorer's own code. The manifest records each
point's held-out metrics and global feature importance: the mean absolute SHAP
value (shap.LinearExplainer, the scorer's explainer) of every input on the
held-out students, and the same per subject and for attendance. The package
also gets counterfactual-stats.json (ml/counterfactual_stats.py), from the same
training students only.

    <out>/manifest.json
    <out>/T1M.json ... <out>/T3M.json
    <out>/counterfactual-stats.json

Usage:
    python ml/package_logreg.py --data <folder with snapshot_T1M.csv ...> --out ml/models/logreg-v1
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import shap
import sklearn
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import counterfactual_stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "lambdas" / "risk-scorer"))
import linear_model  # noqa: E402

POINTS = ["T1M", "T1F", "T2M", "T2F", "T3M"]
TARGET = "academic_risk"
ID = "student_id"
SEED = 54321
THRESHOLD = 0.5  # the notebook's decision rule


def group_of(column):
    """Kiswahili for T1M_Kiswahili, Attendance for Attendance_T1M (the same rule as backend/library/explanations.js)."""
    return "Attendance" if column.startswith("Attendance_") else column.split("_", 1)[1]


def global_importance(model, test, features):
    _, contributions = model.explain(test[features].to_numpy(dtype=np.float64))
    per_feature = np.abs(contributions).mean(axis=0)
    groups = {}
    for name in features:
        groups.setdefault(group_of(name), []).append(features.index(name))
    per_group = {g: float(np.abs(contributions[:, idx].sum(axis=1)).mean()) for g, idx in groups.items()}
    return {
        "method": "mean |SHAP| (shap LinearExplainer, log-odds) on the held-out students",
        "rows": int(len(test)),
        "features": {name: round(float(v), 6) for name, v in zip(features, per_feature)},
        "groups": {g: round(v, 6) for g, v in sorted(per_group.items(), key=lambda kv: -kv[1])},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pos_data", nargs="?", default=None, help="folder with snapshot CSVs (positional)")
    parser.add_argument("pos_out", nargs="?", default=None, help="output folder (positional)")
    parser.add_argument("--data", default=None, help="folder with snapshot_T1M.csv ... snapshot_T3M.csv")
    parser.add_argument("--out", default=None, help="output folder, e.g. ml/models/logreg-v1")
    parser.add_argument("--contract", default=str(Path(__file__).with_name("feature-contract.json")))
    parser.add_argument("--version", default=None, help="model version (default: the output folder name)")
    args = parser.parse_args()

    data_dir = args.data or args.pos_data
    out_dir = args.out or args.pos_out
    if not data_dir or not out_dir:
        parser.error("--data and --out (or positional arguments <data> <out>) are required")

    contract = json.loads(Path(args.contract).read_text())["points"]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    version = args.version or out.name

    snapshots = {p: pd.read_csv(Path(data_dir) / f"snapshot_{p}.csv") for p in POINTS}
    ids, labels = snapshots["T1M"][ID], snapshots["T1M"][TARGET]
    train_ids, test_ids = train_test_split(ids, test_size=0.20, random_state=SEED, stratify=labels)

    manifest = {
        "model_version": version,
        "framework": linear_model.FRAMEWORK,
        "sklearn_version": sklearn.__version__,
        "shap_version": shap.__version__,
        "format": linear_model.FORMAT,
        "objective": "binary:logistic",
        "label": TARGET,
        "positive_class": 1,
        "missing_values": "null inputs are replaced by the column's training median before standardising",
        "explainer": "shap LinearExplainer (interventional), background: the training students",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Prediction Strategy Evaluation.ipynb Logistic Regression configuration, fitted on the feature contract's columns",
        "points": {},
    }
    for point in POINTS:
        df = snapshots[point]
        features = contract[point]
        missing = [c for c in features if c not in df.columns]
        if missing:
            raise SystemExit(f"{point}: snapshot is missing contract columns {missing}")
        train, test = df[df[ID].isin(train_ids)], df[df[ID].isin(test_ids)]
        pipeline = Pipeline([
            ("imp", SimpleImputer(strategy="median")),
            ("sc", StandardScaler()),
            ("m", LogisticRegression(max_iter=2000, random_state=SEED)),
        ])
        X_train = train[features].to_numpy(dtype=np.float64)
        pipeline.fit(X_train, train[TARGET])

        spec = linear_model.from_pipeline(pipeline, features, X_train)
        model = linear_model.LogisticModel(spec)
        X_test = test[features].to_numpy(dtype=np.float64)
        probability = model.predict_proba(X_test)
        drift = float(np.abs(probability - pipeline.predict_proba(X_test)[:, 1]).max())
        if drift > 1e-9:
            raise SystemExit(f"{point}: the exported model disagrees with the fitted pipeline by {drift:.2e}")
        predicted = (probability >= THRESHOLD).astype(int)
        y = test[TARGET]

        path = out / f"{point}.json"
        path.write_text(json.dumps(spec) + "\n")
        manifest["points"][point] = {
            "file": path.name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "features": features,
            "threshold": THRESHOLD,
            "metrics": {
                "test_rows": int(len(test)),
                "accuracy": round(float(accuracy_score(y, predicted)), 4),
                "precision": round(float(precision_score(y, predicted, zero_division=0)), 4),
                "recall": round(float(recall_score(y, predicted, zero_division=0)), 4),
                "f1": round(float(f1_score(y, predicted, zero_division=0)), 4),
                "roc_auc": round(float(roc_auc_score(y, probability)), 4),
                "pr_auc": round(float(average_precision_score(y, probability)), 4),
            },
            "global_importance": global_importance(model, test, features),
        }
        m = manifest["points"][point]["metrics"]
        print(f"{point}: {len(features)} features  F1 {m['f1']:.3f}  recall {m['recall']:.3f}  ROC-AUC {m['roc_auc']:.3f}  -> {path}")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    stats = counterfactual_stats.build(snapshots, set(train_ids))
    counterfactual_stats.write(out, stats)
    print(f"Counterfactual statistics from {stats['train_students']} training students -> {out / counterfactual_stats.FILE}")
    print(f"\nWrote {out / 'manifest.json'} (model_version {version})")


if __name__ == "__main__":
    np.random.seed(SEED)
    main()
