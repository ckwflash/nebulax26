# NebulaX Hackathon — Problem Statement 1 EDA

**Prepared:** 2026-09-17  
**Scope:** `/Users/kaiwen/repos/NebulaX-Hackathon-ProblemStatement`  
**Primary focus:** PS1 — Railway Track Access Optimisation

This document captures the repository exploration and the key facts another agent needs before implementing a solver, validator, or web application.

## Executive summary

This checkout is a problem-data pack, not an implementation. It contains the PS1 specification, one public input instance, a reference Scenario A submission, network diagrams, a duplicate ZIP bundle, and a general LTA DataMall API guide.

There is currently no solver, validator, application source, dependency manifest, test suite, or local `trackaccess` package. The brief references `python3 -m trackaccess expand`, but that command/package is not included here.

The core task is a constrained overnight railway possession scheduler:

- 2 lines (`ALP`, `BET`), each with `EB` and `WB` bounds.
- 30-week planning horizon beginning 2027-01-04.
- 14 contracts and 54 activities.
- 192 standard access units that must all be scheduled.
- 76 capacity locations: 36 tunnel locations and 40 platform locations.
- Three independently scored scenarios: A, B, and C.
- Required output per scenario: `SCHEDULE_ACCESS.csv`, `SCHEDULE_OCCUPANCY.csv`, and `RESULTS.csv`.

The most difficult modelling areas are route expansion, buffer propagation, co-sharing/legal possession mixes, opposite-bound live-rail mirroring, interchange cross-line coupling, weekly access-night accounting, and scenario-specific objective functions.

## Repository inventory

### Present files

```text
README.md
EDA.md                         # this document
LTA_DataMall_API_User_Guide.pdf
PS1.zip                        # duplicate PS1 bundle, includes __MACOSX metadata
PS1/
├── PS1_README.md              # authoritative PS1 participant brief
├── 01_data/
│   ├── 01_LINES.csv
│   ├── 02_STATIONS.csv
│   ├── 03_SECTORS.csv
│   ├── 04_LOCATION_SUPPLY.csv
│   ├── 05_BUFFER_LOCATION.csv
│   ├── 06_PARAMETERS.csv
│   ├── 07_PROJECT_DETAILS.csv
│   └── 08_ACTIVITY_DETAILS.csv
├── 02_references/
│   ├── PS1.drawio
│   └── network_diagram.svg
└── 03_submission_sample/
    ├── RESULTS.csv
    ├── SCHEDULE_ACCESS.csv
    └── SCHEDULE_OCCUPANCY.csv
```

### Absent files/folders

The root `README.md` describes PS2 and PS3, but neither `PS2/` nor `PS3/` exists in this checkout. There is also no implementation code for PS1.

The repository's `.git` directory was intentionally removed before this EDA to eliminate a large historical dataset pack. This folder is no longer a Git repository.

## Source-of-truth documents

- `PS1/PS1_README.md` is the authoritative PS1 challenge specification.
- `PS1/01_data/*.csv` is the public planning instance.
- `PS1/03_submission_sample/` is a reference-format Scenario A submission. The brief labels it feasible with zero hard violations; the local structural checks below also pass.
- `PS1/02_references/network_diagram.svg` is the current rendered topology reference.
- `PS1/02_references/PS1.drawio` is an editable diagram containing illustrative buffer/co-sharing examples.
- `README.md` is a generic multi-problem repository guide and contains some stale/inaccurate references. In particular, it says the PS1 data directory has nine files, while the actual directory has eight.

## Dataset dimensions

| Entity | Count / value |
|---|---:|
| Lines | 2 |
| Station rows | 20 |
| Unique station IDs | 18 |
| Interchange station rows | 4 |
| Tunnel sectors | 18 |
| Supply locations | 76 |
| Contracts | 14 |
| Activities | 54 |
| Predecessor edges | 6 |
| Total standard access units | 192 |
| Planning horizon | 30 weeks |
| Horizon start | 2027-01-04 |

The 20 station rows are 10 stations per line. `H01` and `H02` appear on both lines, so there are 18 unique station IDs overall.

### Network structure

Each line has 10 stations and 9 tunnel sectors:

- Alpha: `S01`–`S04`, `H01`, `H02`, `S05`–`S08`.
- Beta: `S11`–`S14`, `H01`, `H02`, `S15`–`S18`.

