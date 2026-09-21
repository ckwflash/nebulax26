# Submission checklist

The authoritative list is [PS1 §4: Deliverables](../PS1/PS1_README.md#4-deliverables). The submission includes results, a live application, a video and complete source.

| Deliverable | Where to find it | Status |
|---|---|---|
| Public A/B/C results | [public-results.zip](../submissions/public-results.zip), or the separate `nightshift-A-corrected.zip`, `nightshift-B-corrected.zip` and `nightshift-C-corrected.zip` in `submissions/` | Prepared; each scenario contains exactly the three required CSVs |
| Hosted app URL | [Nightshift](https://nightshift-717753975344.us-central1.run.app) | Deployed; see the [handoff](DEPLOYMENT_HANDOFF.md) for hosting lifetime limits |
| Three-minute YouTube video | [Walkthrough outline](DEMO.md) | Published video URL still required |
| GitLab repository URL | Complete working tree and [setup instructions](../README.md#run-locally) | Current origin is GitHub; a GitLab URL still required |

Current local-model scores are A **137.9**, B **30**, C **62.7**. The checker reproduces the supplied closure errors and A score; the organiser's full validator is unavailable. The scoring interpretation and its difference from the brief's wording are recorded in [RULES.md](RULES.md). Keep that qualification with the results.

## What belongs in the repository

- `trackaccess/`, `src/`, entry points, package manifests and lockfiles: the solver, validator, API and frontend, with reproducible setup.
- `PS1/`: original instructions, eight input CSVs, network references and sample outputs.
- `outputs/`: checked public schedules and their local reports/witnesses. The app uses these to seed its demo.
- `submissions/`: the CSV archives, hashes and supporting validation/optimality evidence. Local sidecars do not belong inside the three-CSV scenario exports.
- `tests/`, `scripts/`, `testdata/`: reproducible verification, input fixtures and the current compact scoring matrix. The fixtures are consumed by tests; the upload ZIPs are checked against the generator.
- `README.md`, `docs/`, Docker and CI configuration: setup, rules, operation and deployment instructions.

`uv.lock` is used by local `uv` setup, `requirements.lock` by Docker/CI, and `package-lock.json` by npm. `PS1.zip` is used by hosted verification scripts. Keep these unless their consumers are updated.

`EDA.md` and the 1.6 MB `LTA_DataMall_API_User_Guide.pdf` are optional background references, retained as supplied research material. They are not runtime dependencies. The source package retains them; Docker and Cloud Run uploads exclude them.

## What stays local

`.venv/`, `node_modules/`, `dist/`, caches, `*.egg-info/`, `.git/`, `.env`, `.nightshift/` and `release/` are excluded from the source package. Installed dependencies can be regenerated. `.nightshift/` can hold saved plans and deployment evidence, so it should not be treated as a disposable cache.

Superseded test matrices and their full schedule dumps have been removed from the working tree. A hash-verified backup from this cleanup is retained locally at `.nightshift/repo-cleanup/2026-09-19/before-cleanup.tar.gz`. The current report is [testdata/results/scoring-fix/REPORT.md](../testdata/results/scoring-fix/REPORT.md). New dataset runs default to ignored `.nightshift/test-runs/` folders.

## Build a clean source package

From the repository root:

```sh
python3 scripts/package_submission.py
```

This writes `release/nightshift-source.zip` and `release/source-manifest.json`. It packages the current working files, including new files that have not been committed; it does not use an older Git commit. The manifest lists every included path, size and SHA-256 hash. Archive timestamps are fixed so unchanged files produce the same ZIP.

The source ZIP is a handoff convenience. It does not replace the required GitLab URL, hosted app or video. Review and commit the source changes and cleanup deletions before publishing the repository; no commit, push or deployment is performed by the packager.

Recreate dependencies in an extracted package with `uv sync --extra test` and `npm ci`. Check with `uv run pytest -q`, `npm run check` and `npm run build`.
