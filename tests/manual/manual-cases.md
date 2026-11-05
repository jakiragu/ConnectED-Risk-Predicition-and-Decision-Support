# Manual test cases

These cases cover what the automated suite cannot: the browser, a generated PDF,
the model's own numeric properties, and a code review. They use the same columns
as Table 5.3. **Fill the last column only after running the case**, and keep a
failed result and its retest as two rows; do not overwrite a failure.

Evidence goes in `docs/evidence/manual/` and is referenced by file name.

| Test ID | Traceability | Steps and data | Expected result (written before running) | Actual result, evidence, verdict |
|---|---|---|---|---|
| TC-M01 | FR-06 | 1. Publish the End-term set for the test class. 2. Open the Report cards page and download one student's card. 3. Try the same for a class whose results are not published. | The PDF shows the student's published results, matching the Results page; for the unpublished class no final card is produced. | |
| TC-M02 | FR-09 | Run the SHAP verification script in `ml/` (`verify_shap.py`) on the deployed model package. Save the console output. | For every student checked, base value plus the sum of contributions equals the model output within the script's stated tolerance, and the values match the `shap` library. | |
| TC-M03 | FR-10 | Run the counterfactual Python tests (`test_counterfactuals.py`) and save the output. | Every option stays within its cap and 100, and re-scoring each option through the model reproduces the stored score and at-risk flag. | |
| TC-M04 | FR-11 | Sign in as the class teacher, open a flagged student's profile, and screenshot the whole page. | Risk estimate, SHAP factors and targets are all on the one page without navigating away. | |
| TC-M05 | FR-12 | In the browser, switch to offline. Record an intervention, edit it, stop it, restart it, then reconnect. | All actions are kept locally while offline; after reconnecting the server holds one intervention with the final state and no duplicate. | |
| TC-M06 | FR-12 | Offline, create an intervention and delete it again, with the create still in flight when the delete is queued; reconnect. | The deleted intervention does not reappear. *Known limitation recorded during development: the create can land after the delete. Record the observed result and, if it fails, a defect ID.* | |
| TC-M07 | NFR-2 | Optional UI check, companion to automated TC-P02 (which checks the same through the API). With a prediction in place, remove `models/current.json` from the model bucket, wait for the pointer cache to expire, publish the next checkpoint, and open the student's profile in the browser. Restore the pointer afterwards. | Publishing completes; the profile shows the previous risk value with a visible "not current" label. | |
| TC-M08 | NFR-3 | 1. Record the current model manifest (version). 2. Build and publish a retrained package: `npm run model:package`, `npm run model:publish`. 3. `git diff --stat` for the table definition (`local/create-table.js`), key helpers (`backend/library/keys.js`) and the GraphQL schema file. 4. Publish a checkpoint and read one new prediction. | No change to table definition, keys or schema is needed; the new prediction carries the new model version. Verified by code review, as NFR-3 states. | |
| TC-M09 | NFR-4 | Open a profile as class teacher and read every label in the factors and targets panels. | No raw model column name (such as `T1F_Religious_Education`) appears. *Developer inspection only: no educator review was carried out, so this does not show that educators understood the labels.* | |
