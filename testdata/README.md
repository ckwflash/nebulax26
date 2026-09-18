# Nightshift test datasets

Ten reproducible demand books for testing correctness, scenario trade-offs and scale. These are synthetic test inputs, not additional official hackathon datasets. Their expectations use the rules documented in `docs/RULES.md` and the updated PS1 participant brief. Official validator acceptance remains unverified.

## Use in the deployed app

1. Extract `nightshift-test-datasets.zip`.
2. Click **Upload demand book** in [Nightshift](https://nightshift-717753975344.us-central1.run.app/).
3. Upload one of the individual ZIPs in the extracted `datasets/` folder. Each contains exactly the eight required input CSVs. Do not upload the outer collection ZIP.
4. Run A, B and C and compare with the table below. For manual testing of the 108-activity case, use **Improve for five minutes** if a 60-second run has not finished proving optimality.

In this repository, uncompressed inputs live in `datasets/<case>/`, with individual upload ZIPs in `zips/`. The original `PS1/01_data` and submitted reference outputs are unchanged. Loading a new book changes the selected book in that browser; the API test runner does not adopt or overwrite your existing selected schedule.

## Expected outcomes

Lower scores are better. The figures below are expectations with mathematical explanations in `manifest.json`, not benchmarks copied from the newly generated solver outputs.

| ZIP | Activities / work units | Purpose | A | B | C |
|---|---:|---|---:|---:|---:|
| `01_slack_baseline.zip` | 3 / 6 | Simple complete, on-time schedule | 0 | 0 | 0 |
| `02_eclo_deadline.zip` | 1 / 3 | Standard-work delay versus ECLO compression | 70 | 10 | 10 |
| `03_sharing_limit.zip` | 5 / 5 | Fifth compatible job exceeds four-job sharing limit | 70 | 21 | 21 |
| `04_exclusive_mixes.zip` | 3 / 3 | PM isolation, PC incompatibility, C's excess cap | 210 | 42 | 91 |
| `05_predecessor_chain.zip` | 3 / 5 | Strict precedence across three contracts | 0 | 0 | 0 |
| `06_live_interchange.zip` | 2 / 2 | Opposite-bound and cross-line Live protection | 0 | 0 | 0 |
| `07_eclo_window.zip` | 2 / 6 | Separated demand peaks, one two-week ECLO window | 140 | 20 | 80 |
| `08_priority_pressure.zip` | 54 / 192 | Public network with changed priority weights | 2240 | 30 | 720 |
| `09_double_network.zip` | 108 / 384 | Four-line scalability and independent components | 50.4 | 60 | 50.4 |
| `10_impossible_workload.zip` | 1 / 4 | Insufficient horizon even with maximum ECLO | Infeasible | Infeasible | Infeasible |

Case 10 must return **INFEASIBLE**, with no schedule and no downloadable partial result. It needs four work units in two weeks; even ECLO delivers at most three. A timeout (`UNKNOWN`) is a different outcome and does not pass this check.

Case 09 deliberately has four synthetic lines. It measures growth in model size with a provable answer; it is not a congested four-line operational benchmark. The current UI has decorative Alpha/Beta and “Two lines” captions, while its network rows and solver inputs are data driven. Use this case primarily for solver/API scale checks.

## Why the construction is useful

- **Separate effects:** small cases isolate each constraint, so a score or feasibility error has an identifiable cause.
- **Independent answers:** workload arithmetic, sharing limits and available weeks establish bounds without invoking the planner. Case 08 also uses a resource-free C bound by enumerating 0–2 ECLO accesses per activity. Valid schedules attaining those bounds prove their primary scores optimal.
- **Certified composition:** case 09 duplicates all identifiers and resources into disjoint components. Original optimum scores add exactly; protection and ECLO windows cannot accidentally connect the copies.
- **Controlled realism:** case 08 keeps the real public topology, demands and dates, and changes only priority weights with seed `20260918`. The original feasible schedules remain feasible.
- **Reproducibility:** fixed seed, stable CSV order, fixed ZIP timestamps, per-archive SHA-256 hashes and a generator that does not import the solver. Expectations are separate from execution reports.
- **Relationship tests:** CSV row shuffling, ID renaming and a 28-day date shift must preserve results. More supply must remove the known sharing bottleneck. A longer horizon restores A/C feasibility in case 10 while B's unchanged hard deadline remains impossible.
- **Correct failure behavior:** infeasibility is expected and tested, rather than treating every returned object as a successful solve.

This is targeted coverage, not an exhaustive proof that the application handles every possible input. Small cases are not representative performance benchmarks, and the four-line case does not stress cross-component congestion.

## Reproduce

From the repository root:

```sh
uv run python scripts/generate_test_datasets.py
uv run python scripts/test_datasets.py --seconds 60
uv run python scripts/test_datasets.py --url https://nightshift-717753975344.us-central1.run.app --seconds 60
uv run --extra test pytest -q
```

The hosted command uploads only these synthetic/public-derived datasets and submits one solve at a time. It creates durable test books and versions in the existing GCS bucket. It does not change infrastructure settings or the browser's selected version. It uses the warm service and incurs normal compute/storage usage.

For a focused rerun, add `--only 07_eclo_window --scenarios C --out testdata/results/focused`. Without `--out`, the runner replaces that mode's summary with the selected run. The input generator does not delete solver results. Regenerate the outer bundle after editing this guide if distributing it.

## Verification artifacts

The outer collection includes `TEST_RESULTS.md` and compact reports under `reports/`. The full artifacts below live in the repository.

- `results/local/REPORT.md` and `results/hosted/REPORT.md`: per-scenario scores, bounds, statuses, timings and coverage.
- `results/local/report.json` and `results/hosted/report.json`: machine-readable checks; hosted rows include saved run IDs.
- `results/<mode>/<case>/<scenario>/`: checked schedule CSVs, timing witness, solver report and exact three-CSV export ZIP for feasible cases.
- `TEST_RESULTS.md`: combined outcome and timing summary.

For every feasible run, the runner independently revalidates the returned schedule, checks per-activity delivered work, compares the known score, round-trips CSV serialization and verifies the export contains exactly `SCHEDULE_ACCESS.csv`, `SCHEDULE_OCCUPANCY.csv` and `RESULTS.csv`. It also corrupts the Live timing witness to check that unsafe simultaneous work is rejected. Hosted infeasible runs must refuse export with HTTP 409.

Elapsed solver times exclude some upload, queue, polling and final-download time; the JSON also records wall time. Local tests use four solver threads by default and the deployed service uses two, with durable progress writes. These are one-run observations, not a controlled hardware benchmark.
