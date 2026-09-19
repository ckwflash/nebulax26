from __future__ import annotations

import os
import threading
import time
from collections import defaultdict
from itertools import combinations
from typing import Callable

from ortools.sat.python import cp_model

from .domain import Access, Completion, Instance, Occupancy, Schedule, capacity_at
from .validation import validate

# Scenario B overrun weight, in tenths like every other penalty term. Far above the
# 70/excess and 50/ECLO rates so B buys its dates with supply before it slips them.
DEADLINE_PRICE = 10_000

# Recovery weights, each 0..10 with 5 meaning "as the official objective". They only steer
# the search; the reported score is always the official formula from validate().
#   churn      - moving an access week away from the baseline (needs a baseline)
#   deadlines  - overrun days
#   passengers - ECLO accesses and excess location-nights (both eat into service hours)
#   priority1  - extra multiplier on overrun and churn of Priority-1 contracts
WEIGHT_KEYS = ("churn", "deadlines", "passengers", "priority1")
NEUTRAL = 5
# Tenths of a penalty point for one moved access-week at the neutral weight: the same as
# one day's overrun on a P3 / activity-priority-3 job, and half an ECLO (50).
CHURN_PRICE = 10


def solve(instance: Instance, scenario: str, seconds=90, overrides=(), baseline: Schedule | None = None, callback: Callable | None = None, cancel_event=None, relax_deadline=False, weights: dict | None = None):
    if scenario not in ("A", "B", "C"):
        raise ValueError("Scenario must be A, B or C.")
    if weights is not None:
        weights = {k: int(weights.get(k, NEUTRAL)) for k in WEIGHT_KEYS}
        if any(not 0 <= v <= 10 for v in weights.values()):
            raise ValueError("Weights must be between 0 and 10.")
    started = time.monotonic()
    # B is solved in two phases. Phase 1 keeps the deadline as a domain filter, which is
    # both fast and exactly the rule. Only when that proves INFEASIBLE does phase 2 reopen
    # the horizon and price the overrun, so a tight instance still returns a schedule
    # instead of nothing. Deciding this up front avoids building a model that cannot solve.
    if scenario == "B" and not relax_deadline:
        relax_deadline = any(
            not [w for w in range(1, instance.weeks + 1)
                 if w >= min(max(1, instance.week(a.planned_start_date)), instance.weeks)
                 and instance.week_end(w) <= instance.projects[a.contract_number].planned_completion_date]
            for a in instance.activities.values())
    model = cp_model.CpModel()
    aids = sorted(instance.activities)
    # Auxiliary synchronized opportunities prove a physically realizable schedule.
    # They do NOT change the scope of exported local accounting labels.
    slots = range(max(7, max(instance.supply.values())))
    weeks = range(1, instance.weeks + 1)
    x, e, z, finish, assignments = {}, {}, {}, {}, defaultdict(list)
    hints = {(r.activity_id, r.week): r for r in baseline.access} if baseline else {}
    for aid in aids:
        a = instance.activities[aid]
        p = instance.projects[a.contract_number]
        # A start week beyond the horizon is clamped to the final week rather than
        # emptying the window, which would make the whole model trivially infeasible.
        first = min(max(1, instance.week(a.planned_start_date)), instance.weeks)
        eligible = [w for w in weeks if w >= first and (scenario != "B" or relax_deadline or instance.week_end(w) <= p.planned_completion_date)]
        finish[aid] = model.new_int_var(1, instance.weeks, f"finish_{aid}")
        for w in eligible:
            x[aid, w] = model.new_bool_var(f"work_{aid}_{w}")
            e[aid, w] = model.new_bool_var(f"eclo_{aid}_{w}")
            model.add(e[aid, w] <= x[aid, w])
            if any(o.closed and o.week == w and o.location_id in instance.protected[aid] for o in overrides):
                model.add(x[aid, w] == 0)
            if scenario == "A":
                model.add(e[aid, w] == 0)
            for n in slots:
                z[aid, w, n] = model.new_bool_var(f"place_{aid}_{w}_{n}")
                assignments[w, n].append(aid)
            model.add(sum(z[aid, w, n] for n in slots) == x[aid, w])
            if baseline:
                model.add_hint(x[aid, w], int((aid, w) in hints))
                model.add_hint(e[aid, w], hints[aid, w].eclo if (aid, w) in hints else 0)
                for n in slots:
                    model.add_hint(z[aid, w, n], int(baseline.witness.get(f"{aid}:{w}") == n + 1))
        model.add(sum(2 * x[aid, w] + e[aid, w] for w in eligible) >= 2 * a.total_accesses)
        model.add(sum(2 * x[aid, w] + e[aid, w] for w in eligible) <= 2 * a.total_accesses + 1)
        model.add_max_equality(finish[aid], [w * x[aid, w] for w in eligible])
    for (aid, w), present in x.items():
        pred = instance.activities[aid].predecessor_activity_id
        if pred:
            model.add(finish[pred] < w).only_enforce_if(present)

    by_location = defaultdict(list)
    for aid in aids:
        for loc in instance.routes[aid]:
            by_location[loc].append(aid)
    excess_vars = []
    for loc, occupants in by_location.items():
        for w in weeks:
            possible = [aid for aid in occupants if (aid, w) in x]
            if not possible:
                continue
            used = []
            for n in slots:
                terms = [z[aid, w, n] for aid in possible]
                busy = model.new_bool_var(f"used_{loc}_{w}_{n}")
                model.add_max_equality(busy, terms)
                used.append(busy)
                model.add(sum(terms) <= 4)
                pc = [z[aid, w, n] for aid in possible if instance.projects[instance.activities[aid].contract_number].access_type == "PC"]
                model.add(sum(pc) <= 1)
                for aid in possible:
                    if instance.projects[instance.activities[aid].contract_number].access_type == "PM":
                        model.add(sum(terms) <= 1).only_enforce_if(z[aid, w, n])
            cap = capacity_at(instance, loc, w, overrides)
            if scenario == "A":
                model.add(sum(used) <= cap)
            else:
                over = model.new_int_var(0, len(slots), f"excess_{loc}_{w}")
                model.add_max_equality(over, [0, sum(used) - cap])
                excess_vars.append(over)
                if scenario == "C":
                    model.add(over <= 1)
    for i, j in combinations(aids, 2):
        pi = instance.projects[instance.activities[i].contract_number]
        pj = instance.projects[instance.activities[j].contract_number]
        sharing = bool(instance.routes[i] & instance.routes[j]) and "PM" not in (pi.access_type, pj.access_type) and (pi.access_type, pj.access_type) != ("PC", "PC")
        if not sharing and instance.protected[i] & instance.protected[j]:
            for w in weeks:
                if (i, w) in x and (j, w) in x:
                    for n in slots:
                        model.add(z[i, w, n] + z[j, w, n] <= 1)
    for cid, p in instance.projects.items():
        members = [a for a in aids if instance.activities[a].contract_number == cid]
        for w in weeks:
            possible = [a for a in members if (a, w) in x]
            if not possible:
                continue
            used = []
            for n in slots:
                terms = [z[a, w, n] for a in possible]
                busy = model.new_bool_var(f"contract_{cid}_{w}_{n}")
                model.add_max_equality(busy, terms)
                model.add(sum(terms) <= p.number_of_workfronts)
                used.append(busy)
            model.add(sum(used) <= p.number_of_maximum_access_per_week)
    if scenario == "C":
        windows = {line: model.new_int_var(1, instance.weeks, f"window_{line}") for line in instance.lines}
        for (aid, w), ec in e.items():
            for line in instance.affected_lines[aid]:
                model.add(windows[line] <= w).only_enforce_if(ec)
                model.add(windows[line] >= w - 1).only_enforce_if(ec)

    # Unweighted, every coefficient keeps its official value. Weighted, each term is
    # multiplied by weight * NEUTRAL (priority-1 terms by weight * priority1), so an
    # all-neutral vector reproduces the official objective scaled by NEUTRAL**2.
    wt = weights or {}
    unit = NEUTRAL * NEUTRAL if weights else 1

    def p1(aid, base):
        if not weights:
            return base
        return base * (wt["priority1"] if instance.projects[instance.activities[aid].contract_number].contract_priority == 1 else NEUTRAL)

    penalty = []
    for aid in aids:
        p = instance.projects[instance.activities[aid].contract_number]
        late = model.new_int_var(0, max(0, (instance.week_end(instance.weeks) - p.planned_completion_date).days), f"late_{aid}")
        model.add_max_equality(late, [0, 7 * finish[aid] - 1 - (p.planned_completion_date - instance.start).days])
        if scenario == "B":
            # Phase 1 cannot be late by construction. In phase 2 this must dominate every
            # other term so a date slips only when no ECLO/excess combination can hit it.
            penalty.append(DEADLINE_PRICE * unit * late)
        else:
            penalty.append(p1(aid, instance.weight10(aid) * (wt["deadlines"] if weights else 1)) * late)
    if scenario != "A":
        pax = wt["passengers"] * NEUTRAL if weights else 1
        penalty.extend([70 * pax * v for v in excess_vars])
        penalty.extend([50 * pax * v for v in e.values()])
    if weights and baseline and wt["churn"]:
        # Each access-week that differs from the baseline, in either direction.
        penalty.extend(p1(aid, CHURN_PRICE * wt["churn"]) * (1 - v if (aid, w) in hints else v) for (aid, w), v in x.items())
    primary = sum(penalty)
    secondary = sum((1 - v if k in hints else v) for k, v in x.items()) if baseline else sum(finish.values())
    scale = len(x) + len(aids) * instance.weeks + 1
    model.minimize(primary * scale + secondary)

    def extract(engine):
        rows, occ, witness = [], [], {}
        active = defaultdict(list)
        for (aid, w), present in x.items():
            if engine.value(present):
                n = next(n for n in slots if engine.value(z[aid, w, n]))
                active[w].append((aid, n, engine.value(e[aid, w])))
        counters = defaultdict(int)
        for w, work in sorted(active.items()):
            local = defaultdict(set)
            for aid, n, _ in work:
                a = instance.activities[aid]
                local[a.contract_number, a.activity_type].add(n)
            for aid, n, ec in sorted(work):
                a = instance.activities[aid]
                counters[aid] += 1
                night = sorted(local[a.contract_number, a.activity_type]).index(n) + 1
                rows.append(Access(activity_id=aid, access_seq=counters[aid], week=w, eclo=ec, access_night=night))
                witness[f"{aid}:{w}"] = n + 1
                for loc in sorted(instance.routes[aid]):
                    occ.append(Occupancy(activity_id=aid, week=w, location_id=loc, co_share_group=f"p{n + 1}"))
        results = []
        for cid, p in instance.projects.items():
            last = max((r.week for r in rows if instance.activities[r.activity_id].contract_number == cid), default=0)
            completion = instance.week_end(last) if last else instance.start
            results.append(Completion(scenario=scenario, contract_number=cid, simulated_completion_date=completion, overrun_days=max(0, (completion - p.planned_completion_date).days)))
        return Schedule(scenario=scenario, access=rows, occupancy=occ, results=results, witness=witness)

    class Incumbents(cp_model.CpSolverSolutionCallback):
        best = None
        report = None
        count = 0
        # Exceptions do not propagate reliably out of an OR-Tools callback.
        # Record the disagreement, stop the search, and inspect after solve() returns.
        disagreement = None
        def on_solution_callback(self):
            candidate = extract(self)
            checked = validate(instance, candidate, overrides)
            # A priced B overrun is a deliberate last resort, not a modelling error: the
            # checker still reports it as a hard violation, and that report is kept intact.
            unexpected = [v for v in checked["hard_violations"] if not (scenario == "B" and v["rule"] == "planned_date")]
            if unexpected:
                self.disagreement = unexpected[:3]
                self.stop_search()
                return
            self.best, self.report = candidate, checked
            self.count += 1
            if callback:
                callback(candidate, checked, {"elapsed_seconds": round(time.monotonic() - started, 2), "solutions": self.count})

    engine = cp_model.CpSolver()
    engine.parameters.max_time_in_seconds = max(0.1, seconds - (time.monotonic() - started))
    engine.parameters.num_search_workers = max(1, min(32, int(os.getenv("NIGHTSHIFT_SOLVER_THREADS", "4"))))
    engine.parameters.random_seed = 42
    collector = Incumbents()
    finished = threading.Event()
    watcher = None
    if cancel_event is not None:
        def watch_cancellation():
            while not finished.wait(.1):
                if cancel_event.is_set():
                    engine.stop_search()
                    return
        watcher = threading.Thread(target=watch_cancellation, daemon=True)
        watcher.start()
    try:
        status = engine.solve(model, collector)
    finally:
        finished.set()
        if watcher:
            watcher.join(timeout=1)
    status_name = engine.status_name(status)
    result = {"instance_id": instance.id, "solver_status": status_name, "elapsed_seconds": round(time.monotonic() - started, 2), "solutions": collector.count,
              # A weighted objective is not in score units, so its bound says nothing about the score.
              "model_bound": max(0, int(engine.best_objective_bound // scale) / 10) if status in (cp_model.FEASIBLE, cp_model.OPTIMAL) and not weights else None,
              "schedule": collector.best.model_dump(mode="json") if collector.best else None,
              "validation": collector.report,
              "interpretation": "Local conservative temporal-witness model. Official validator unavailable."}
    if collector.report and scenario == "B" and any(v["rule"] == "planned_date" for v in collector.report["hard_violations"]):
        slipped = sum(1 for v in collector.report["hard_violations"] if v["rule"] == "planned_date")
        result["solver_status"] = "OPTIMAL_WITH_OVERRUN" if status == cp_model.OPTIMAL else status_name
        result["message"] = (f"No zero-overrun schedule exists here: {slipped} activities miss their planned completion date. "
                             "Supply levers were exhausted first, and the overrun shown is the least this model can achieve. "
                             "This submission would hard-fail a strict Scenario B check.")
    if collector.disagreement:
        # Earlier incumbents were independently validated, so they are retained and
        # remain safe to export; the search is simply no longer trustworthy past this point.
        result["solver_status"] = "CHECKER_DISAGREEMENT"
        result["error"] = "Solver/checker disagreement: " + str(collector.disagreement)
        result["message"] = "The model proposed a schedule the independent checker rejected; the search was stopped. Any schedule shown is the last checked incumbent."
    if scenario == "B" and not relax_deadline and status == cp_model.INFEASIBLE:
        # No zero-overrun schedule exists. Reopen the horizon and price the slip rather
        # than reporting an impossible case, spending whatever budget phase 1 left.
        remaining = max(1.0, seconds - (time.monotonic() - started))
        fallback = solve(instance, scenario, remaining, overrides, baseline, callback, cancel_event=cancel_event, relax_deadline=True, weights=weights)
        fallback["elapsed_seconds"] = round(time.monotonic() - started, 2)
        fallback["deadline_relaxed"] = True
        return fallback
    if status == cp_model.MODEL_INVALID:
        result["error"] = engine.solution_info()
    if not collector.best:
        result["message"] = "No complete schedule found within the search budget. Increase the budget or inspect demand and capacity." if status == cp_model.UNKNOWN else "No schedule satisfies this local model and the selected policy. Review the constraints; no workload has been dropped."
    return result
