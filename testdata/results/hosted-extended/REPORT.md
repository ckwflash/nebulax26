# Nightshift hosted dataset test results

Run: 2026-09-18T14:17:39.164194+00:00

Scores and proofs apply to the documented local model. The official validator is unavailable.

| Dataset | Scenario | Result | Score | Bound | Solver seconds | Coverage |
|---|---|---|---:|---:|---:|---:|
| 09_double_network | C | OPTIMAL | 50.4 | 50.4 | 93.98 | 100.0 |

Checks passed: 1/1. Complete schedules: 1. Proven primary-score optima: 1. Full CP-SAT OPTIMAL status: 1. Proven infeasible: 0.

A feasible schedule attaining an independent lower bound proves the primary score optimal even if CP-SAT is still working on its secondary tie-break objective.

Initial polling failed with a transient 404; later retrieval confirmed this same run completed optimally. See initial-poll-failure.json. A separate post-fix run is required to verify polling.
