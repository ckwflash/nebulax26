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

1. **Fix the Windows import blocker** (§3). Until this is done nobody on a Windows
   machine can see the UI with data, including during the demo rehearsal.
2. **Build three endpoint groups** (§4): contractor requests, reports, disruption
   recoveries. The UI already has the tabs; they show "awaiting backend" panels naming
   these endpoints.
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
  "status": "completed",               // queued | running | completed | failed
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

---

## 3. Blocking: the service will not start on Windows

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

## 4. Endpoints to build

Conventions for all three: JSON in and out, `{"detail": "..."}` on error, no auth (the app
is single-tenant today).

### 4.1 Contractor requests — Requests tab

A request is a contractor asking for access the plan did not give them. It is economically
a capacity override, so its assessment is the same what-if the Scenarios tab already runs.

```
GET /api/requests
-> [ { "id": "REQ-001",
       "contract_number": "C006",
       "contractor": "Ballastco",
       "request": "Additional access night",
       "location_id": "SEC:ALP:S01_S02:EB",   // optional but strongly preferred
       "week_from": 15, "week_to": 15,
       "reason": "Programme acceleration",
       "status": "pending" | "accepted" | "rejected" | "countered",
       "received_at": "2026-09-18T09:40:00Z" } ]

GET /api/requests/{id}/assessment
-> { "location_id": "SEC:ALP:S01_S02:EB",
     "capacity_before": 92, "capacity_after": 108,      // percentages
     "tiles": [ { "label": "Activities displaced", "value": "3",
                  "tone": "crit"|"warn"|"ok", "note": "A005 and two C013 pre-works" } ],
     "displaced": [ { "activity_id": "A005", "contract_number": "C002",
                      "priority": 2, "effect": "C002 +3 days", "tone": "crit" } ],
     "options": [ { "kind": "REQUESTED"|"ALTERNATIVE",
                    "week_from": 15, "week_to": 15,
                    "impact": "HIGH"|"MEDIUM"|"LOW"|"NONE"|"BENEFICIAL",
                    "score_before": 47.3, "score_after": 61.2,
                    "points": [ { "tone": "ok"|"warn"|"bad", "text": "3 activities displaced" } ] } ],
     "draft_response": "Week 15 cannot be accommodated without..." }
```

Implementation note: `options` is three solves (as requested, and the two nearest weeks
with room). At 90 s each that is too slow for a page load — either cache per request, run
them shorter, or return the assessment asynchronously like a run. **Tell me which** and I
will match the UI's loading behaviour.

Storage: requests need to persist somewhere. `store.py` already does versioned JSON blobs;
`requests/{id}` alongside `runs/{id}` would be the obvious home.

### 4.2 Reports — Reports tab

The submission bundle already works via `/api/runs/{id}/export`. What is missing is the
formatted document pack.

```
GET /api/reports
-> [ { "id": "management-summary", "name": "Management summary",
       "audience": "For the executive team", "format": "PDF" | "XLSX",
       "description": "...", "size_hint": "2 pages · 8 figures",
       "generated_at": "2026-09-18T08:10:00Z" | null } ]

POST /api/reports/{id}/generate   { "run_id": "<run id>" }
-> { "download_url": "/api/reports/management-summary/download?run=<run id>",
     "generated_at": "..." }
```

Every figure these reports need is already in `validation` — this is rendering, not
computation. If PDF generation is more than you want to take on, returning XLSX or even
HTML for all six is fine; the UI only reads `format` to colour a pill.

### 4.3 Disruption recoveries — the one that needs a design decision

The Disruption tab currently does something real: it turns the disruption into overrides,
re-solves warm-started from the approved plan, and diffs the result. That single answer is
effectively the **minimum-churn** recovery, because the warm start biases the solver toward
keeping placements.

The spec asks for **five** recoveries that differ in what they protect:

| Philosophy | Protects | Pays with |
|---|---|---|
| Minimum churn | booked dates | one contract slips |
| Protect deadlines | every completion date | extra ECLO / excess nights |
| Protect passengers | service hours (fewest ECLO) | more activities move |
| Protect P1 | Priority-1 programmes | cost lands on P3 |
| Custom | whatever the user weights | nothing fully protected |

`solve()` takes a scenario, not weights, so this cannot be expressed today. Two ways:

**(a) Preset override-sets — cheap, approximate.** Each philosophy becomes a different
override bundle (e.g. "protect P1" also freezes P1 activities' locations). No solver
change, but the labels overstate what is actually being optimised.

**(b) A weighted objective — honest, more work.** Add optional weights to `solve()` that
scale the existing penalty terms: churn (the baseline-preservation tiebreaker, already
present as `secondary`), overrun (`weight10 * late`), ECLO (`50 * e`), excess (`70 * over`),
plus a P1 lock. The five philosophies are then five weight vectors, and the Custom sliders
map directly onto them.

I recommend (b) — the machinery is already in `solver.py`'s objective, it is mostly
plumbing weights through. Whichever you pick:

```
POST /api/disruptions/recoveries
{ "instance_id": "...", "scenario": "A", "baseline_id": "<approved run>",
  "overrides": [...],                                  // the disruption itself
  "weights": { "churn": 6, "deadlines": 7, "passengers": 5, "priority1": 8 },
  "philosophies": ["churn","deadlines","passengers","p1","custom"],
  "seconds": 90 }
-> 202 { "id": "<batch id>", "runs": [ { "philosophy": "churn", "run_id": "..." } ] }

GET /api/disruptions/recoveries/{batch id}
-> { "status": "running"|"completed",
     "results": [ { "philosophy": "churn", "run": <full run object> } ] }
```

Returning **full run objects** matters: the frontend already knows how to derive a whole
plan from one (`buildPlan`), so it can diff each philosophy against the approved plan
without any new logic. Five 90-second solves is 7½ minutes serially — the pool is
`max_workers=1`, so either widen it, shorten the budget, or stream results as they land.

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

## 8. Open questions for me

1. Should the export button be disabled when `feasible` is false, rather than 409-ing?
2. Request assessments: synchronous (cached) or polled like runs?
3. Recoveries: preset overrides (a) or weighted objective (b)?
4. Should `/api/chat`'s `preview` drive a scenario preview in the Ask tab?
