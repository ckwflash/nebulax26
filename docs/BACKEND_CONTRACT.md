# RailPlan frontend and backend contract

Implemented contract, September 2026. Wire types live in `src/api/types.ts`, the client in
`src/api/client.ts`, and shared state in `src/state/plan.tsx`. Relative `/api` paths use
the Vite proxy locally and the same origin in the Linux Cloud Run container. `fcntl`
provides local cross-process locking on POSIX. The Windows import fallback supports
single-process development only; production uses Linux and generation-checked GCS storage.

## Upload developer handoff

The teammate’s upload UI from remote commit `edaea99` is integrated in `src/shell/UploadDialog.tsx`. It accepts one ZIP or eight CSVs, checks the selection, uploads, selects the returned instance, then immediately queues A, B and C as one durable job, with a separate 90-second maximum for each scenario. Results appear progressively, and every result still needs explicit adoption. The shared handoff API remains:

```ts
// Recommended: upload, select, queue all three and start progressive polling.
const { loadDemandBook } = usePlanState(); // inside PlanProvider
await loadDemandBook(files, "Optional dataset name");

// For a custom uploader, the selection handoff remains available:
const { selectInstance } = usePlanState();
const body = new FormData();
for (const file of files) body.append("files", file);
const response = await fetch("/api/instances", { method: "POST", body });
// Do not set Content-Type: the browser supplies the multipart boundary.
if (!response.ok) throw new Error((await response.json()).detail);
const instance: InstanceSummary = await response.json();
await selectInstance(instance.id);
// Then POST /api/instances/{id}/solve-all and poll history (see below).
```

`POST /api/instances` accepts one ZIP containing the eight official CSVs, or eight CSV
parts named `files`, plus an optional `name` form field (maximum 120 characters). It returns HTTP 200 and `InstanceSummary`, not a run. ZIP subfolders
are allowed; unrelated archive members are ignored. Recognized duplicate files, missing
files, unexpected standalone filenames, malformed CSV/ZIP/UTF-8, broken references,
invalid dates/routes/priorities and invalid input quantities return 422 with a readable
`{"detail":"…"}`. Total compressed input and recognized expanded CSVs are limited to
5 MB. The ID is a stable 16-character hexadecimal content identifier; uploading the
same data preserves its existing approved plan. New uploaded books remain unapproved.
Durable storage failure returns 503; uploads never silently fall back to local disk.

`selectInstance(id)` aborts obsolete polling, clears the displayed run and approval,
loads the instance, approved pointer and saved scenario history, and resets per-instance tab selections and
previews by remounting the tab contents. It remembers the selected ID for reload. A book
without any schedule renders an explicit Unsolved screen with A/B/C solve buttons. An unapproved book with saved results restores a preview; it does not approve that result.
Place the upload control in the shared shell/provider so it remains reachable in that state.
An API load failure is shown in the shared error panel and rejects the handoff promise. `loadDemandBook(files, name?)` wraps upload, selection and an A/B/C batch submission for the dialog, then returns while progressive background polling continues; `backToSample()` restores the public book and its durable approval.

## Dataset library and automatic scenario solves

- `GET /api/instances` lists durable dataset metadata: `{id,name,created_at,updated_at,activities,contracts,horizon_weeks,total_workload}[]`. Legacy books are discovered from storage; unknown original timestamps are null. Identical file contents reuse their dataset ID and preserve saved plans/history. An explicit upload name renames that dataset; an unnamed repeat upload preserves its name.
- `POST /api/instances/{id}/solve-all` accepts `{client_request_id, seconds?:90}` and returns HTTP 202 with a durable parent `{id,instance_id,status,children:Run[]}`. `client_request_id` is an idempotency key. Three children are created immediately in A/B/C order. The batch consumes one admitted job, executes one solve at a time with four solver threads, and caps each child independently at 90 seconds (270 seconds maximum computation total). Shorter budgets of 1–90 seconds are accepted for API testing. Recovery's shared 90-second budget is unchanged. Leases, fencing and persisted child allocations handle replacement without repeating completed work.
- `GET /api/instances/{id}/history` returns `{instance_id,versions:SavedRun[],latest:Partial<Record<ScenarioId,Run>>}`. Versions contain ID, label, scenario, creation time, status, `has_schedule`, `feasible`, score and solver status. Latest includes full run objects; finished summaries are cached under the current rule version. Polling resumes abandoned jobs. Complete records are still independently revalidated on export/adoption. History includes standard solves, improvements, booking options and recovery children; labels identify their provenance.
- `GET /api/instances/{id}/source` downloads the original eight input CSVs in a ZIP. Each scenario's output is downloaded separately through `/api/runs/{run_id}/export`, containing exactly `SCHEDULE_ACCESS.csv`, `SCHEDULE_OCCUPANCY.csv` and `RESULTS.csv`. Filenames include the dataset, scenario and version. Queued, incomplete and infeasible results cannot be exported.

