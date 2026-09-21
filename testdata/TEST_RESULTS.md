# September 19 closure and scoring corrections

Rule version `ps1-local-1.2` reproduces the user's reported A score of 137.9: C006 85.4 + C010 45.5 + C014 7.0. The contract's final delay is multiplied by the sum of all member activity weights. The earlier 32.2 score used individual activity lateness and was incorrect.

Verification: 242 tests passed in the full suite, followed by the newly added cache-score regression (243 distinct tests checked). All 30 dataset/scenario checks, frontend checks and the production build passed. The earlier 49 closure errors remain covered. The corrected A archive has 100% workload coverage, zero local hard violations and a score of 137.9.

Current matrix: [report](results/scoring-fix/REPORT.md), [JSON](results/scoring-fix/report.json). Public local-model optima are A=137.9, B=30, C=62.7. This scoring correction is deployed in `nightshift-planning-v7`; the organiser's full executable remains unavailable. Hosted large/infeasible checks passed, and the four-thread 108-activity C check reached OPTIMAL at 125.4 in 30.90 seconds. See [deployment.json](../docs/deployment.json) for the release evidence.

Earlier closure-only and September 18 matrices used superseded closure/scoring rules and are no longer distributed. They were archived locally during repository cleanup. New runs write to `.nightshift/test-runs/`; see [the dataset guide](README.md) for reproduction commands.
