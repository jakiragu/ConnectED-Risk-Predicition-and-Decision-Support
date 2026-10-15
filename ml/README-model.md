# The risk model: what the system expects, and how to replace it

The gradebook never trains the model. It builds the inputs, sends them to the
risk scorer, and stores what comes back. The scorer
(`backend/lambdas/risk-scorer`) loads whichever model version
`models/current.json` in the model bucket (`MODEL_BUCKET`) points at.

## What a model package is

A folder with one XGBoost model per prediction point and a manifest:

```
my-model/
  manifest.json
  T1M.json  T1F.json  T2M.json  T2F.json  T3M.json
```

Each model file is a binary classifier (`objective: binary:logistic`) saved in
XGBoost's portable JSON format:

```python
model.get_booster().save_model("T1M.json")     # XGBClassifier
booster.save_model("T1M.json")                 # xgboost.train(...)
```

Train each point on exactly that point's columns from
`ml/feature-contract.json`, in that order. Do not include `prediction_point`,
`student_id`, `academic_risk` or the `noise_*` columns. Fitting on a pandas
DataFrame stores the column names in the file, and publishing checks them.
Missing inputs reach the model as NaN.

`manifest.json`:

```json
{
  "model_version": "xgb-2026-11-02",
  "framework": "xgboost",
  "xgboost_version": "3.4.1",
  "created_at": "2026-11-02T10:00:00Z",
  "source": "what it is and how it was trained",
  "points": {
    "T1M": { "file": "T1M.json", "features": ["T1M_Mathematics", "...", "Attendance_T1M"], "threshold": 0.5,
             "metrics": { "f1": 0.86, "recall": 0.83, "roc_auc": 0.95 } },
    "T1F": { "...": "..." }, "T2M": { "...": "..." }, "T2F": { "...": "..." }, "T3M": { "...": "..." }
  }
}
```

- `model_version`: a new name for every model; a published version is never overwritten.
- `features`: copy them from `ml/feature-contract.json` for the point.
- `threshold`: the probability at or above which a student is flagged at that point.
- `sha256` per file: optional; the publish step fills it in.
- `metrics`: optional; shown on the admin model view.

`python ml/package_xgboost.py` writes a complete package. It fits the notebook's
XGBoost configuration on the contract's columns and is the reference for the format.

## Replacing the model

1. Build the package (your own training, or `npm run model:package -- --data <csv folder> --out ml/models/<version>`).
2. Publish it:
```bash
   npm run model:publish -- ml/models/<version>
```
   This checks the package against the feature contract, uploads it to
   `models/<version>/`, asks the scorer to load and test it, and only then moves
   `models/current.json` to it. A package that fails any step is not used.
3. New publications use the new model straight away; a warm scorer re-reads the
   pointer within `MODEL_POINTER_TTL_SECONDS`.
4. Results that are already published keep their earlier predictions until an
   administrator presses **Run predictions again** on the Model inputs page for
   that class and point.

To go back to a version that is already published:

```bash
npm run model:publish -- --use <model_version>
```

On AWS, run the same commands with AWS credentials and `.env` values for the
AWS model bucket and scorer function. The scorer image does not need rebuilding
for a new model, only for a new XGBoost version. Keep the scorer's
`requirements.txt` on the same XGBoost major version the model was saved with.

## If the model is not an XGBoost binary classifier

The publish step and the scorer accept XGBoost JSON models only. Another kind of
model (for example scikit-learn) needs a loader added to
`backend/lambdas/risk-scorer/model_store.py` and a different `framework` value.
The interface stays the same: feature rows in, one probability per row out.