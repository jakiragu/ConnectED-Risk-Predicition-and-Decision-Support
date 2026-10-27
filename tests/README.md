# Test suite (Section 5.4.2)

Every case is declared with `tc({ id, requirement, level, scenario, data, expected })` before it
runs. Its observed result and verdict are appended to `docs/evidence/test-cases.jsonl`, and
`npm run test:report` turns that file into the Table 5.3 rows (`docs/evidence/test-cases.md`).
Nothing is edited by hand. Earlier failed runs stay in the file and in the report, because a
failure that a later run fixed is still a result.

Verdicts: `PASS`, `FAIL`, `SKIPPED`. A skipped case never ran its check: it is not a pass and it
is not evidence. Each skip states its reason.

## Add to package.json

Copy the entries in `package-scripts.json` into the `scripts` block (and make `"test"` run
`node --test tests/unit/*.test.js`). Node 20.10 or later is needed for `--test-concurrency=1`.

## Running it

```bash
npm run db:infra          # stand-ins (Docker)
npm run aws:setup
npm run db:seed           # RESET THE DATA before each fresh full run (see below)
npm run model:publish -- ml/models/xgb-notebook-v2   # the scorer needs a published model
npm run api               # in its own terminal; see the scorer note below
npm run test:evidence     # unit + integration, recorded
npm run test:report       # builds docs/evidence/test-cases.md
npm run test:env          # records the environment; add service versions by hand
```

**Scorer.** TC-P01, TC-P02 and TC-R01 to R09 need the prediction pipeline: start `npm run api` with
`LOCAL_PYTHON` pointing at a Python that has xgboost, numpy, pandas, scikit-learn, shap and dice-ml
(`ml/requirements.txt`). TC-P01 and TC-P02 check the scorer with its own selftest first and are
SKIPPED, with the reason, if it cannot run.

**Reseed before every full run.** Publishing is permanent for a seed, and papers cannot be removed
once marks exist. A case that finds its data already published or used says so and is SKIPPED;
reseed and rerun.

## What data the cases use

The seed already holds complete, scored papers for the test class (all model subjects, 100% of
each exam) at Term 1 Opener/Mid-term/End-term, Term 2 Mid-term/End-term and Term 3 Mid-term. The
publication cases publish THOSE papers and add none, so what is published is what was seeded.
Terms are used so that cases do not interfere:

| Variable | Used for | Default |
|---|---|---|
| `TEST_TERM` | gradebook cases that create papers (free paper slots, small weights) | `term_2026_3` |
| `TEST_CALC_TERM` | TC-G05 hand calculation (Opener, calculated, not published) | `term_2026_2` |
| `TEST_PUB_TERM` | TC-G06, G07, G12: seeded Opener, Mid-term, End of term published, term locks | `term_2026_1` |
| `TEST_PIPELINE_TERM` | TC-P01, P02: Mid-term published (T2M predicted), End of term published with the scorer broken | `term_2026_2` |
| `TEST_POINT` | prediction point the risk cases read | first of T1M, T1F, T2M, T2F, T3M with predictions |
| `TEST_REPORT_WAIT_S` | how long TC-G07 waits for the report-card worker | `30` |
| `TEST_PIPELINE_TIMEOUT_MS` | how long TC-P01 waits for predictions | `120000` |

In PowerShell set one with `$env:TEST_REPORT_WAIT_S = "60"`.

## Where each requirement is covered

| | Automated | Manual (`tests/manual/manual-cases.md`) |
|---|---|---|
| FR-01 to FR-05 | TC-G01 to G06, G09 to G14 | |
| FR-06 | TC-G07 (needs the report-card worker; otherwise SKIPPED) | TC-M01 (the PDF) |
| FR-07, FR-08 | TC-P01 (real pipeline), TC-R01, unit TC-U05, U08, U09 | |
| FR-09, FR-10 | TC-R02, R03, unit TC-U02, U03, U10, U12 | TC-M02, M03 (model-level checks) |
| FR-11, FR-12 | TC-R04 to R08, unit TC-U04, U06 | TC-M04 to M06 (browser, offline) |
| NFR-1 | TC-A01 to A10, unit TC-U01 | |
| NFR-2 | TC-P02 (fault injection), unit TC-U07 | TC-M07 (optional UI check) |
| NFR-3 | | TC-M08 (code review, by design) |
| NFR-4 | TC-R09 (automated inspection), unit TC-U11 | TC-M09 (developer inspection; no educator review) |

## Without a scorer: the fixture

`node local/seed-risk-fixture.js` writes fixed test values (model version `fixture-v1`) so the
cases that test what the API returns and what an educator can do (TC-R04 to R09) can run.
TC-R01 to R03 are SKIPPED on fixture data because they need real model output, and each case that
reads a prediction records which kind it read. Run the fixture AFTER the gradebook cases, then:

```bash
node --test tests/integration/risk-pipeline.test.js
```

Results are appended, and the report shows the latest run of each case.

## Fault injection (TC-P02)

TC-P02 removes `models/current.json` from the model bucket, waits for the scorer's pointer cache
(`MODEL_POINTER_TTL_SECONDS`) to expire, and confirms the scorer really fails. It then publishes
End of term, checks the gradebook is unaffected and the profile marks the earlier prediction as not
current, and always restores the pointer.
