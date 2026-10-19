"""
DiCE success at each prediction point under the previous static limits (+20
marks, +10 attendance points) and the package's data-derived limits, on the
held-out students the current model flags. Uses the scorer's own
counterfactuals.py and the package's models, so it measures exactly what the
scorer does.

    python ml/compare_counterfactual_caps.py --model ml/models/<version> --data <snapshot folder> [--limit 200]

The snapshots do not hold school-day counts, so the attendance ceiling is not
applied here; in the system it can only lower the attendance cap further.
At T3M both runs use the static mark caps (there is no T3F training data) and
the pass-mark rule (--pass-mark, --missing-score-policy).
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "lambdas" / "risk-scorer"))
import counterfactuals as cf  # noqa: E402
import counterfactual_stats  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--data", required=True)
parser.add_argument("--limit", type=int, default=200, help="flagged held-out students per point")
parser.add_argument("--pass-mark", type=float, default=50)
parser.add_argument("--missing-score-policy", default="EXCLUDE")
args = parser.parse_args()

package = Path(args.model)
manifest = json.loads((package / "manifest.json").read_text())
stats_spec = manifest.get("counterfactual_stats")
stats = json.loads((package / stats_spec["file"]).read_text()) if stats_spec else None
if stats is None:
    print("This package has no counterfactual statistics; both runs would use the static limits.")
snapshots = {p: pd.read_csv(Path(args.data) / f"snapshot_{p}.csv") for p in counterfactual_stats.POINTS}
train = counterfactual_stats.training_ids(snapshots)
rules = cf.settings()


def booster(point):
    b = xgboost.Booster()
    b.load_model(str(package / manifest["points"][point]["file"]))
    return b


print(f"{'point':6} {'flagged':>7} {'maintain':>8} | {'static: DiCE found':>19} {'fallback':>8} | {'data: DiCE found':>17} {'fallback':>8} | s/student")
for point in counterfactual_stats.POINTS:
    spec = manifest["points"][point]
    features = spec["features"]
    df = snapshots[point][~snapshots[point]["student_id"].isin(train)]
    X = df[features].to_numpy(dtype=np.float32)
    p = booster(point).predict(xgboost.DMatrix(X, feature_names=features, missing=np.nan))
    flagged = np.where(p >= spec["threshold"])[0][: args.limit]
    nxt = cf.NEXT[point]
    if nxt == cf.FINAL:
        evaluation = cf.PassMarkRule(args.pass_mark, args.missing_score_policy)
    else:
        evaluation = cf.ModelEvaluation(nxt, booster(nxt), manifest["points"][nxt]["features"], float(manifest["points"][nxt]["threshold"]))
    counts = {"static": {"FOUND": 0, "FALLBACK": 0, "MAINTAIN": 0, "NONE": 0}, "data": {"FOUND": 0, "FALLBACK": 0, "MAINTAIN": 0, "NONE": 0}}
    start = time.time()
    for i in flagged:
        values = {f: (None if np.isnan(v) else float(v)) for f, v in zip(features, X[i])}
        for name, s in (("static", None), ("data", stats)):
            counts[name][cf.generate(point, values, evaluation, s, None, rules)["status"]] += 1
    n = len(flagged)
    secs = (time.time() - start) / max(n * 2, 1)

    def rate(c):
        searched = n - c["MAINTAIN"]
        return f"{c['FOUND']:>4}/{searched:<4} {100 * c['FOUND'] / searched if searched else 0:5.1f}%"

    print(f"{point:6} {n:>7} {counts['static']['MAINTAIN']:>8} | {rate(counts['static']):>19} {counts['static']['FALLBACK']:>8} | "
          f"{rate(counts['data']):>17} {counts['data']['FALLBACK']:>8} | {secs:.2f}")
print("\nDiCE found: a valid counterfactual within the limits. Fallback: peer progression used instead. "
      "Maintain: carrying the current results forward already clears the next checkpoint (no search needed).")
