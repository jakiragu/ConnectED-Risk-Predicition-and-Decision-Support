"""
Checks that the scorer's explanations are SHAP values: the shap library's
LinearExplainer (what the scorer uses, through linear_model.py) against the
exact SHAP values of a linear model computed by hand from the model file,
coef_j * (z_j - background mean_j) with base value intercept + coef . background
mean, on a packaged model and snapshot rows, with a share of inputs blanked out
so missing values are covered too. Also checks additivity: base value +
contributions = the model's log-odds output.

    python ml/verify_shap.py --model ml/models/logreg-v1 --data <folder with snapshot CSVs>
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "lambdas" / "risk-scorer"))
import linear_model  # noqa: E402

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
    model = linear_model.LogisticModel(json.loads((Path(args.model) / spec["file"]).read_text()))
    X = pd.read_csv(Path(args.data) / f"snapshot_{point}.csv")[features].head(args.rows).to_numpy(dtype=float).copy()
    X[np.random.default_rng(1).random(X.shape) < args.missing] = np.nan
    base, library = model.explain(X)
    Z = model.standardise(X)
    exact = model.coef * (Z - model.background_mean)
    exact_base = model.intercept + float(model.coef @ model.background_mean)
    margin = model.margin(X)
    diff = float(np.abs(library - exact).max())
    base_diff = abs(base - exact_base)
    additivity = float(np.abs(base + library.sum(axis=1) - margin).max())
    ok = diff < 1e-6 and base_diff < 1e-6 and additivity < 1e-6
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}  {point}: max |LinearExplainer - exact linear SHAP| {diff:.2e}, base value diff {base_diff:.2e}, additivity error {additivity:.2e}")
raise SystemExit(1 if failed else 0)