The two lines have separate `H01_H02` tunnel sectors and separate platform sectors. They do **not** share ordinary capacity. The exception is `Live` work: traction-power isolation at the interchange affects the other line's interchange tunnel/platforms too.

### Capacity structure

`LOCATION_SUPPLY.csv` contains:

| Location kind | Count | Sum of listed capacities |
|---|---:|---:|
| Tunnel sector | 36 | 116 |
| Platform sector | 40 | 72 |
| Total | 76 | 188 |

Capacity values occur as follows:

| Capacity | Locations |
|---:|---:|
| 1 | 12 |
| 2 | 40 |
| 4 | 24 |

The central interchange sectors and interchange platforms are the tightest locations, generally capacity 1. Normal tunnel sectors generally have capacity 4, while sectors near the interchange have capacity 2. Normal platforms generally have capacity 2.

## Contract and activity profile

### Contracts

| Contract | Priority | Access type | Nature | Workfronts | Weekly cap | Activities | Access units | Planned completion |
|---|---:|---|---|---:|---:|---:|---:|---|
| C001 | 3 | C | Non-live (Consist) | 2 | 3 | 6 | 20 | 2027-06-13 |
| C002 | 2 | C | Non-live (Consist) | 1 | 3 | 5 | 26 | 2027-07-04 |
| C003 | 1 | C | Non-live (Others) | 1 | 3 | 4 | 18 | 2027-07-04 |
| C004 | 1 | PC | Non-live (Consist) | 1 | 3 | 3 | 17 | 2027-07-25 |
| C005 | 3 | PC | Non-live (Consist) | 2 | 3 | 2 | 4 | 2027-03-21 |
| C006 | 3 | C | Non-live (Others) | 1 | 3 | 5 | 22 | 2027-07-04 |
| C007 | 1 | C | Non-live (Consist) | 1 | 3 | 5 | 19 | 2027-07-11 |
| C008 | 3 | C | Non-live (Consist) | 1 | 3 | 5 | 14 | 2027-07-18 |
| C009 | 3 | PC | Non-live (Others) | 1 | 3 | 4 | 12 | 2027-06-27 |
| C010 | 3 | C | Non-live (Others) | 2 | 3 | 6 | 26 | 2027-05-16 |
| C011 | 2 | C | Non-live (Consist) | 1 | 3 | 5 | 10 | 2027-07-11 |
| C012 | 1 | C | Non-live (Others) | 1 | 3 | 2 | 2 | 2027-07-11 |
| C013 | 2 | PC | Live | 1 | 2 | 1 | 1 | 2027-05-30 |
| C014 | 3 | PM | Live | 1 | 2 | 1 | 1 | 2027-07-18 |

Aggregate profile:

- 32 Renewal activities and 22 Construction activities.
- 20 activities with priority 3, 19 with priority 2, and 15 with priority 1.
- Priority 1 contracts: 4 contracts, 56 access units.
- Priority 2 contracts: 3 contracts, 37 access units.
- Priority 3 contracts: 7 contracts, 99 access units.
- `Non-live (Consist)`: 110 access units.
- `Non-live (Others)`: 80 access units.
- `Live`: 2 access units.
- Six predecessor edges: `A003→A004`, `A012→A013`, `A037→A038`, `A048→A049`, `A050→A051`, and `A065→A066`.

### The two Live activities

- `A074`, contract `C013`, Renewal, Alpha `H01_H02:EB`, `PC`, one access.
- `A075`, contract `C014`, Construction, Beta `H01_H02:WB`, `PM`, one access.

They are small by workload but high-impact because Live work mirrors to the opposite bound and crosses the interchange to the other line's corresponding tunnel/platform locations.

## Route expansion

Activities identify a starting sector and ending sector, each with a bound suffix such as `:EB` or `:WB`. The schedule does not only book those two sectors.

For each activity, the occupancy should include:

1. Every tunnel sector between the start and end sectors on the same line, inclusive.
2. Every platform sector at the station endpoints and intermediate stations along that span, on the same line and bound.

The sample confirms this interpretation. For example, an activity from Beta `H01_H02:EB` through `S15_S16:EB` occupies:

```text
SEC:BET:H01_H02:EB
SEC:BET:H02_S15:EB
SEC:BET:S15_S16:EB
PLAT:BET:H01:EB
PLAT:BET:H02:EB
PLAT:BET:S15:EB
PLAT:BET:S16:EB
```

The average activity route occupies approximately 4.89 locations; the longest route in this instance occupies 7 locations.

## Raw demand hotspots