The shared provider exposes `history`, `refreshHistory()`, `solveAll()` and `loadSavedRun(id)`. Scenario switching reuses saved results. Dataset switching aborts obsolete polling; reopening a pending dataset resumes polling, and reopening a completed dataset requires no new solve. The Dataset library searches saved names/IDs and restores the approved plan first, or a saved preview when no plan is approved. This public demo's library is shared, for non-sensitive data.

## Existing data and endpoints

| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | Health and configured chat provider/model |
| GET | `/api/demo` | `{instance, run}`; checked public A reference, initializes approval only when absent |
| GET | `/api/instances/{id}` | `InstanceSummary` |
| POST | `/api/instances` | Multipart upload, as above |
| POST | `/api/runs` | 202, queued full run |
| GET | `/api/runs/{id}` | Full run, resumes abandoned work when polled |
| POST | `/api/runs/{id}/improve` | 202, new run; `{seconds:300}` default |
| GET | `/api/runs/{id}/export` | ZIP containing exactly three required CSVs |
| POST | `/api/chat` | Answer, evidence and optional full preview run |
| GET | `/api/reports` | Four printable HTML report templates |
| POST | `/api/reports/{id}/generate` | `{run_id}` → download URL and generation time |
| GET | `/api/reports/{id}/download?run={run_id}` | Printable HTML for a completed run |

Instance summaries preserve the existing project/activity CSV columns and public IDs.
Computed activity fields are `route[]`, `protected[]`, and `start_week`. Locations keep
`KIND:LINE:BODY:BOUND` IDs and standing `capacity`. The 30-week public book contains
54 activities and 76 locations. Contractor names are optional request metadata; public
CSV inputs are unchanged.

Run submission:

```json
{
  "instance_id": "4614ef3b6b98b084", "scenario": "A", "seconds": 90,
  "baseline_id": "public-A-4614ef3b6b98b084", "label": "Capacity preview",
  "overrides": [{"location_id":"SEC:ALP:S01_S02:EB","week":12,"capacity":2,"closed":false}]
}
```

Seconds range 1–300; ordinary UI solves and previews default to 90. Overrides inherit
from the comparison baseline; a new entry replaces its matching location/week.
`closed:true` prohibits work through the protection footprint as well as the route.
Accepted bookings always inherit into subsequent runs. The optional `bookings[]` shape
is `{request_id, activity_id, week_from, week_to}`. `philosophy` and `weights` are used by
recovery runs. Unknown instance/location/activity/week or foreign baselines return 422/404.
Four admitted jobs, including queued work and batches, are permitted; excess submissions
return 429. The single solver executor runs jobs serially.

Runs have `queued | running | completed | failed | no_solution` status. `schedule` and
`validation` may be null. `solver_status`, `elapsed_seconds`, and optimization metrics
may be absent until available; `model_bound` is nullable. A completed schedule may still
be an infeasible Scenario B diagnostic, so status alone never authorizes adoption or
export. Both require completed, full, independently validated feasibility and safety.
Error bodies use human-readable `detail`; asynchronous errors appear in `error`/`message`.

Schedule shape remains `{scenario, access[], occupancy[], results[], witness{}}`.
The witness maps `activity:week` to a synchronized opportunity. Validation preserves
`score`, `coverage_percent`, `hard_violations`, `safety_verified`, `contracts[]`,
`capacity[]`, `soft_scores`, rule version and local validation authority.

