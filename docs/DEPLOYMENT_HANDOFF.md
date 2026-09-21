# RailPlan deployment handoff — 19 September 2026

Live: https://nightshift-717753975344.us-central1.run.app

- Project / region: `qwiklabs-gcp-00-71d4c677d0cc` / `us-central1`
- Service / serving revision: `nightshift` / `nightshift-planning-v7`, 100% traffic, no temporary tags
- Runtime: **4 vCPU, 4 solver threads, 4 GiB**, one warm instance, maximum one, concurrency 20, port 8080, CPU always allocated
- Budgets: 90-second standard solves and previews, 300-second Improve, 90 seconds shared by five recovery options; one concurrent job and four admitted jobs
- Image: `us-central1-docker.pkg.dev/qwiklabs-gcp-00-71d4c677d0cc/nightshift/nightshift@sha256:6364cce74e21ec3c532d71eb854fca0ded85a6c5fb269810523b607c88d577b5`
- Cloud Build: `0ef8fe66-2dbd-49fc-91b3-d5da2546c477`
- Runtime identity: `nightshift-run@qwiklabs-gcp-00-71d4c677d0cc.iam.gserviceaccount.com`
- Private durable state: `qwiklabs-gcp-00-71d4c677d0cc-nightshift-state`; attached credentials, no downloadable keys
- Vertex: `gemini-3.8-flash`, global endpoint, attached identity; visible evidence fallback on provider failure

## Delivered

Integrated the remote upload frontend from `edaea99`, preserving the new visual structure. ZIP/eight-CSV uploads select the new instance and solve without approving it. Approved plans restore on reload. Contractor requests, asynchronous assessment, counteroffers, atomic acceptance and inherited booking guarantees are durable. Five recovery policies have real constraints/objectives, progressive results, explicit adoption and 300-second improvement. Chat previews use the same review/adoption flow. Reports exports exactly the three required CSVs. Formatted document reports remain deferred; Linux `fcntl` is retained.

## Evidence and limits

243 Python tests, frontend build and adapter/render/upload-state checks passed. Corrected local scores are A **137.9**, B **30**, C **62.7**, all with complete workload coverage. Four-thread hosted solves took **11.84 / 9.03 / 12.60 seconds** in the sampled run. The 108-activity C dataset reached OPTIMAL at **125.4 in 30.90 seconds**. Six hosted large/infeasible checks passed.

Hosted APIs and browser checks covered uploads, solving, Vertex evidence, adoption/reload, exports, requests, five-policy comparisons, improvement and chat previews. Saved versions and approvals survived replacement. Recovery was verified with an explicitly **simulated expired checkpoint across a real revision replacement**, five concurrent pollers, preserved completed children/budgets and rejected stale writes. Attempts to interrupt live jobs drained before removal and are not counted as forced-interruption evidence.

The bucket rejects anonymous reads. A 500-entry log review found no server errors or detected credential/CSV-content patterns. No browser errors were observed. Local checking remains distinct from official judging acceptance. The temporary lab project's lifetime is unverified; the URL is not guaranteed through judging.

Full records: [deployment.json](deployment.json), [Cloud Run log](CLOUD_RUN.md), [API contract](BACKEND_CONTRACT.md). Detailed session evidence is in `.nightshift/deployment/`, excluded from build uploads. All application-source hashes are recorded in `planning-build-manifest.json`. Working-tree code changes have not been committed by this deployment task.

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

Operational rollback to the prior revision of the same corrected image:

```sh
gcloud run services update-traffic nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --to-revisions=nightshift-planning-v6=100
```

The older `nightshift-00007-map` release lacks the new workflows and has obsolete closure/scoring rules. Preserve the state bucket during rollback. To stop all application compute, manually delete the Cloud Run service; retained bucket/image storage still has storage costs. No automatic shutdown is scheduled, so idle compute charges continue while the instance is warm.
