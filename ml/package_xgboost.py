"""
Packages the notebook's XGBoost models (riskPredictionCntd.ipynb) for the
gradebook's risk scorer.

The notebook never saved its models, and it fitted them with the snapshot's
noise_* columns, which the gradebook does not have. This script fits the same
XGBClassifier configuration, on the same student split, using exactly the
feature contract's columns (ml/feature-contract.json), and writes one model per
prediction point in XGBoost's portable JSON format plus a manifest:

    <out>/manifest.json
    <out>/T1M.json ... <out>/T3M.json

Usage:
    python ml/package_xgboost.py --data <folder with snapshot_T1M.csv ...> --out ml/models/xgb-notebook-v1

To package models trained elsewhere instead, see ml/README-model.md.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

POINTS = ["T1M", "T1F", "T2M", "T2F", "T3M"]
TARGET = "academic_risk"
ID = "student_id"
SEED = 54321
THRESHOLD = 0.5  # the notebook's decision rule


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="folder with snapshot_T1M.csv ... snapshot_T3M.csv")
    parser.add_argument("--out", required=True, help="output folder, e.g. ml/models/xgb-notebook-v1")
    parser.add_argument("--contract", default=str(Path(__file__).with_name("feature-contract.json")))
    parser.add_argument("--version", default=None, help="model version (default: the output folder name)")
    args = parser.parse_args()

    contract = json.loads(Path(args.contract).read_text())["points"]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    version = args.version or out.name

    snapshots = {p: pd.read_csv(Path(args.data) / f"snapshot_{p}.csv") for p in POINTS}
    ids, labels = snapshots["T1M"][ID], snapshots["T1M"][TARGET]
    train_ids, test_ids = train_test_split(ids, test_size=0.20, random_state=SEED, stratify=labels)

    manifest = {
        "model_version": version,
        "framework": "xgboost",
        "xgboost_version": xgboost.__version__,
        "format": "xgboost-json",
        "objective": "binary:logistic",
        "label": TARGET,
        "positive_class": 1,
        "missing_values": "null inputs are passed to XGBoost as missing (NaN)",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "riskPredictionCntd.ipynb XGBClassifier configuration, fitted on the feature contract's columns",
        "points": {},
    }
    for point in POINTS:
        df = snapshots[point]
        features = contract[point]
        missing = [c for c in features if c not in df.columns]
        if missing:
            raise SystemExit(f"{point}: snapshot is missing contract columns {missing}")
        train, test = df[df[ID].isin(train_ids)], df[df[ID].isin(test_ids)]
        model = XGBClassifier(
            n_estimators=300, max_depth=5, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
            eval_metric="logloss", random_state=SEED, n_jobs=-1,
        )
        model.fit(train[features], train[TARGET])
        probability = model.predict_proba(test[features])[:, 1]
        predicted = (probability >= THRESHOLD).astype(int)
        y = test[TARGET]

        path = out / f"{point}.json"
        model.get_booster().save_model(str(path))
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
        }
        m = manifest["points"][point]["metrics"]
        print(f"{point}: {len(features)} features  F1 {m['f1']:.3f}  recall {m['recall']:.3f}  ROC-AUC {m['roc_auc']:.3f}  -> {path}")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\nWrote {out / 'manifest.json'} (model_version {version})")


if __name__ == "__main__":
    np.random.seed(SEED)
    main()