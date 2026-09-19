# Nightshift on Google Cloud Run

The temporary public demo uses project `qwiklabs-gcp-00-71d4c677d0cc`, region `us-central1`. Its Qwiklabs lifetime is not guaranteed through judging. No automatic shutdown is scheduled.

## Resources

- Cloud Run service: `nightshift`
- Artifact Registry repository: `nightshift`
- Runtime service account: `nightshift-run@qwiklabs-gcp-00-71d4c677d0cc.iam.gserviceaccount.com`
- Private state bucket: `qwiklabs-gcp-00-71d4c677d0cc-nightshift-state`
- Runtime: 2 vCPU, 4 GiB, one warm instance, service maximum one, concurrency 20, port 8080, instance-based billing.
- Solver: two threads, one simultaneous solve, four admitted jobs, default 90 seconds per solve and maximum 300 seconds with Improve.
- Chat: Vertex AI / Gemini 3.8 Flash, using the global Vertex endpoint and the attached runtime identity. No API key is deployed.

Cloud Storage is authoritative when `NIGHTSHIFT_GCS_BUCKET` is set. Uploads and completed runs are acknowledged only after durable writes. Every running job has a 60-second ownership lease, renewed every 10 seconds with conditional object-generation writes. Lost ownership cancels the search; stale workers cannot overwrite a new owner. Polling an abandoned run recovers its last checked incumbent after the lease expires. Local development continues to use files.

The runtime identity has object access only to the private state bucket. Its project-level custom role, `nightshiftVertexPredictor`, grants only `aiplatform.endpoints.predict` for model inference. Public access applies to the application, not the bucket. No service-account key files are created. Run IDs are capability-style identifiers; this demo has no per-user accounts and is intended for non-sensitive data.

## Vertex AI

The runtime uses `NIGHTSHIFT_CHAT_PROVIDER=vertex`, `VERTEX_PROJECT=qwiklabs-gcp-00-71d4c677d0cc`, `VERTEX_LOCATION=global`, and `VERTEX_MODEL=gemini-3.8-flash`. The Vertex AI API is enabled. Application Default Credentials acquire and refresh short-lived tokens from the attached service account. The Cloud Run service remains in `us-central1`; the model endpoint is global.

Gemini selects a scheduling tool from the question and known contract/activity IDs. The application computes the answer from checked evidence. Only explicitly parsed changes may start previews, and adoption still requires the user's action. Authentication failures, quota exhaustion and unusable model output return deterministic evidence with a visible notice. The model does not receive the uploaded CSV contents. Model inference is billable under the project's Vertex usage in addition to the warm Cloud Run instance.

Set `NIGHTSHIFT_CHAT_PROVIDER=evidence` through a new Cloud Run revision to disable model calls while retaining the planner. An optional `GEMINI_API_KEY` path remains for local development. Provider configuration is exposed by `/api/health`; successful model-assisted replies identify `mode: "vertex"`, so a configured-but-failing provider cannot pass the hosted check.

## Deployment

The session uses the SDK at `/private/tmp/google-cloud-sdk/bin/gcloud` with `CLOUDSDK_CONFIG=/private/tmp/codex-gcloud-config`. These temporary paths may disappear after restart; use an accessible authenticated SDK for later maintenance.

The `.gcloudignore` allowlist sends only 48 build inputs (about 888 KiB before compression), including public PS1 data and checked output fixtures. Local credentials, uploaded demand books and unrelated datasets are excluded. Cloud Build builds the multi-stage Dockerfile; deployment uses its immutable image digest. Runtime ADC credentials come from the attached service account.

Before an update, let current jobs finish when possible. Keep the previous working image digest for rollback. Conditional run ownership also guards replacement-instance recovery. Rollbacks must not delete the state bucket.

## Manual controls

These commands are documented for the owner; they are not scheduled or run automatically.

To stop paying for an idle warm instance while retaining an on-demand service:

```sh
gcloud run services update nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --min=0 --cpu-throttling
```

That configuration is unsuitable for dependable background solves between requests. Restore the tested configuration before a demo:

