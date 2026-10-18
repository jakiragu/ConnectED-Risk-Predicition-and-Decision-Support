"""
Checks that the scorer's explanations are SHAP values: XGBoost's built-in
TreeSHAP (what the scorer uses) against the shap library's TreeExplainer, on a
packaged model and snapshot rows, with a share of inputs blanked out so missing
values are covered too. Also checks additivity: base value + contributions =
the model's log-odds output.

    python ml/verify_shap.py --model ml/models/xgb-notebook-v1 --data <folder with snapshot CSVs>
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import shap
import xgboost

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--data", required=True)
parser.add_argument("--rows", type=int, default=300)
parser.add_argument("--missing", type=float, default=0.25, help="share of inputs blanked out")
args = parser.parse_args()

manifest = json.loads((Path(args.model) / "manifest.json").read_text())
failed = False
for point, spec in manifest["points"].items():
    features = spec["features"]
    booster = xgboost.Booster()
    booster.load_model(str(Path(args.model) / spec["file"]))
    X = pd.read_csv(Path(args.data) / f"snapshot_{point}.csv")[features].head(args.rows).to_numpy(dtype=float).copy()
    X[np.random.default_rng(1).random(X.shape) < args.missing] = np.nan
    matrix = xgboost.DMatrix(X, feature_names=features, missing=np.nan)
    native = booster.predict(matrix, pred_contribs=True)
    margin = booster.predict(matrix, output_margin=True)
    explainer = shap.TreeExplainer(booster)
    library = explainer.shap_values(X)
    diff = float(np.abs(native[:, :-1] - library).max())
    base = abs(float(native[0, -1]) - float(np.ravel(explainer.expected_value)[0]))
    additivity = float(np.abs(native.sum(axis=1) - margin).max())
    ok = diff < 1e-4 and base < 1e-4 and additivity < 1e-3
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}  {point}: max |TreeSHAP - shap library| {diff:.2e}, base value diff {base:.2e}, additivity error {additivity:.2e}")
raise SystemExit(1 if failed else 0)