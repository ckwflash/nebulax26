# RailPlan — frontend ⇄ backend contract

**Audience:** whoever is extending `trackaccess/api.py`.
**Status of the frontend:** built and passing against generated payloads; it has never
spoken to a live server. Everything in §2 is what it *already calls*, inferred from the
Python source. If a field name here is wrong, the frontend is wrong too — fix both.

The frontend is `src/` (Vite + React + TS). It holds **no** bundled plan data: every
number on screen comes from this API. With the service down, the app renders an error
card and nothing else. That is deliberate.

---

## 0. What you actually need to do

1. ~~Fix the Windows import blocker (§3).~~ Done.
2. ~~Build the three endpoint groups (§4).~~ Done: requests, reports and recoveries, all wired into their tabs.
3. **Optional, 5 minutes:** add a `contractor` column (§5).

Everything else already works.

---

## 1. How the frontend consumes the API

Requests go to relative paths (`/api/...`). In development Vite proxies `/api` to
`http://127.0.0.1:8000` (`vite.config.ts`); in the container both are served from the
same origin, so no CORS and no base-URL configuration.

**Load sequence on first paint** — `src/state/plan.tsx`:

```
GET /api/demo  ->  { instance, run }
```

That single call must return a *solved* run. The frontend then derives its whole view
model from `instance` + `run.schedule` + `run.validation` (`src/data/adapt.ts`).

**Long operations are polled, never held open:**

```
POST /api/runs        -> 202, run with status "queued"
GET  /api/runs/{id}   -> poll every ~900 ms until status leaves queued/running
```

**Error handling:** any non-2xx is read as `{"detail": "..."}` and shown verbatim to the
user. Keep `detail` human-readable — it is surfaced in the UI, not just logged. A network
failure (service down) is reported separately as "not reachable".

---

## 2. Existing endpoints — do not break these

| Method | Path | Used by |
|---|---|---|
| GET | `/api/health` | startup probe |
| GET | `/api/demo` | initial load, every tab |
| POST | `/api/instances` | "Load demand book" dialog |
| GET | `/api/instances/{id}` | reload |
| POST | `/api/runs` | scenario switch, Scenarios, Disruption |
| GET | `/api/runs/{id}` | polling |
| GET | `/api/runs/{id}/export` | Reports download |
| POST | `/api/chat` | Ask tab |

TypeScript mirrors of every shape live in `src/api/types.ts`. Below are only the fields
the UI actually reads — adding fields is safe, renaming or removing these is not.

### 2.1 `GET /api/demo` → `{ instance, run }`

`instance` is `Instance.summary()`:

```jsonc
{
  "id": "4614ef3b6b98b084",        // 16 hex chars; POST /api/runs validates this pattern
  "name": "NebulaX · public demand book",
  "horizon_start": "2027-01-04",   // ISO date, Monday; week N ends start + 7N - 1 days
  "horizon_weeks": 30,
  "total_workload": 0,
  "projects":   [ProjectRow],      // 07_PROJECT_DETAILS.csv, one per contract
  "activities": [ActivityRow],     // 08_ACTIVITY_DETAILS.csv + route/protected/start_week
  "locations":  [{ "id": "SEC:ALP:S01_S02:EB", "capacity": 4 }],
  "lines":      [{ "line_code": "ALP", "line_name": "Line Alpha" }],
  "stations":   [...],
  "bounds":     { "A": 25.2, "B": 30, "minimum_b_eclo": 6, "details": [...], "note": "..." }
}
```

`ActivityRow` — the three computed fields matter as much as the CSV ones:

```jsonc
{
  "activity_id": "A001", "contract_number": "C001", "activity_type": "Renewal",
  "start_location_id": "SEC:BET:S15_S16:EB", "end_location_id": "SEC:BET:S16_S17:EB",
  "total_accesses": 2, "planned_start_date": "2027-05-24",
  "predecessor_activity_id": "", "activity_priority": 2,

  "route":      ["SEC:...", "PLAT:..."],  // every location the work occupies
  "protected":  ["SEC:...", ...],         // route + buffers, mirrored bound, interchange spill
  "start_week": 21                        // first permitted week, clamped to >= 1
}
```

The frontend parses `location_id` as `KIND:LINE:BODY:BOUND`, where `KIND` is `SEC` or
`PLAT` and a sector body is `FROM_TO`. **Keep that format** — labels, line/bound filters
and the heatmap all depend on it.

`run`:

