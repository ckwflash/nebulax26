> Current release: `nightshift-stress-20260919-064348`, 100% traffic, **8 vCPU / 8 solver threads / 4 GiB**. Includes the current stress-test changes. The top Active plan selector is removed; use A/B/C in Scenario results. Cloud Build passed; additional testing was skipped at the user's request. Prior release details below are historical.

> Current release: `nightshift-scenario-20260919-063122`, 100% traffic, **8 vCPU / 8 solver threads / 4 GiB**. A/B/C selection immediately adopts the plan; its selector stays visible. Scenario batches run concurrently with 3/3/2 threads. Further release validation was skipped at the user's request. Prior release details below are historical.

# RailPlan deployment handoff — 19 September 2026

Live: https://nightshift-717753975344.us-central1.run.app

- Project / region: `qwiklabs-gcp-00-71d4c677d0cc` / `us-central1`
- Service / serving revision: `nightshift` / `nightshift-library-20260919-061014`, 100% traffic, no temporary tags
- Runtime: **4 vCPU, 4 solver threads, 4 GiB**, one warm instance, maximum one, concurrency 20, port 8080, CPU always allocated
- Budgets: 90-second standard solves and previews, 300-second Improve, 90 seconds shared by five recovery options; one concurrent job and four admitted jobs
- Image: `us-central1-docker.pkg.dev/qwiklabs-gcp-00-71d4c677d0cc/nightshift/nightshift@sha256:5a1990d818263b32361bf9cc0da1e9c87631e62aaf452db43cff535137db2c45`
- Cloud Build: `db94376e-beba-4a3f-9030-9c5323a6023b`
- Runtime identity: `nightshift-run@qwiklabs-gcp-00-71d4c677d0cc.iam.gserviceaccount.com`
- Private durable state: `qwiklabs-gcp-00-71d4c677d0cc-nightshift-state`; attached credentials, no downloadable keys
- Vertex: `gemini-3.8-flash`, global endpoint, attached identity; visible evidence fallback on provider failure

## Delivered

Integrated the remote frontend through `4c6d541`, preserving the planning workflows. The Dataset library automatically saves uploads, searches saved names/IDs, reopens approved plans and scenario history, and downloads the original eight CSVs. Uploaded demand books queue A/B/C solves; saved results can be reopened without solving again. Existing cloud data was indexed: 12 datasets and 132 schedule versions. The migration left all 112 existing dataset, run and approval object generations unchanged.

Contractor requests, assessments, counteroffers, atomic acceptance, inherited bookings, five recovery policies and explicit adoption remain available. Reports export the three required CSVs and now include printable HTML document packs. Linux `fcntl` is retained.

## Evidence and limits

257 Python tests, frontend build and adapter/render/upload-state checks passed for the frozen release sources. Hosted checks verified save/list/reopen, repeat-upload deduplication, original source ZIP contents, A/B/C solves and exact exports, approved-plan restoration, printable reports and fresh-client history. Browser checks verified searching, opening, and reloading a saved dataset with no console errors or warnings. All 13 datasets (including one labelled QA fixture) and 136 versions loaded successfully. Public frontend bytes match the frozen build.

Corrected local scores remain A **137.9**, B **30**, C **62.7**. The preceding planning release measured public solves at **11.84 / 9.03 / 12.60 seconds**, and 108-activity C at **125.4 in 30.90 seconds**; those performance samples were not repeated for this release.

The preceding planning release covered Vertex responses, request workflows, five-policy comparisons, improvement and chat previews, plus an explicitly **simulated expired checkpoint across a real revision replacement**. The library release preserved the same storage, runtime identity, Vertex configuration and resource limits. A previously abandoned simulated recovery batch completed when its historical record was opened.

The state bucket remains the existing private bucket; the application library is shared across public-demo visitors. The preceding release's 500-entry security log review is recorded separately. Local checking remains distinct from official judging acceptance. The temporary lab project's lifetime is unverified; the URL is not guaranteed through judging.

Full records: [deployment.json](deployment.json), [Cloud Run log](CLOUD_RUN.md), [API contract](BACKEND_CONTRACT.md). Detailed evidence and the 81-input source manifest are in `.nightshift/deployment/library-20260919-061014/`, excluded from build uploads. The deployed artifact is this frozen snapshot; subsequent working-tree edits are not included. No commit or push was performed by this deployment task.

## Operations

This session used `/private/tmp/google-cloud-sdk/bin/gcloud` with `CLOUDSDK_CONFIG=/private/tmp/codex-gcloud-config`. Those temporary paths may disappear; use an authenticated SDK for later maintenance.

To stop idle warm compute while keeping on-demand access:

```sh
gcloud run services update nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --min=0 --cpu-throttling
```

Background solving between requests is unreliable in that configuration. Restore the tested demo settings with:

```sh
gcloud run services update nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --cpu=4 --memory=4Gi --min=1 --max=1 --max-instances=1 --concurrency=20 --no-cpu-throttling --update-env-vars=NIGHTSHIFT_SOLVER_THREADS=4
```

Operational rollback to the previous planning release (without the dataset-library UI):

```sh
gcloud run services update-traffic nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --to-revisions=nightshift-planning-v7=100
```

The older `nightshift-00007-map` release lacks the new workflows and has obsolete closure/scoring rules. Preserve the state bucket during rollback. To stop all application compute, manually delete the Cloud Run service; retained bucket/image storage still has storage costs. No automatic shutdown is scheduled, so idle compute charges continue while the instance is warm.
