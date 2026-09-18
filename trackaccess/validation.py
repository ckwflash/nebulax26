"""Independent checks of exported decisions and an explicit temporal witness.

The official CSV format alone does not specify global night synchronization.
Imported schedules without a witness receive structural checks but no safety claim.
"""
from collections import Counter, defaultdict
from itertools import combinations

from . import RULE_VERSION
from .domain import Instance, Schedule, capacity_at


def validate(instance: Instance, schedule: Schedule, overrides=()):
    violations = []
    warnings = []

    def fail(rule, detail, **context):
        violations.append({"rule": rule, "severity": "hard", "detail": detail, **context})

    access = defaultdict(list)
    by_week = defaultdict(list)
    accounts = defaultdict(set)
    for row in schedule.access:
        aid, week = row.activity_id, row.week
        if aid not in instance.activities:
            fail("reference", f"Unknown activity {aid}.")
            continue
        a = instance.activities[aid]
        p = instance.projects[a.contract_number]
        access[aid].append(row)
        by_week[week].append(aid)
        accounts[a.contract_number, a.activity_type, week, row.access_night].add(aid)
        if not max(1, instance.week(a.planned_start_date)) <= week <= instance.weeks:
            fail("planned_start", f"{aid}: week {week} is outside its permitted horizon.")
        if row.access_night > p.number_of_maximum_access_per_week:
            fail("allocation", f"{aid}: access-night index exceeds the contract cap.")
        if schedule.scenario == "A" and row.eclo:
            fail("eclo", f"{aid}: Scenario A forbids ECLO.")
        if any(o.closed and o.week == week and o.location_id in instance.protected[aid] for o in overrides):
            fail("closure", f"{aid}, week {week}: work or protection enters an explicitly closed location.")
    complete, finish, supplied, weighted = 0, {}, 0, 0
    for aid, a in instance.activities.items():
        rows = access[aid]
        units = sum(2 + r.eclo for r in rows)
        supplied += min(a.total_accesses * 2, units)
        if units < a.total_accesses * 2:
            fail("workload", f"{aid}: received {units / 2:g} of {a.total_accesses} work units.", activity_id=aid)
        else:
            complete += 1
        if len({r.week for r in rows}) != len(rows):
            fail("access_week", f"{aid}: more than one access in the same week.")
        if sorted(r.access_seq for r in rows) != list(range(1, len(rows) + 1)):
            fail("sequence", f"{aid}: access_seq must be contiguous from 1.")
        finish[aid] = max((r.week for r in rows), default=0)
        if rows:
            p = instance.projects[a.contract_number]
            late = max(0, (instance.week_end(finish[aid]) - p.planned_completion_date).days)
            weighted += instance.weight10(aid) * late
            if schedule.scenario == "B" and late:
                fail("planned_date", f"{aid}: completion misses {p.planned_completion_date} by {late} days.")
    for aid, a in instance.activities.items():
        pred = a.predecessor_activity_id
        if pred and access[aid] and (not access[pred] or min(r.week for r in access[aid]) <= finish[pred]):
            fail("predecessor", f"{aid}: starts before predecessor {pred} has finished.")
    for (contract, kind, week, night), aids in accounts.items():
        if len(aids) > instance.projects[contract].number_of_workfronts:
            fail("workfront", f"{contract}/{kind}, week {week}, access {night}: too many workfronts.")

    expected = {(r.activity_id, r.week, loc) for r in schedule.access if r.activity_id in instance.activities for loc in instance.routes[r.activity_id]}
    actual = Counter((r.activity_id, r.week, r.location_id) for r in schedule.occupancy)
    for aid, week, loc in sorted(expected - actual.keys()):
        fail("route", f"{aid}, week {week}: missing occupancy at {loc}.")
    for key, count in actual.items():
        if key not in expected or count != 1:
            fail("route", f"Unexpected or duplicate occupancy {key}.")
    groups = defaultdict(set)
    lw = defaultdict(set)
    for row in schedule.occupancy:
        if row.activity_id not in instance.activities or row.location_id not in instance.supply:
            fail("reference", "Occupancy references an unknown activity or location.")
            continue
        groups[row.location_id, row.week, row.co_share_group].add(row.activity_id)
        lw[row.location_id, row.week].add(row.co_share_group)
    for (loc, week, group), aids in groups.items():
        kinds = Counter(instance.projects[instance.activities[a].contract_number].access_type for a in aids)
        if len(aids) > 4 or kinds["PC"] > 1 or (kinds["PM"] and len(aids) > 1):
            fail("mix", f"{loc}, week {week}, {group}: illegal possession mix.")
    hotspots, excess = [], 0
    for (loc, week), g in sorted(lw.items()):
        cap = capacity_at(instance, loc, week, overrides)
        over = max(0, len(g) - cap)
        excess += over
        if schedule.scenario == "A" and over or schedule.scenario == "C" and over > 1:
            fail("capacity", f"{loc}, week {week}: {len(g)} possessions against capacity {cap}.")
        hotspots.append({"location_id": loc, "week": week, "used": len(g), "capacity": cap, "excess": over, "evidence_id": f"capacity:{loc}:{week}"})

    # Independently inspect simultaneous activity pairs, without solver constraints.
    safety_verified = bool(schedule.witness)
    expected_witness = {f"{r.activity_id}:{r.week}" for r in schedule.access}
    if safety_verified and set(schedule.witness) != expected_witness:
        fail("witness", "Timing witness does not match the access rows.")
        safety_verified = False
    if safety_verified:
        physical = defaultdict(list)
        location_timing = defaultdict(dict)
        for row in schedule.access:
            slot = schedule.witness[f"{row.activity_id}:{row.week}"]
            if not 1 <= slot <= max(7, max(instance.supply.values())):
                fail("witness", "Timing witness has an out-of-range opportunity.")
            physical[row.week, slot].append(row.activity_id)
        for (loc, week, group), aids in groups.items():
            times = {schedule.witness.get(f"{a}:{week}") for a in aids}
            if len(times) != 1:
                fail("witness", f"{loc}, week {week}: co-sharers do not coincide.")
            for t in times:
                if t in location_timing[loc, week] and location_timing[loc, week][t] != group:
                    fail("witness", f"{loc}, week {week}: separate possessions coincide.")
                location_timing[loc, week][t] = group
        for (week, slot), aids in physical.items():
            for i, j in combinations(aids, 2):
                if i not in instance.activities or j not in instance.activities:
                    continue
                ai, aj = instance.activities[i], instance.activities[j]
                pi, pj = instance.projects[ai.contract_number], instance.projects[aj.contract_number]
                overlap = instance.routes[i] & instance.routes[j]
                sharing = bool(overlap) and "PM" not in (pi.access_type, pj.access_type) and (pi.access_type, pj.access_type) != ("PC", "PC")
                if not sharing and instance.protected[i] & instance.protected[j]:
                    fail("closure", f"Week {week}, opportunity {slot}: {i} and {j} have intersecting work/protection footprints.", activity_id=i, other_activity=j)
    else:
        warnings.append("Cross-location buffer safety is unverified: imported CSVs have no temporal witness. Local possession labels are not global nights.")

    eclo_by_line = defaultdict(list)
    for row in schedule.access:
        if row.eclo and row.activity_id in instance.activities:
            for line in instance.affected_lines[row.activity_id]:
                eclo_by_line[line].append(row.week)
    if schedule.scenario == "C":
        for line, weeks in eclo_by_line.items():
            if max(weeks) - min(weeks) > 1:
                fail("eclo_window", f"{line}: ECLO spans more than two consecutive weeks.")

    result_rows = {r.contract_number: r for r in schedule.results}
    if len(result_rows) != len(schedule.results) or set(result_rows) != set(instance.projects):
        fail("results", "RESULTS must contain exactly one row per contract.")
    contract_details, total_late, tiers = [], 0, {"1": 0, "2": 0, "3": 0}
    for cid, p in instance.projects.items():
        week = max((finish[a.activity_id] for a in instance.activities.values() if a.contract_number == cid), default=0)
        completion = instance.week_end(week) if week else instance.start
        late = max(0, (completion - p.planned_completion_date).days)
        total_late += late
        tiers[str(p.contract_priority)] += late
        row = result_rows.get(cid)
        if row and (row.scenario != schedule.scenario or row.simulated_completion_date != completion or row.overrun_days != late):
            fail("results", f"{cid}: completion summary does not match access rows.")
        contract_details.append({"contract_number": cid, "completion_week": week, "simulated_completion_date": str(completion), "planned_completion_date": str(p.planned_completion_date), "overrun_days": late, "priority": p.contract_priority, "evidence_id": f"contract:{cid}"})
    eclo = sum(r.eclo for r in schedule.access)
    score = (0 if schedule.scenario == "B" else weighted / 10) + (0 if schedule.scenario == "A" else 7 * excess + 5 * eclo)
    return {"scenario": schedule.scenario, "feasible": not violations and safety_verified,
            "structurally_valid": not violations, "safety_verified": safety_verified,
            "validation_authority": "local", "rule_version": RULE_VERSION, "hard_violations": violations,
            "warnings": warnings, "score": round(score, 1), "coverage_percent": round(100 * supplied / (2 * sum(a.total_accesses for a in instance.activities.values())), 2),
            "completed_activities": complete, "total_activities": len(instance.activities),
            "soft_scores": {"priority_weighted_score": round(weighted / 10, 1), "overrun_days_total": total_late, "contracts_overrunning": sum(c["overrun_days"] > 0 for c in contract_details), "priority_overrun": tiers, "excess_access_nights_total": excess, "eclo_nights_total": eclo},
            "contracts": contract_details, "capacity": hotspots, "eclo_windows": {l: [min(ws), max(ws)] for l, ws in eclo_by_line.items()},
            "sharing_saved": len(schedule.occupancy) - len(groups)}