```jsonc
{
  "id": "public-A-4614ef3b6b98b084",
  "instance_id": "4614ef3b6b98b084",
  "scenario": "A",                     // "A" | "B" | "C"
  "status": "completed",               // queued | running | completed | failed | no_solution
  "label": "Public A",
  "overrides": [], "baseline_id": null,
  "schedule":   { scenario, access[], occupancy[], results[], witness{} },
  "validation": { ...see 2.2... },
  "solver_status": "OPTIMAL",
  "elapsed_seconds": 2.76,
  "model_bound": 25.2,
  "message": "...", "error": "...",    // optional
  "diff": { changed_activities[], added_accesses, removed_accesses, score_delta }  // when baseline_id was set
}
```

`schedule.witness` maps `"<activity>:<week>" -> slot` (1-based). The Schedule tab's
night-detail zoom is built entirely from it; without it that zoom is empty.

### 2.2 `validation` — the single richest object

The UI reads, and would visibly degrade without:

- `feasible`, `structurally_valid`, `safety_verified`, `hard_violations[]`, `rule_version`
- `score`, `coverage_percent`, `completed_activities`, `total_activities`
- `soft_scores`: `priority_weighted_score`, `overrun_days_total`, `contracts_overrunning`,
  `excess_access_nights_total`, `eclo_nights_total` (plus optional `earliness_days_total`,
  `objective_score`, `formula_version`)
- `contracts[]`: `{contract_number, completion_week, simulated_completion_date,
  planned_completion_date, overrun_days, priority, evidence_id}`
- **`capacity[]`**: `{location_id, week, used, capacity, excess, evidence_id}`

`capacity[]` deserves a warning: it is load-bearing far beyond the capacity display. Every
utilisation figure, the Risk heatmap, the "alternative weeks" calculation and therefore the
fragility score all read it. If it ever becomes sparse or omits zero-usage rows, say so —
the frontend currently treats a missing row as "location free that week".

### 2.3 `POST /api/runs` → 202

```jsonc
{
  "instance_id": "<16 hex>",     // required, pattern-checked
  "scenario": "A" | "B" | "C",   // required
  "seconds": 90,                 // 1..300
  "baseline_id": "<run id>",     // warm start + produces run.diff
  "overrides": [ { "location_id": "SEC:ALP:S01_S02:EB", "week": 12, "capacity": 2, "closed": false } ],
  "label": "What-if"
}
```

Rejections the UI surfaces as-is: **422** unknown location or week past the horizon,
**422** baseline belongs to another instance, **429** four runs already active.

Overrides are how the frontend expresses *every* what-if. Scenarios builds them from
"capacity reduction / closure / extra night"; Disruption builds them from a closure over a
week range. `closed: true` forbids work *and protection* at that location-week;
`capacity: n` re-sets nominal supply.

### 2.4 `GET /api/runs/{id}/export`

Returns the three-CSV zip. **It 409s unless `validation.feasible` is true**, and `feasible`
requires `safety_verified`, which requires a timing witness. The Reports tab links straight
to this URL, so an infeasible run gives the user a raw 409 page. If you would rather it
degrade gracefully, tell me and I will gate the button on `feasible`.

### 2.5 `POST /api/chat`

```jsonc
// request
{ "instance_id": "<16 hex>", "run_id": "<run id>", "message": "Why is C006 late?" }

// response
{ "answer": "...", "mode": "explain", "notice": null, "run_id": "...", "tool": "...",
  "evidence": [ { "id": "contract:C006", "title": "C006 · completion",
                  "detail": "2027-07-11 · 14 days late", "contract_number": "C006" } ] }
```

The Ask tab renders `answer`, `notice` and `evidence[].title` / `.detail`. It ignores
`preview` today — if you want scenario previews wired into the UI, that is a small change.

### 2.6 `POST /api/instances`

Multipart, field name `files`: either the eight instance CSVs (`01_LINES.csv` …
`08_ACTIVITY_DETAILS.csv`) or a single ZIP containing them, 5 MB total. Returns
`Instance.summary()` (same shape as `instance` in 2.1). The frontend then calls
`POST /api/runs` for the chosen scenario and rebinds every tab to the new instance and run.

The upload dialog checks names, count and size before sending, mirroring the server's
rules, so a `422` here should only come from content problems (bad CSV, bad ZIP, missing
file inside a ZIP). **Keep `detail` readable**: the dialog shows it verbatim.

