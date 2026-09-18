# PS1 rule ledger

Authority: `PS1/PS1_README.md`, including the update received on 2026-09-18. The EDA and the ZIP bundle contain older commentary; current participant rules take precedence.

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
| Buffers | Extend in both directions by the nature's configured sector radius, clipped to the line boundary, including platforms along that protected span. |
| Live | Mirror the protected footprint to the opposite bound; if it reaches an interchange pair, protect the other line's connecting sector and both hub platforms in both bounds. Treating protection reaching the interchange as sufficient is conservative. |
| Sharing | At most four simultaneous workers/location: one PM alone, one PC plus up to three C, or up to four C. Compatible work sharing a route location may combine into one possession and is exempt from mutual protection. |
| Capacity | Number of occupied possession slots/location/week, not number of activities. Only work locations draw nominal supply; protection is checked separately. |
| Local labels | `co_share_group` is location/week-local. `access_night` is contract/type/week-local. Neither is interpreted as a global calendar-night ID. |
| Allocation | Local access labels in 1..weekly cap, at most workfront count of distinct activities/label. |
| A | No capacity excess or ECLO; weighted overrun objective. |
| B | Week-end completion cannot exceed planned deadline; score 7×excess location-nights + 5×ECLO accesses. |
| C | At most one excess possession/location/week; each affected line gets one ECLO span with max week − min week ≤1; a cross-line Live access belongs to both windows. Add A's overrun score to B's costs. |
| Dates | Week ends at horizon_start + 7×week − 1 days. A contract with no activities is complete at horizon start. No unannounced horizon extension. |
| Penalty | Sum per late activity: contract tier weight 100/10/1 × activity adjustment 1.3/1.2/1.0 × late days. Raw contract-overrun days are a separate aggregate. |

The prose's illustrative cheap-to-expensive ordering contains inconsistent numbers. The equations, explicit 7/5 penalties and worked activity-weight examples govern the implementation.

## Additional temporal witness

The official output omits calendar nights. Treating sample group labels as global nights yields inconsistent cross-location assignments; the solver cannot responsibly claim a global safety proof from those labels alone.

Nightshift therefore chooses auxiliary synchronized opportunities while solving. Their default count is seven, or the largest supplied capacity if greater. Within each opportunity, independent checking verifies intersecting footprints, group membership and possession separation. Contract allocations are derived back into **local** access labels. The witness is retained as a local sidecar, not added to the official CSV schema.

This is a conservative realisability model and can exclude schedules accepted by an aggregate-only official validator. `INFEASIBLE` means infeasible in this implementation, not necessarily in the undisclosed validator. `UNKNOWN` means no solution was found before the limit. Imports without witnesses receive structural checks and a safety-unverified status. The supplied sample is not claimed to be invalid under the organiser's implementation.

## Explanations and replanning

Analytical A bounds propagate predecessor completion while ignoring track competition. The B ECLO bound ignores predecessor/resource competition. Bounds are not promises that a target is attainable. Numeric responses render computed tool output rather than model-authored arithmetic.

The primary objective is the scenario's penalty. Without a baseline, earlier activity completion breaks ties; with a baseline, preserving activity-week placements breaks ties. This is secondary to score, so changed work is reported rather than claiming globally minimal churn at arbitrary score tolerances. Slot labels themselves are not operational change metrics.

What-if overrides are versioned and cumulative. An explicit hard closure forbids any work/protection touching that location in that week, even in B/C. A nominal supply reduction follows scenario capacity allowances. Neither control edits the original instance files.

## Remaining external verification

Obtain the official `trackaccess` implementation and compare exported CSVs on public and hidden-like fixtures before claiming official feasibility. In particular, reconcile temporal synchronization, buffer-to-platform propagation, cross-line closure triggering and the penalty formula. Do not silently weaken local rules merely to improve a score.
