# Nightshift local dataset test results

Run: 2026-09-18T14:10:33.990593+00:00

Scores and proofs apply to the documented local model. The official validator is unavailable.

| Dataset | Scenario | Result | Score | Bound | Solver seconds | Coverage |
|---|---|---|---:|---:|---:|---:|
| 01_slack_baseline | A | OPTIMAL | 0.0 | 0 | 0.05 | 100.0 |
| 01_slack_baseline | B | OPTIMAL | 0 | 0 | 0.02 | 100.0 |
| 01_slack_baseline | C | OPTIMAL | 0.0 | 0 | 0.04 | 100.0 |
| 02_eclo_deadline | A | OPTIMAL | 70.0 | 70.0 | 0.01 | 100.0 |
| 02_eclo_deadline | B | OPTIMAL | 10 | 10.0 | 0.01 | 100.0 |
| 02_eclo_deadline | C | OPTIMAL | 10.0 | 10.0 | 0.01 | 100.0 |
| 03_sharing_limit | A | OPTIMAL | 70.0 | 70.0 | 0.01 | 100.0 |
| 03_sharing_limit | B | OPTIMAL | 21 | 21.0 | 0.01 | 100.0 |
| 03_sharing_limit | C | OPTIMAL | 21.0 | 21.0 | 1.16 | 100.0 |
| 04_exclusive_mixes | A | OPTIMAL | 210.0 | 210.0 | 0.01 | 100.0 |
| 04_exclusive_mixes | B | OPTIMAL | 42 | 42.0 | 0.01 | 100.0 |
| 04_exclusive_mixes | C | OPTIMAL | 91.0 | 91.0 | 0.03 | 100.0 |
| 05_predecessor_chain | A | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 05_predecessor_chain | B | OPTIMAL | 0 | 0 | 0.01 | 100.0 |
| 05_predecessor_chain | C | OPTIMAL | 0.0 | 0 | 0.01 | 100.0 |
| 06_live_interchange | A | OPTIMAL | 0.0 | 0 | 0.0 | 100.0 |
| 06_live_interchange | B | OPTIMAL | 0 | 0 | 0.01 | 100.0 |
| 06_live_interchange | C | OPTIMAL | 0.0 | 0 | 0.0 | 100.0 |
| 07_eclo_window | A | OPTIMAL | 140.0 | 140.0 | 0.08 | 100.0 |
| 07_eclo_window | B | OPTIMAL | 20 | 20.0 | 0.01 | 100.0 |
| 07_eclo_window | C | OPTIMAL | 80.0 | 80.0 | 0.03 | 100.0 |
| 08_priority_pressure | A | OPTIMAL | 2240.0 | 2240.0 | 4.04 | 100.0 |
| 08_priority_pressure | B | OPTIMAL | 30 | 30.0 | 2.62 | 100.0 |
| 08_priority_pressure | C | OPTIMAL | 720.0 | 720.0 | 4.08 | 100.0 |
| 09_double_network | A | OPTIMAL | 50.4 | 50.4 | 5.78 | 100.0 |
| 09_double_network | B | OPTIMAL | 60 | 60.0 | 4.31 | 100.0 |
| 09_double_network | C | OPTIMAL | 50.4 | 50.4 | 9.06 | 100.0 |
| 10_impossible_workload | A | INFEASIBLE | — | — | 0.0 | — |
| 10_impossible_workload | B | INFEASIBLE | — | — | 0.0 | — |
| 10_impossible_workload | C | INFEASIBLE | — | — | 0.0 | — |

Checks passed: 30/30. Complete schedules: 27. Proven primary-score optima: 27. Full CP-SAT OPTIMAL status: 27. Proven infeasible: 3.

A feasible schedule attaining an independent lower bound proves the primary score optimal even if CP-SAT is still working on its secondary tie-break objective.