Summing each activity's full access workload over every location in its expanded route gives these highest-demand locations:

| Location | Raw access demand |
|---|---:|
| `SEC:BET:S15_S16:EB` | 43 |
| `SEC:BET:H02_S15:EB` | 39 |
| `SEC:BET:H01_H02:EB` | 36 |
| `SEC:ALP:S03_S04:WB` | 29 |
| `SEC:ALP:S04_H01:WB` | 21 |
| `SEC:BET:S16_S17:EB` | 14 |
| `SEC:ALP:H01_H02:WB` | 13 |
| `SEC:BET:S12_S13:WB` | 12 |
| `SEC:BET:H02_S15:WB` | 12 |
| `SEC:ALP:S05_S06:WB` | 12 |

Platform hotspots follow the same pattern, especially Beta `S15`, `S16`, `H01`, and `H02` on the eastbound side.

These are cumulative workload figures, not direct capacity violations. Actual feasibility depends on spreading work over weeks, co-sharing compatible activities, and respecting buffers.

## Hard constraints

The following rules are feasibility gates:

### Workload conservation

Every activity must receive at least `total_accesses` work units. A standard access contributes `1.0`; an ECLO access contributes `1.5`.

No activity may be dropped, truncated, or left partially scheduled.

### Planned start

An activity cannot use a week before its `planned_start_date`.

### Nature-specific buffers

`05_BUFFER_LOCATION.csv` defines:

| Nature | Buffer span | Opposite bound |
|---|---:|---:|
| `Live` | 2 sectors | Required |
| `Non-live (Consist)` | 1 sector | No |
| `Non-live (Others)` | 0 sectors | No |

Buffers are exclusion zones around possessions. Buffer-free co-sharing is a special legal arrangement, not a general relaxation of safety rules.

### Possession mix

For one location-week:

- One `PM` must be alone.
- One `PC` may host up to three `C` activities.
- Up to four `C` activities may share.

The same `(location_id, week, co_share_group)` represents one possession slot and allows compatible activities to co-share. Different co-share groups at the same location/week represent separate possessions and must be treated as separate nights for conflict/buffer reasoning.

### Weekly access nights and workfronts

`access_night` is a local accounting label for a `(contract_number, activity_type, week)` grouping. It ranges from 1 through that contract's `number_of_maximum_access_per_week`.

The validator checks:

- Number of distinct access-night labels per contract/type/week does not exceed the weekly cap.
- At most `number_of_workfronts` distinct activities of that contract/type use the same access-night label.

The maximum number of distinct activities in one contract/type/week is therefore approximately:

```text
weekly_access_cap × number_of_workfronts
```

### Live-rail coupling

Live work:

- Closes the opposite bound on the same line.
- At `H01_H02`, also affects the other line's interchange tunnel and H01/H02 platforms.

Non-live work remains line-local at the interchange.

### Predecessors

The input has six predecessor relationships. The sample places each dependent activity after its predecessor's latest scheduled week. The exact validator semantics should be confirmed when a validator becomes available; a safe implementation should require predecessor completion before dependent work begins.

## Scenario objectives

All scores are penalties; lower is better.

### Scenario A — strict supply, flexible schedule

- Capacity is hard: no excess access nights.
- ECLO is hard-forbidden.
- Planned completion dates may overrun.
- Objective is priority-weighted overrun minimization.
- Contract priority weights are 100 / 10 / 1 for P1 / P2 / P3.
- Activity priority adds a small within-band nudge: +0.3 / +0.2 / +0.0 for activity priorities 1 / 2 / 3.

Practical strategy: preserve P1 work, then P2, and absorb delay in P3 work when unavoidable.

### Scenario B — strict schedule, flexible supply

- Planned completion dates are hard.
- Capacity excess is allowed and scored.
- ECLO is allowed and scored.
- Overrun should be zero for a feasible submission.
- Score is:

```text
7 × excess_access_nights_total + 5 × eclo_nights_total
```

### Scenario C — balanced trade-off

- Both overrun and excess capacity contribute to the score.
- Up to one excess access night per location-week is soft-scored; more triggers a hard capacity violation.
- ECLO is allowed but must fall within one continuous window of at most two calendar weeks per line.
- A Live activity crossing both lines must satisfy both lines' ECLO windows.

Score:

```text
priority_weighted_overrun
+ 7 × excess_access_nights_total
+ 5 × eclo_nights_total
```

## Output contract

Each scenario must produce its own three files:

