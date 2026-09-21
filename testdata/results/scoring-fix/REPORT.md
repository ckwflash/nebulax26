# Nightshift local dataset test results

Run: 2026-09-19T05:18:37.870972+00:00

Scores and proofs apply to the documented local model. The official validator is unavailable.

| Dataset | Scenario | Result | Score | Bound | Solver seconds | Coverage |
|---|---|---|---:|---:|---:|---:|
| 01_slack_baseline | A | OPTIMAL | 0.0 | 0 | 0.02 | 100.0 |
| 01_slack_baseline | B | OPTIMAL | 0 | 0 | 0.02 | 100.0 |
| 01_slack_baseline | C | OPTIMAL | 0.0 | 0 | 0.02 | 100.0 |
| 02_eclo_deadline | A | OPTIMAL | 70.0 | 70.0 | 0.01 | 100.0 |
| 02_eclo_deadline | B | OPTIMAL | 10 | 10.0 | 0.01 | 100.0 |
| 02_eclo_deadline | C | OPTIMAL | 10.0 | 10.0 | 0.01 | 100.0 |
| 03_sharing_limit | A | OPTIMAL | 70.0 | 70.0 | 0.02 | 100.0 |
| 03_sharing_limit | B | OPTIMAL_WITH_OVERRUN | — | — | 0.02 | 100 |
| 03_sharing_limit | C | OPTIMAL | 70.0 | 70.0 | 0.02 | 100.0 |
| 04_exclusive_mixes | A | OPTIMAL | 210.0 | 210.0 | 0.01 | 100.0 |
| 04_exclusive_mixes | B | OPTIMAL_WITH_OVERRUN | — | — | 0.02 | 100 |
| 04_exclusive_mixes | C | OPTIMAL | 210.0 | 210.0 | 0.01 | 100.0 |
| 05_predecessor_chain | A | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 05_predecessor_chain | B | OPTIMAL | 0 | 0 | 0.01 | 100.0 |
| 05_predecessor_chain | C | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 06_live_interchange | A | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 06_live_interchange | B | OPTIMAL | 0 | 0 | 0.01 | 100.0 |
| 06_live_interchange | C | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 07_eclo_window | A | OPTIMAL | 140.0 | 140.0 | 0.01 | 100.0 |
| 07_eclo_window | B | OPTIMAL | 20 | 20.0 | 0.01 | 100.0 |
| 07_eclo_window | C | OPTIMAL | 80.0 | 80.0 | 0.02 | 100.0 |
| 08_priority_pressure | A | OPTIMAL | 13580.0 | 13580.0 | 4.83 | 100.0 |
| 08_priority_pressure | B | OPTIMAL | 30 | 30.0 | 3.3 | 100.0 |
| 08_priority_pressure | C | OPTIMAL | 3870.0 | 3870.0 | 7.24 | 100.0 |
| 09_double_network | A | OPTIMAL | 275.8 | 275.8 | 8.94 | 100.0 |
| 09_double_network | B | OPTIMAL | 60 | 60.0 | 8.83 | 100.0 |
| 09_double_network | C | OPTIMAL | 125.4 | 125.4 | 10.97 | 100.0 |
| 10_impossible_workload | A | INFEASIBLE | — | — | 0.0 | — |
| 10_impossible_workload | B | INFEASIBLE | — | — | 0.0 | — |
| 10_impossible_workload | C | INFEASIBLE | — | — | 0.0 | — |

Checks passed: 30/30. Complete schedules: 27. Proven primary-score optima: 25. Full CP-SAT OPTIMAL status: 25. Proven infeasible: 5.

A feasible schedule attaining an independent lower bound proves the primary score optimal even if CP-SAT is still working on its secondary tie-break objective.