```sh
gcloud run services update nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --min=1 --max=1 --no-cpu-throttling
```

To stop the application completely, delete the Cloud Run service through the console or `gcloud run services delete nightshift` with the same project and region. Retaining the bucket and image repository preserves saved results but continues storage charges. Do not delete them unless those results are no longer needed.

## Verification

The local suite passes 212 tests. The production frontend build, Worker compatibility typecheck and combined API/static routing pass. The GCS regression tests cover durable reads, storage outages, competing claims, lease renewal/expiry and rejection of stale updates. Hosted private checks passed for all three scenarios: A=25.2, B=30, C=25.2, each optimal in the local model with 100% workload coverage. ZIP upload, exact three-file exports, C006/A036 evidence and a hard-closure preview with an unchanged baseline all passed. The organiser's validator remains unavailable.


## Release identifiers

- Service URL: `https://nightshift-717753975344.us-central1.run.app` (public access verified).
- Image digest: `sha256:b9d9ef57e2525e22d57b6b12be3aa175e02b0a93c94c74d0ea0bcf36ed378dd1`.
- Image repository: `us-central1-docker.pkg.dev/qwiklabs-gcp-00-71d4c677d0cc/nightshift/nightshift`.
- Successful Cloud Build: `0fb9bf76-634c-401a-806b-e6731532fc88` in `us-central1`.
- First verified revision: `nightshift-00001-t4b`.
- Current serving revision: `nightshift-00007-map` (100% of public traffic).
- Private smoke report: `.nightshift/deployment/verification.json`.
- Reusable verification tools: `scripts/verify_hosted.py`, `scripts/verify_recovery.py`.

The state bucket rejects anonymous reads (HTTP 403). The initial private service also rejected anonymous access. The first 78 application/log entries contained no 5xx responses and no detected bearer tokens, private keys, credential values or uploaded CSV headers. This is a bounded log inspection, not a comprehensive security audit.


## Hosted recovery and public release

The service was replaced with revision `nightshift-00002-srz`, using the same immutable image and `NIGHTSHIFT_RELEASE=recovery-verified-v1`. A completed schedule and its uploaded demand book survived the real revision replacement unchanged. A deliberately staged running checkpoint with an expired lease recovered to a checked 25.2 schedule when five concurrent requests polled it. This tests a **simulated interruption across a real revision replacement**; it does not claim that a live solver process was forcibly killed. Recovery details are saved in `.nightshift/deployment/recovery.json`.

Public invocation is granted through `allUsers` / `roles/run.invoker` on the service. Anonymous root, health and demo requests succeeded. Bucket permissions remain private. One warm instance remains configured, with no automatic shutdown.


## Public browser acceptance

The public URL was verified without sign-in. In the browser, a fresh PS1 ZIP upload completed, Scenario A solved to 25.2 with 100% workload coverage, and the controller returned the C006/A036 explanation. An on-time B preview retained A until explicit adoption, showed two changed activities and a +4.8 score difference, then adopted to 30 points, zero overrun and six ECLO accesses. The Export schedule button produced a download event. The hosted API checks separately verified the exact CSV contents. Browser console inspection returned no errors or warnings.

Deployment acceptance is complete. The warm instance remains running as requested.

## Vertex release verification — 18 September 2026

The initial Vertex build `dab83326-39a6-4849-9212-bcd1babe6a10` produced revision `nightshift-00003-lah`. The candidate revision was first deployed with zero main-URL traffic and a temporary `vertex-check` tag. Real calls from its attached runtime identity passed capacity routing, C006/A036 explanations, handover summaries and a B preview. Successful replies reported `mode: "vertex"`; no API key or impersonation grant was used. The preview completed at score 30 with 100% coverage, left the A baseline unchanged and exported exactly the three required CSVs. Incomplete change requests asked for clarification. Existing completed A/B/C versions survived with scores 25.2 / 30 / 25.2.

One initial model request returned the visible evidence fallback after approximately 15 seconds. The subsequent full check passed; ordinary successful chat requests in the sampled logs took roughly 1–6 seconds. The provider has a 15-second HTTP timeout, and the demo deliberately remains usable when a model request fails.