### `SCHEDULE_ACCESS.csv`

```csv
activity_id,access_seq,week,eclo,access_night
```

One row per activity access. `access_seq` should be contiguous from 1. The sample has 192 rows, exactly matching the 192 standard access units.

### `SCHEDULE_OCCUPANCY.csv`

```csv
activity_id,week,location_id,co_share_group
```

One row per activity-week-location assignment. The sample has 928 rows for 192 activity-week accesses.

### `RESULTS.csv`

```csv
scenario,contract_number,simulated_completion_date,overrun_days
```

It must contain exactly one scenario. Mixing A/B/C rows in one results file is rejected by the brief.

## Reference sample findings

The supplied sample is Scenario A only:

- 192 access rows.
- 928 occupancy rows.
- 14 result rows.
- All 54 activities represented.
- No ECLO rows.
- Access weeks range from 1 through 29.
- Every access activity-week has occupancy records.
- Every occupancy location is present in `LOCATION_SUPPLY.csv`.
- Access-night labels stay within contract limits.
- Maximum observed workfront concurrency is two activities.
- Overruns occur only on `C006`, `C010`, and `C014`, all Priority 3 contracts.

The brief describes this sample as feasible with zero hard violations. No official validator is included in the checkout, so local checks are structural rather than authoritative.

## Implementation risks and ambiguities

1. **No official validator.** The scoring logic is described, but the exact parser and edge-case semantics are unavailable.
2. **No `trackaccess` package.** The brief references an `expand` command that cannot currently be executed.
3. **Predecessor semantics are under-specified.** A conservative solver should enforce strict predecessor completion before dependent start.
4. **Buffer interpretation is subtle.** Buffers apply to possessions, not simply individual activities, and co-sharing groups exempt compatible work from mutual buffers.
5. **Access-night versus calendar-night accounting is easy to confuse.** `access_night` is a local per-contract/type/week label, not a global night identifier.
6. **Scenario C has two elasticity sources.** It has amended supply data in scenario instances plus a one-excess-night soft allowance per location-week.
7. **Horizon and deadline edges need care.** The horizon has 30 weeks, while some contractual dates extend into August 2027. Do not silently assume post-horizon scheduling semantics without validator confirmation.
8. **The root README is stale.** It describes missing PS2/PS3 folders and has minor formatting/content errors.
9. **Only Scenario A has a public answer key.** B and C outputs must be generated independently.

## Recommended engineering plan

### Phase 1 — deterministic parser and route engine

- Load and schema-check all eight input CSVs.
- Normalize dates to week indices.
- Build line/sector/station graphs.
- Expand every activity into tunnel and platform locations.
- Validate all references and predecessor IDs.

### Phase 2 — local feasibility validator

Implement independent checks for:

- Workload conservation.
- Planned start dates.
- Route occupancy completeness.
- Location capacity.
- Legal possession mixes.
- Co-sharing groups.
- Buffer and opposite-bound conflicts.
- Live interchange coupling.
- Weekly access-night caps.
- Workfront limits.
- Predecessor ordering.
- Scenario-specific ECLO/capacity/date rules.

### Phase 3 — solver

For this instance size, CP-SAT is a strong starting point. Precompute candidate activity-week placements and conflict relationships instead of modelling every raw time/location relationship from scratch.

Use a two-stage objective:

1. Find a fully feasible schedule.
2. Optimize the scenario score while preserving feasibility.

Prioritize co-sharing-compatible activities, especially around Beta eastbound interchange hotspots. Keep P1 activities protected from delay unless no legal alternative exists.

### Phase 4 — explainability and UI

The judging rubric explicitly values usability and explanation. The app should expose:

- Timeline by contract/activity.
- Location-week capacity heatmap.
- Co-sharing groups.
- Buffer and Live-rail conflict explanations.
- Scenario score breakdown.
- Why an activity moved or overran.
- Downloadable output CSVs.

### Phase 5 — disruption re-planning bonus

The LTA API guide is not required for the core static instance, but it can support a strong extension using train service alerts and facilities maintenance data. The relevant guide endpoints include `TrainServiceAlerts`, `FacilitiesMaintenance`, and station crowd-density APIs. A disruption workflow should preserve unaffected placements and minimize schedule churn.

## Suggested first agent task

Before building the UI, implement a local route expander plus validator and run it against the supplied sample. The sample should become a regression fixture: any future solver or UI change must continue to reproduce its structural invariants and produce three parseable output files.

