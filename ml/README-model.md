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
  counterfactual-stats.json      (optional)
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
             "metrics": { "f1": 0.86, "recall": 0.83, "roc_auc": 0.95 },
             "global_importance": { "method": "mean |SHAP| ...", "rows": 1000,
                                    "features": { "T1M_Kiswahili": 0.96, "...": 0 },
                                    "groups": { "Kiswahili": 0.96, "Attendance": 0.78, "...": 0 } } },
    "T1F": { "...": "..." }, "T2M": { "...": "..." }, "T2F": { "...": "..." }, "T3M": { "...": "..." }
  }
}
```

- `model_version`: a new name for every model; a published version is never overwritten, not even its manifest.
- `features`: copy them from `ml/feature-contract.json` for the point.
- `threshold`: the probability at or above which a student is flagged at that point.
- `sha256` per file: optional; the publish step fills it in.
- `metrics`: optional; shown on the admin model view.
- `counterfactual_stats`: optional; `{ "file": "counterfactual-stats.json", "sha256": ..., "settings": ... }`,
  written by the packaging script (see Counterfactual targets).
- `global_importance`: optional; the model's global SHAP importance on held-out data, shown as
  "What drives the model". `groups` uses the model's subject names (`Religious_Education`)
  and `Attendance`; `package_xgboost.py` shows how it is computed.

## Explanations

The scorer explains every prediction with SHAP values from XGBoost's built-in
TreeSHAP (`pred_contribs`). Any XGBoost model package gets explanations; nothing
in the manifest is needed for them. `python ml/verify_shap.py --model <package>
--data <csv folder>` checks that they match the `shap` library's TreeExplainer
and add up to the model's output.

`python ml/package_xgboost.py` writes a complete package. It fits the notebook's
XGBoost configuration on the contract's columns and is the reference for the format.

## Counterfactual targets

For every student the model flags at a prediction point, the scorer works out
targets for the NEXT checkpoint (`backend/lambdas/risk-scorer/counterfactuals.py`):

1. The current results and attendance are carried forward as a hypothetical
   next-checkpoint record; missing results stay missing.
2. That record is judged by the next checkpoint's model (T1M targets by the T1F
   model, and so on). At T3M there is no next model: the record is judged by the
   At_Risk rule on the projected Term 3 Final average against the school's pass
   mark, with missing subjects handled by the school's `missing_score_policy`.
3. DiCE searches upward changes within the permitted-change caps for a record
   that is no longer at risk. If it finds none, peer progression supplies the
   targets instead (they may not clear the model; the projection says so).

`counterfactual-stats.json` (written by `package_xgboost.py`, or added to an
existing package by `ml/counterfactual_stats.py`) holds, from the training
students only:

- caps per transition: P90 of positive mark changes per subject, P95 of
  positive year-to-date attendance changes (the scorer also caps attendance at
  the most a student can reach by attending every school day of the next period);
- peer progression per transition, subject and attendance: for every whole-mark
  centre of the student's average so far, the window (+-5 widening to +-15
  marks until at least 30 peers), the group size and the P75 change.

Without the file, or for T3M -> T3F where there is no training data, the static
limits apply (`COUNTERFACTUAL_STATIC_MARK_CAP` 20 marks,
`COUNTERFACTUAL_STATIC_ATTENDANCE_CAP` 10 points) and there are no peer groups.
`counterfactual_stats.py --help` lists the percentiles and window settings.
`python ml/compare_counterfactual_caps.py --model <package> --data <csv folder>`
compares DiCE success at each point under the static and the data-derived limits.

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