An infeasible book uploads fine (200) and its run ends `status: "no_solution"` with a
readable `message`. The dialog shows that message and keeps the current plan. Scenario
switches treat `no_solution` the same way. The last uploaded instance and run IDs are kept
in `localStorage`, and on reload the app restores them via `GET /api/instances/{id}` and
`GET /api/runs/{id}`, so both must keep working for stored IDs.

---

## 3. Blocking: the service will not start on Windows

> **Status:** the guard below is now applied in `trackaccess/store.py`, and the service
> starts on Windows.

```
File "trackaccess\store.py", line 3, in <module>
    import fcntl
ModuleNotFoundError: No module named 'fcntl'
```

`fcntl` is POSIX-only and is imported unconditionally. `domain.py`, `solver.py` and
`validation.py` are clean — it is only the local-file lease path in `store.py`. Suggested
shape:

```python
try:
    import fcntl
except ModuleNotFoundError:      # Windows dev box; the local lease is POSIX-only
    fcntl = None
```

then guard the two lock/unlock calls with `if fcntl is not None:`. On Windows you lose
cross-process file locking, which does not matter for a single local dev server; on Linux
and Cloud Run nothing changes.

Unrelated but worth knowing: a fresh `.venv` was missing `google-auth` and
`google-cloud-storage` until `uv sync --extra test` was run. Teammates will hit it.

---

## 4. Endpoints added for the Requests, Reports and Disruption tabs

Conventions for all three: JSON in and out, `{"detail": "..."}` on error, no auth (the app
is single-tenant today).

### 4.1 Contractor requests — Requests tab ✅ built

Implemented in `trackaccess/access_requests.py` (pricing logic) and `api.py` (routes);
test `test_contractor_request_assessment`.

**Model.** Granting a contractor an extra possession at location L in weeks [from, to]
takes one unit of L's capacity from everyone else. So an assessment is a what-if with
L's capacity reduced by 1 in those weeks, warm-started from the approved run. The two
nearest same-length windows where L still has room in every week are solved the same
way as counter-offers. Assessment is **asynchronous** (open question 2): it queues up to
three runs and is polled like a run.

```
POST  /api/requests          { instance_id, contract_number, contractor, request,
                               location_id, week_from, week_to, reason }   -> 201 request
GET   /api/requests?instance_id=<16 hex>                                   -> [request]
PATCH /api/requests/{id}     { "status": "pending"|"accepted"|"rejected"|"countered" }
POST  /api/requests/{id}/assess   { baseline_id, seconds }  -> 202 { id, runs[] }
GET   /api/requests/{id}/assessment
  -> { "status": "running", "done": 1, "total": 3 }
  -> { "status": "completed", location_id, capacity_before, capacity_after,   // worst-week %
       tiles[], displaced[], options[], draft_response }                   // shapes as sketched originally
```

`impact` per option comes from the official score delta and the number of moved
activities: BENEFICIAL (score improves), NONE (nothing moves), LOW (< 5 points), MEDIUM
(< 20), HIGH (≥ 20, infeasible, or no schedule). Requests persist as `requests/{id}`, plus a
per-book index `requests/index-{instance_id}`. Recording a decision does not change the
approved plan.

### 4.2 Reports — Reports tab ✅ built

Implemented in `trackaccess/reports.py`, routes in `api.py`, test `test_document_pack`.
Four reports, each a self-contained printable HTML page (Print → Save as PDF gives
the paper copy), rendered on demand from the run's `validation` and `schedule`:
`management-summary`, `risk-resilience`, `contractor-access-pack`, `delay-eclo-register`.

```
GET  /api/reports
-> [ { "id", "name", "audience", "description", "size_hint",
       "format": "HTML", "generated_at": null } ]

POST /api/reports/{id}/generate   { "run_id": "<run id>" }
-> { "download_url": "/api/reports/{id}/download?run=<run id>", "generated_at": "..." }
   404 unknown report or run · 409 run has no completed schedule

GET  /api/reports/{id}/download?run=<run id>   -> text/html
```

Nothing is stored: rendering is deterministic and cheap, so `generate` checks the report
renders and the download renders it again. An infeasible run still renders, with a
"must not be issued" banner. The Risk report deliberately does not compute fragility
(§6); it reports capacity pressure and no-slack contracts from `validation`.

### 4.3 Disruption recoveries ✅ built — weighted objective, option (b)

