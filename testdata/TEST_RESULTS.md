# Dataset testing results — 18 September 2026

Ten demand books were tested across A/B/C locally and on the deployed Google Cloud Run service.

- **60/60 main-matrix checks passed**: 30 local and 30 hosted.
- **54 complete schedules** achieved the independently expected optimal primary scores, all with 100% workload coverage and checked safety.
- **6 expected infeasible results** were correctly identified. The hosted service refused their exports with HTTP 409.
- **212 regression tests passed**, including reproducibility, input transformations, and the storage-race regression.
- Every feasible main-matrix result passed CSV round-trip validation and exact three-file export checks.

| Dataset | Optimal scores A / B / C | Local solver seconds A / B / C | Cloud solver seconds A / B / C |
|---|---|---|---|
| 01_slack_baseline | 0.0 / 0 / 0.0 | 0.05 / 0.02 / 0.04 | 0.15 / 0.12 / 0.14 |
| 02_eclo_deadline | 70.0 / 10 / 10.0 | 0.01 / 0.01 / 0.01 | 0.12 / 0.11 / 0.11 |
| 03_sharing_limit | 70.0 / 21 / 21.0 | 0.01 / 0.01 / 1.16 | 0.11 / 0.12 / 1.16 |
| 04_exclusive_mixes | 210.0 / 42 / 91.0 | 0.01 / 0.01 / 0.03 | 0.12 / 0.11 / 0.14 |
| 05_predecessor_chain | 0.0 / 0 / 0.0 | 0.01 / 0.01 / 0.01 | 0.13 / 0.12 / 0.12 |
| 06_live_interchange | 0.0 / 0 / 0.0 | 0.00 / 0.01 / 0.00 | 0.11 / 0.09 / 0.11 |
| 07_eclo_window | 140.0 / 20 / 80.0 | 0.08 / 0.01 / 0.03 | 0.12 / 0.10 / 0.13 |
| 08_priority_pressure | 2240.0 / 30 / 720.0 | 4.04 / 2.62 / 4.08 | 12.04 / 13.62 / 24.36 |
| 09_double_network | 50.4 / 60 / 50.4 | 5.78 / 4.31 / 9.06 | 33.70 / 53.56 / 60.09 |
| 10_impossible_workload | Infeasible / Infeasible / Infeasible | 0.00 / 0.00 / 0.00 | 0.00 / 0.00 / 0.00 |

## The 60-second boundary

The 108-activity C case reached score 50.4 and a reported primary bound of 50.4 within 60.09 seconds in Cloud Run. Its CP-SAT status was FEASIBLE because the combined objective also minimizes a secondary tie-break term. Independent component-wise lower bounds already establish that 50.4 is the optimal primary score. The other 26 feasible cloud cases, and all 27 local cases, returned OPTIMAL.

A separate 300-second-budget run reached full OPTIMAL status at the same 50.4 score in 93.98 seconds. Its initial polling attempt hit a transient 404; later retrieval recovered and checked the same completed run. This observation is preserved in results/hosted-extended/initial-poll-failure.json. It is not counted as an uninterrupted polling success.

## Defect exposed by testing

A GCS read first loads metadata, which pins its subsequent download to that object generation. If a checkpoint is overwritten between those calls, GCS can return 404 for the obsolete generation even though the run still exists. The old code incorrectly reported the run absent.

The fix distinguishes a missing object during fresh metadata lookup from a missing old generation during download. The latter retries current metadata; five successive conflicts produce an explicit storage error. A deterministic test failed before the fix, and a real-GCS overwrite reproduced the 404 and then confirmed the fixed reader recovered the current checkpoint. The 212-test suite passes. The fix was deployed as revision `nightshift-00005-xil`. A fresh 108-activity Scenario C run against its candidate URL completed with uninterrupted polling, full OPTIMAL status, score/bound 50.4, 100% coverage and a checked export in 53.70 solver seconds (56.05 seconds including API overhead). The candidate was then promoted to the standard public URL. This is one observed post-fix run; it does not establish a speed improvement. See `results/hosted-post-fix/REPORT.md`.

## Scope and limitations

These are synthetic/local-model expectations, not official validator acceptance. Case 09 is a disjoint four-line scale test, not coupled congestion; cases 03/04 supply targeted congestion checks. Timings are individual observations, with four local solver threads versus two hosted threads and GCS progress persistence.

The main hosted matrix used revision nightshift-00003-lah. The storage repair does not alter scheduling constraints or the objective. Raw schedules, witnesses, bounds and JSON reports remain in results/.