After promotion, the temporary tag was removed. Anonymous health checks identify Vertex / `gemini-3.8-flash`, and the public browser displayed the Vertex badge and answered a natural-language capacity question with inspectable evidence. Browser console checks found no errors or warnings. The state bucket still rejects anonymous access with HTTP 403. Service settings remain 2 vCPU, 4 GiB, concurrency 20, min/max one instance and CPU allocated outside requests.

The 190-test suite includes 22 new checks for Vertex global/regional endpoints, bearer authentication, credential refresh, malformed responses, provider failures and model attempts to replace explicit preview inputs. The production frontend build passes. Reproduce the hosted model checks with `NIGHTSHIFT_VERIFY_URL=https://nightshift-717753975344.us-central1.run.app uv run python scripts/verify_vertex.py` after the original hosted verification has saved run IDs. Its report is `.nightshift/deployment/vertex-verification.json`; the post-promotion check is `.nightshift/deployment/public-vertex.json`.

To roll back to the previous evidence-only release while preserving saved state:

```sh
gcloud run services update-traffic nightshift --project=qwiklabs-gcp-00-71d4c677d0cc --region=us-central1 --to-revisions=nightshift-00002-srz=100
```

The evidence-only image digest is `sha256:03fcfec740630b5f13c6df437ecb75550269aa06c628245ba760aa0fc7a80ddc`. The machine-readable record in `docs/deployment.json` retains its build/revision identifiers as well. A bounded inspection of 83 entries from the Vertex revision found no server-error responses or detected bearer tokens, private keys, API-key values or uploaded CSV-header patterns; details are in `.nightshift/deployment/vertex-log-check.json`.


## Dataset tests and checkpoint-read repair — 18 September 2026

Ten additional test demand books are in `testdata/`, with reproducible ZIPs, independent score expectations and a complete result matrix in `testdata/TEST_RESULTS.md`. All 30 local and 30 hosted scenario checks passed; the deliberately impossible case returned no schedule and blocked exports. The 108-activity C case achieved its optimal primary score of 50.4 at the 60-second limit, and reached full combined-objective OPTIMAL status in a later 93.98-second run.

That longer check exposed an intermittent 404 when a GCS checkpoint generation was overwritten after metadata lookup but before download. The fixed reader retries a missing old generation; only a fresh metadata lookup may establish that a run is absent. Repeated churn becomes an explicit storage error. The defect was reproduced against the real bucket and covered by four regression cases. All 212 tests passed.

Cloud Build `d1328cb7-15b9-4f78-8106-aebe25d6837b` built the repair. Revision `nightshift-00005-xil` first received zero main-URL traffic; its tagged candidate completed a fresh 108-activity C solve with uninterrupted polling in 53.70 solver seconds, score/bound 50.4, full coverage, OPTIMAL status and a valid three-CSV export. The difference from the earlier runtime is an observation, not a demonstrated performance improvement. The candidate was promoted to 100% of public traffic and the temporary tag removed. Runtime sizing, Vertex configuration, bucket and public URL remain unchanged.

The previous Vertex-enabled revision is `nightshift-00003-lah`, with image digest `sha256:bcb37a2d3831e9b6a7b283b18f2053e9af976f27c11db119cd205d018e330950`. It remains available for rollback, but contains the checkpoint-read race. Input fixtures and test reports are excluded by the build-upload allowlist.


## 90-second default — 18 September 2026

Standard solves and all previews now default to 90 seconds in the frontend, API and command-line solver. Improve retains its 300-second limit. The 38 API tests and production frontend build passed. The candidate revision accepted a request without an explicit budget as 90 seconds, solved public Scenario B to an optimal score of 30 with 100% coverage, and exported exactly the three required CSVs. Its frontend matched the locally verified build.

Revision `nightshift-00007-map` now serves all public traffic. Anonymous checks confirmed the 90-second API default and updated frontend; completed schedules survived the replacement. Vertex, instance sizing and storage settings remain unchanged. Verification is recorded in `.nightshift/deployment/budget90-verification.json`. The previous revision `nightshift-00005-xil` remains available for rollback.