`capacity[]` is sparse. The adapter combines its usage with standing capacities and
per-run overrides across the entire horizon. Closure footprints are excluded from
suggested alternative weeks. Risk, fragility and confidence are frontend heuristics;
these suggestions are not solver-certified alternatives.

`diff` compares against the original `baseline_id`: changed activities include weeks or
ECLO changes; `score_delta` is null across scenarios. Compare both scenario scores and
operational metrics without ranking scores with different formulas.

Improve preserves scenario, original comparison baseline, overrides, bookings, policy
and weights, and starts from the selected option's checked incumbent. It does not
replace a better saved solution with a worse search result. An infeasible diagnostic
may be viewed, but cannot be adopted or exported. ZIP filenames remain exactly
`SCHEDULE_ACCESS.csv`, `SCHEDULE_OCCUPANCY.csv`, `RESULTS.csv`.

Chat input remains `{instance_id,run_id,message}`. Response includes `answer`, `evidence[]`,
`mode`, `notice`, `tool`, and `preview: Run | null`. The Ask tab polls that preview,
compares against the question's source run and offers explicit adoption. Chat does not
approve anything automatically.

## Durable approved plans

`GET /api/instances/{id}/plan` returns:

```json
{"instance_id":"4614ef3b6b98b084","approved_run_id":null,"revision":0,"commitments":[],"run":null}
```

`POST /api/instances/{id}/plan/adopt` takes
`{run_id, expected_approved_run_id, expected_revision}` and returns the same shape with
its full approved run. Both expectations are required; stale approval returns 409.
The candidate and all current booking guarantees are independently revalidated.
Booking options with unaccepted request commitments must be accepted through Requests.
Viewing, solving or improving another run never changes approval. Reload restores it.

One generation-checked `plans/{instance_id}` record holds the approved pointer,
revision, accepted commitments and all request decision state. This makes acceptance
atomic; a persistence failure cannot save only the pointer or only the commitment.
The runtime service account accesses the private bucket using attached credentials.

## Contractor requests

`POST /api/requests` returns 201. Required body:

```json
{"instance_id":"4614ef3b6b98b084","contract_number":"C001","activity_id":"A001",
 "location_id":"SEC:BET:S15_S16:EB","week_from":21,"week_to":22,
 "reason":"Programme coordination","contractor":"Optional name"}
```

Contract/activity ownership, route location and ordered in-horizon weeks are validated.
Reason is required (maximum 1000 characters). An optional `client_request_id` makes
creation retry-idempotent; reusing it with different details returns 409.
`GET /api/requests?instance_id=…` returns saved requests with IDs, status, assessment ID,
and optional counteroffer/accepted run IDs. Status is pending/countered/accepted/rejected.

`POST /api/requests/{id}/assessment` takes `{seconds:90}` and returns 202. It assesses
the requested window and up to two nearest nonoverlapping windows of equal length with
estimated headroom. Only completed solver-validated options have `feasible:true`.
All options share the single computation budget. Poll
`GET /api/requests/{id}/assessment` for progressive results:

- `id`, `status`, `baseline_id`, `plan_revision`, `stale`, `error`.
- `options[]`: kind REQUESTED/ALTERNATIVE, week range, run ID, full run, feasibility,
  before/after scores, impact and explanatory points.
- Requested-window capacity utilization, displaced activities and contract delay effects,
  summary tiles and a response draft. Null utilization means unavailable, not zero.
- Each full run also supplies actual activity accesses, ECLO, excess and capacity details.

Cache identity includes request details, baseline, revision, commitments, budget and
solver version. A changed approved baseline requires reassessment. Assessment guarantees
at least one access for the named activity somewhere in the window; it never invents
workload or increases nominal capacity.

`POST /api/requests/{id}/decision` takes
`{decision,run_id,expected_approved_run_id,expected_revision}`. Decision is:

- `accepted`: atomically save the booking and adopt its completed feasible option.
- `countered`: record a checked alternative; approval remains unchanged.
- `rejected`: update request status only; `run_id` may be null.