`solve()` takes optional `weights = {churn, deadlines, passengers, priority1}`, 0–10 each,
where 5 reproduces the official objective. They scale the existing penalty terms:
overrun (`weight10 * late`) by `deadlines`; ECLO (`50 * e`) and excess (`70 * over`) by
`passengers`; a moved access-week relative to the baseline (`CHURN_PRICE`) by `churn`; and
Priority-1 overrun and churn additionally by `priority1`. **Weights steer the search only.**
Every result is scored by `validate()` with the official formula, so options compare like
for like. `model_bound` is `null` on weighted runs because the bound is not in score units.

| Philosophy | churn | deadlines | passengers | priority1 |
|---|---|---|---|---|
| churn | 10 | 2 | 3 | 5 |
| deadlines | 1 | 10 | 2 | 6 |
| passengers | 2 | 3 | 10 | 5 |
| p1 | 3 | 3 | 3 | 10 |
| custom | caller's weights | | | |

```
POST /api/disruptions/recoveries
{ instance_id, scenario, baseline_id, overrides[1..100], weights, philosophies[], seconds (default 30) }
-> 202 { "id": "<batch id>", "runs": [ { "philosophy": "churn", "run_id": "..." } ] }

GET /api/disruptions/recoveries/{batch id}
-> { "status": "running"|"completed", "results": [ { "philosophy", "run": <full run> } ] }
```

The pool is still `max_workers=1`, so the runs solve serially. A batch may queue up to 8
active runs (single runs are still capped at 4). Measured on the public book, Scenario C
with BET H01–H02 EB closed for weeks 10–12, 30 s each (all OPTIMAL, 54 s for five):

| | score | moved | overrun days | ECLO |
|---|---|---|---|---|
| approved plan | 25.2 | — | 21 | 0 |
| churn | 35.2 | 3 | 21 | 2 |
| deadlines | 29.1 | 6 | 7 | 4 |
| passengers | 25.2 | 4 | 21 | 0 |
| custom (6/7/5/8) | 26.1 | 5 | 14 | 2 |

In Scenario A (no ECLO, no excess) the philosophies often coincide; the UI says so.
The Disruption tab can **adopt** a feasible recovery. This is frontend-only: the run becomes
the displayed plan and is remembered across reloads.

---

## 5. Optional data addition

`07_PROJECT_DETAILS.csv` has no contractor name, so the UI falls back to
`contract_description` everywhere a contractor should appear. Add a `contractor` column and
surface it as `ProjectRow.contractor` — the frontend already reads it if present
(`src/api/types.ts`) and needs no change.

---

## 6. What the frontend computes for itself

Do **not** build these server-side; they already exist in `src/data/adapt.ts` and would
only drift:

- **Fragility 0–100** and its five drivers, from contract slack, alternative weeks, route
  utilisation, ECLO nights and co-share/precedence links.
- **Alternative weeks** — weeks where every location on an activity's route has
  `used < capacity` and precedence allows.
- **Co-sharing groups** — inverted from `occupancy` on `(location, week, co_share_group)`.
- **Operational confidence**, location labels, week↔date arithmetic, the downstream-impact
  chain.

If you ever want these to be authoritative rather than presentational, that is a real
conversation — but then they should move wholesale, not be duplicated.

---

## 7. Smoke tests

With the service on `127.0.0.1:8000`:

```bash
curl -s localhost:8000/api/health | jq .
curl -s localhost:8000/api/demo   | jq '{acts: (.instance.activities|length),
                                         locs: (.instance.locations|length),
                                         weeks: .instance.horizon_weeks,
                                         status: .run.status,
                                         score: .run.validation.score,
                                         cap: (.run.validation.capacity|length)}'
```

Expected on the public demand book: 54 activities, 76 locations, 30 weeks, a completed run,
and a non-empty `capacity` array. If `capacity` is empty the Risk tab and every fragility
score collapse to zero — that is the first thing to check if the UI looks wrong.

Then, with `npm run dev` alongside, open `http://127.0.0.1:5173`. Success looks like the
Home tab showing real contract ids (C001–C014) and a scenario crumb naming A, B or C.
Failure looks like a red "The plan could not be loaded" card, which names the reason.

---

## 8. Open questions — resolved

1. Export on an infeasible run: the Reports tab disables the button and says why.
2. Request assessments: asynchronous, polled like runs (§4.1).
3. Recoveries: weighted objective, option (b) (§4.3).
4. `/api/chat`'s `preview` driving a scenario preview in the Ask tab: still open.
