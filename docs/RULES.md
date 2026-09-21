# PS1 rule ledger

Authority: `PS1/PS1_README.md`, including the update received on 2026-09-18. The EDA and the ZIP bundle contain older commentary; current participant rules take precedence.

## September 19 scoring correction

The user reported 137.9 for the closure-corrected A ZIP, with 28 overrun days across three contracts and no ECLO/excess. This exactly matches charging each contract’s final delay at the sum of all its activity weights: C006 = 14 × 6.1 = 85.4; C010 = 7 × 6.5 = 45.5; C014 = 7 × 1 = 7. Total = 137.9. The previous per-activity delay sum of 32.2 was incorrect. The archive is preserved in `tests/fixtures/scored_a.zip`.

Rule version `ps1-local-1.2` applies this aggregation in validation, solver objectives, recovery ranking and analytical bounds. Cached scores and optimality claims from older rule versions are rechecked. This reproduces the reported score; the full official executable remains unavailable.

## September 19 closure correction

The user supplied `nightshift-A-545356a7.zip` and a 49-error closure report. `tests/fixtures/rejected_a` retains the three CSVs and exact reported details. The corrected checker reproduces all 49 messages without any timing sidecar; the supplied reference sample has zero violations. This is evidence of the reported validator behavior, not access to its implementation.

The old model compared only activities placed in the same private opportunity. Different opportunities did not protect the exported CSVs from weekly closure checks. Compatible overlapping work must now share an actual local possession; incompatible work that enters another closure takes different weeks. Non-Live buffers extend tunnel sectors only. Live closures include buffered platforms and the full buffered span on the other line at an interchange.

## September 18 update

The updated brief adds explicit **rule 3, Predecessor Precedence**: the predecessor's last scheduled week must be strictly earlier than the successor's first scheduled week; cross-contract dependencies are allowed and cycles are rejected. Subsequent rule numbers and output-schema references were updated. The engine already used this interpretation; dedicated cross-contract acceptance and cycle/same-week rejection tests now lock it down. No scoring formula or instance CSV changed in this update.

## Implemented semantics

| Rule | Implementation |
|---|---|
| Workload | Standard=2, ECLO=3 half-units; sum at least twice demand. No more than half a work unit of rounding surplus. All activities must be complete. |
| One access per week | One activity-week decision, from the ECLO continuity paragraph; applies in A/B/C. |
| Start | First eligible week is the week containing the planned start date, clamped to the input horizon. |
| Precedence | FS+0 as clarified: strict week separation, including across contracts. Missing predecessors/cycles reject input. |
| Route | Every tunnel sector between endpoints, inclusive, and all endpoint/intermediate platforms; one line and bound per activity. |
| Buffers | Extend tunnel sectors in both directions by the configured radius, clipped to the line boundary. Non-Live keeps route platforms only; Live includes platforms throughout the protected span. |
| Live | Mirror the protected footprint to the opposite bound; if it reaches an interchange pair, protect the other line's connecting sector plus its full sector-radius buffer and all platforms in that span, in both bounds. Treating protection reaching the interchange as sufficient is conservative. |
| Sharing | At most four simultaneous workers/location: one PM alone, one PC plus up to three C, or up to four C. Activities connected through actual `(location, week, group)` sharing belong to one possession component, exempt from its own closure. All other work in the week is checked against that component’s combined closure. |
| Capacity | Number of occupied possession slots/location/week, not number of activities. Only work locations draw nominal supply; protection is checked separately. |
| Local labels | `co_share_group` is location/week-local. `access_night` is contract/type/week-local. Neither is interpreted as a global calendar-night ID. |
| Allocation | Local access labels in 1..weekly cap, at most workfront count of distinct activities/label. |
| A | No capacity excess or ECLO; weighted overrun objective. |
| B | Week-end completion cannot exceed planned deadline; score 7×excess location-nights + 5×ECLO accesses. |
| C | At most one excess possession/location/week; each affected line gets one ECLO span with max week − min week ≤1; a cross-line Live access belongs to both windows. Add A's overrun score to B's costs. |
| Dates | Week ends at horizon_start + 7×week − 1 days. A contract with no activities is complete at horizon start. No unannounced horizon extension. |
| Penalty | Sum per contract: contract overrun days × contract tier weight 100/10/1 × sum of every member activity’s adjustment 1.3/1.2/1.0. Raw contract-overrun days count each contract once. |

The prose's illustrative cheap-to-expensive ordering contains inconsistent numbers. The equations, explicit 7/5 penalties and worked activity-weight examples govern the implementation.

## Export checks and additional temporal witness

Closure safety is checked from the submitted CSVs: connect activities sharing a location/week/group, union each component's closure, and reject external work entering it in that week. A label reused at disjoint locations does not connect them. The closure check runs whether or not a timing witness exists. Private timing slots cannot waive it.

The solver also chooses synchronized opportunities (seven, or the largest supplied capacity if greater) to enforce simultaneous workfronts and buffer separation. This sidecar adds checks but is not part of the official three-file export. Imports can now pass the local CSV checks without it.

The model conservatively requires a directly compatible route overlap for each pair of simultaneous jobs entering each other's closure. The checker also recognizes transitive sharing components; consequently the model can exclude some CSV-valid indirect sharing arrangements. Proven optimality applies to this local model, not necessarily to the organiser's full feasible set. `UNKNOWN` means no solution was found before the time limit.

Rule version `ps1-local-1.1` invalidates old cached feasibility and uses a new public demo ID. Export always revalidates a saved schedule. After the scoring correction, public local optima are A=137.9, B=30, C=62.7. Reports predating 1.2 retain historical scores and do not certify the corrected objective.

## Explanations and replanning

Analytical A bounds propagate predecessor completion while ignoring track competition. The B ECLO bound ignores predecessor/resource competition. Bounds are not promises that a target is attainable. Numeric responses render computed tool output rather than model-authored arithmetic.

The primary objective is the scenario's penalty. Without a baseline, earlier activity completion breaks ties; with a baseline, preserving activity-week placements breaks ties. This is secondary to score, so changed work is reported rather than claiming globally minimal churn at arbitrary score tolerances. Slot labels themselves are not operational change metrics.

What-if overrides are versioned and cumulative. An explicit hard closure forbids any work/protection touching that location in that week, even in B/C. A nominal supply reduction follows scenario capacity allowances. Neither control edits the original instance files.

## Remaining external verification

Obtain the official `trackaccess` implementation and compare exported CSVs on public and hidden-like fixtures before claiming official feasibility. The supplied rejection report establishes closure regression coverage, but full acceptance must still be confirmed by re-running the organiser’s checker on the corrected ZIP. Do not silently weaken local rules merely to improve a score.