Response is `{request,plan}`. Stale decisions, unvalidated/foreign options and already
final decisions return 409. Improved assessment options retain their ancestry and can
be accepted using their new run IDs. Response drafts are displayed only; no messages
are sent.

## Recovery batches

`POST /api/disruptions/recoveries` takes instance ID, current scenario, feasible
`baseline_id`, nonempty disruption overrides, optional `weights` and optional unique
`philosophies`. Default policies:

| ID | Scenario | Guarantees and ordered objectives |
|---|---|---|
| churn | Current | Minimize changed activities, then normal scenario score |
| deadlines | B | Planned deadlines and completion no later than baseline; supply cost then churn |
| passengers | A | No ECLO or excess; weighted delay then churn |
| p1 | C | Freeze P1 baseline weeks and ECLO; C score then churn |
| custom | C | User-weighted preference objective, then churn |

Weights are integers 0–10, defaults `{churn:6,deadlines:7,passengers:5,priority1:8}`.
Custom minimizes `10*churn*changed_activities + deadlines*weighted_lateness_tenths +
50*passengers*ECLO_count + priority1*P1_weighted_lateness_tenths + 70*excess_location_nights`.
P1 refers to `activity_priority == 1`. The P1 term adds protection beyond general delay weighting. Preset objectives are
lexicographic: the previous optimum is fixed only after it is proven optimal.
`optimization.stages[]` reports preference values/bounds separately from the local
scenario score; `proven_optimal` covers all stages. Warm starts alone are not churn proof.

Response 202 and `GET /api/disruptions/recoveries/{id}` include `id`, status,
`baseline_id`, remaining budget, error, and `results[{philosophy,run}]` full child objects.
The initial response also has `runs[{philosophy,run_id}]`. The UI uses 90 seconds total,
initially 18 per child, carrying unused time forward. API budgets may be shortened for
verification. An impossible protected strategy remains unavailable; guarantees are
never silently relaxed. Any finished selected option can receive a 300-second Improve.

Batches count as one admitted job. Children live inside the leased batch record;
child polling only resumes the parent. Completed children are never repeated.
Allocated budget, checkpoints and progress persist together. An interrupted allocation
is conservatively charged for uncheckpointed elapsed time, rather than restarting its
budget. Queueing and persistence can extend end-to-end wall time beyond solve time.
The 60-second lease renews every 10 seconds; generation fencing rejects old-owner writes.

## Printable reports

The report catalogue contains `management-summary`, `risk-resilience`,
`contractor-access-pack`, and `delay-eclo-register`. The Reports tab generates a link
for the displayed completed run; browser Print → Save as PDF produces a paper copy.
The renderer and frontend document card were integrated from remote commit `367ca4e`.

Generation and download both independently revalidate the schedule with the current
closure/scoring rules and its booking commitments. They never solve or approve a run.
An infeasible completed diagnostic can be inspected as a report, with a prominent
"must not be issued" banner; its submission ZIP remains blocked. Unfinished runs and
batch containers return 409. Unknown report/run IDs return 404. Reports identify the
run and rule version, escape user-controlled labels, and distinguish local validation
from official judging acceptance. No PDF/XLSX binary generation service is implied.

## Validation and ownership limits

Run `uv run pytest`, `npm run build`, and `npm run check`. Frontend adapter/render/contract
assertion failures exit unsuccessfully. Browser smoke tests must include real API data,
approval/reload, requests, recoveries and chat previews. Upload API and shared state are
covered independently. The integrated remote upload UI passed a local browser upload,
solve, explicit adoption and reload check; hosted acceptance is recorded in the deployment log. Reports contains validated CSV downloads, a run summary, and printable document packs. Local validation is distinct from
unavailable official judging acceptance.

Recovery result entries include `policy: {label, scenario, guarantees[], objectives[]}` alongside the full `run` and `philosophy`. Objectives are in lexicographic order; an earlier stage is fixed only after optimality is proved. Checkpoint writes run outside the solver callback and drain before completion, so storage latency does not consume the computation allowance. Recovery conservatively charges the interrupted child’s elapsed allocation rather than resetting its budget.
