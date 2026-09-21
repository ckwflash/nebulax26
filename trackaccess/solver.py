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
from .planning import Booking, Weights, check_planning, placements

# Scenario B overrun weight, in tenths like every other penalty term. Far above the
# 70/excess and 50/ECLO rates so B buys its dates with supply before it slips them.
DEADLINE_PRICE = 10_000


def solve(instance: Instance, scenario: str, seconds=90, overrides=(), baseline: Schedule | None = None, callback: Callable | None = None, cancel_event=None, relax_deadline=False, bookings=(), philosophy=None, weights=None, warm_start=None):
    if scenario not in ("A", "B", "C"):
        raise ValueError("Scenario must be A, B or C.")
    started = time.monotonic()
    weights = weights if isinstance(weights, Weights) else Weights(**(weights or {}))
    bookings = [b if isinstance(b, Booking) else Booking(**b) for b in bookings]
    if philosophy and baseline is None:
        raise ValueError("A recovery strategy requires a baseline.")
    # B is solved in two phases. Phase 1 keeps the deadline as a domain filter, which is
    # both fast and exactly the rule. Only when that proves INFEASIBLE does phase 2 reopen
    # the horizon and price the overrun, so a tight instance still returns a schedule
    # instead of nothing. Deciding this up front avoids building a model that cannot solve.
    if scenario == "B" and not relax_deadline and not philosophy:
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
    hint_schedule = warm_start or baseline
    hints = {(r.activity_id, r.week): r for r in hint_schedule.access} if hint_schedule else {}
    original = placements(baseline)
    for aid in aids:
        a = instance.activities[aid]
        p = instance.projects[a.contract_number]
        # A start beyond the horizon has no eligible week; never move it earlier.
        first = max(1, instance.week(a.planned_start_date))
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
            if hint_schedule:
                model.add_hint(x[aid, w], int((aid, w) in hints))
                model.add_hint(e[aid, w], hints[aid, w].eclo if (aid, w) in hints else 0)
                for n in slots:
                    model.add_hint(z[aid, w, n], int(hint_schedule.witness.get(f"{aid}:{w}") == n + 1))
        model.add(sum(2 * x[aid, w] + e[aid, w] for w in eligible) >= 2 * a.total_accesses)
        model.add(sum(2 * x[aid, w] + e[aid, w] for w in eligible) <= 2 * a.total_accesses + 1)
        if eligible:
            model.add_max_equality(finish[aid], [w * x[aid, w] for w in eligible])
        else:
            model.add_bool_or([])
    for (aid, w), present in x.items():
        pred = instance.activities[aid].predecessor_activity_id
        if pred:
            model.add(finish[pred] < w).only_enforce_if(present)

    for booking in bookings:
        model.add(sum(v for (aid, w), v in x.items() if aid == booking.activity_id and booking.week_from <= w <= booking.week_to) >= 1)
    if philosophy == 'p1':
        for aid in aids:
            if instance.activities[aid].activity_priority != 1:
                continue
            for w in weeks:
                old = next((ec for week, ec in original[aid] if week == w), None)
                if (aid, w) in x:
                    model.add(x[aid, w] == int(old is not None))
                    model.add(e[aid, w] == (old or 0))
                elif old is not None:
                    model.add_bool_or([])
    if philosophy == 'deadlines':
        deadlines = {row.contract_number: row.simulated_completion_date for row in baseline.results}
        for aid in aids:
            p = instance.projects[instance.activities[aid].contract_number]
            model.add(7 * finish[aid] - 1 <= (deadlines[p.contract_number] - instance.start).days)

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
        enters_closure = bool(instance.routes[i] & instance.protected[j] or instance.routes[j] & instance.protected[i])
        if enters_closure:
            for w in weeks:
                if (i, w) not in x or (j, w) not in x:
                    continue
                if sharing:
                    # The CSVs must prove co-possession through a shared local
                    # group. Different hidden opportunities do not waive a
                    # weekly closure in the submission checker.
                    for n in slots:
                        model.add(z[i, w, n] == z[j, w, n]).only_enforce_if([x[i, w], x[j, w]])
                else:
                    model.add(x[i, w] + x[j, w] <= 1)
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

    penalty, late_terms, p1_terms = [], [], []
    contract_late = {}
    for cid, p in instance.projects.items():
        members = [finish[aid] for aid in aids if instance.activities[aid].contract_number == cid]
        if not members:
            continue
        last = model.new_int_var(1, instance.weeks, f"contract_finish_{cid}")
        model.add_max_equality(last, members)
        late = model.new_int_var(0, max(0, (instance.week_end(instance.weeks) - p.planned_completion_date).days), f"contract_late_{cid}")
        model.add_max_equality(late, [0, 7 * last - 1 - (p.planned_completion_date - instance.start).days])
        contract_late[cid] = late
    for aid in aids:
        late = contract_late[instance.activities[aid].contract_number]
        late_terms.append(instance.weight10(aid) * late)
        if instance.activities[aid].activity_priority == 1:
            p1_terms.append(instance.weight10(aid) * late)
        if scenario == "B":
            # Phase 1 cannot be late by construction. In phase 2 this must dominate every
            # other term so a date slips only when no ECLO/excess combination can hit it.
            penalty.append(DEADLINE_PRICE * late)
        else:
            penalty.append(instance.weight10(aid) * late)
    if scenario != "A":
        penalty.extend([70 * v for v in excess_vars])
        penalty.extend([50 * v for v in e.values()])
    primary = sum(penalty)
    secondary = sum((1 - v if any(w == k[1] for w, _ in original[k[0]]) else v) for k, v in x.items()) if baseline else sum(finish.values())
    scale = len(x) + len(aids) * instance.weeks + 1
    changed = []
    for aid in aids:
        differences = []
        for w in weeks:
            old = next((ec for week, ec in original[aid] if week == w), None)
            if (aid, w) in x:
                differences.extend([1 - x[aid, w] if old is not None else x[aid, w],
                                    1 - e[aid, w] if old == 1 else e[aid, w]])
            elif old is not None:
                differences.append(1)
        flag = model.new_bool_var(f'changed_{aid}')
        model.add_max_equality(flag, differences or [0])
        changed.append(flag)
    churn = sum(changed)
    custom = (10 * weights.churn * churn + weights.deadlines * sum(late_terms)
              + 50 * weights.passengers * sum(e.values())
              + weights.priority1 * sum(p1_terms) + 70 * sum(excess_vars))
    objectives = ([('churn', churn), ('scenario_score_tenths', primary)] if philosophy == 'churn'
                  else [('custom_preferences', custom), ('churn', churn)] if philosophy == 'custom'
                  else [('scenario_score_tenths', primary), ('churn', churn)] if philosophy
                  else [('scenario_with_tiebreak', primary * scale + secondary)])
    model.minimize(objectives[0][1])

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
            checked = check_planning(instance, candidate, validate(instance, candidate, overrides), bookings, philosophy, baseline)
            # A priced B overrun is a deliberate last resort, not a modelling error: the
            # checker still reports it as a hard violation, and that report is kept intact.
            unexpected = [v for v in checked["hard_violations"] if not (scenario == "B" and not philosophy and v["rule"] == "planned_date")]
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
    stages = []
    try:
        status = cp_model.UNKNOWN
        for name, objective in objectives:
            remaining = seconds - (time.monotonic() - started)
            if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
                break
            model.minimize(objective)
            engine.parameters.max_time_in_seconds = remaining
            status = engine.solve(model, collector)
            stages.append({'name': name, 'status': engine.status_name(status),
                           'value': engine.objective_value if status in (cp_model.FEASIBLE, cp_model.OPTIMAL) else None,
                           'bound': engine.best_objective_bound if status in (cp_model.FEASIBLE, cp_model.OPTIMAL) else None})
            if status != cp_model.OPTIMAL or collector.disagreement:
                break
            model.add(objective == round(engine.objective_value))
    finally:
        finished.set()
        if watcher:
            watcher.join(timeout=1)
    status_name = engine.status_name(status)
    if collector.best and (status == cp_model.UNKNOWN or len(stages) < len(objectives)):
        status_name = "FEASIBLE"
    result = {"instance_id": instance.id, "solver_status": status_name, "elapsed_seconds": round(time.monotonic() - started, 2), "solutions": collector.count,
              "model_bound": max(0, int(engine.best_objective_bound // scale) / 10) if not philosophy and status in (cp_model.FEASIBLE, cp_model.OPTIMAL) else None,
              "schedule": collector.best.model_dump(mode="json") if collector.best else None,
              "validation": collector.report,
              "interpretation": "Local CSV closure and contract-overrun scoring model with auxiliary timing checks. Reproduces supplied validator evidence; official executable unavailable."}
    if philosophy:
        result['optimization'] = {'philosophy': philosophy, 'weights': weights.model_dump() if philosophy == 'custom' else None,
                                  'stages': stages, 'proven_optimal': status_name == 'OPTIMAL' and len(stages) == len(objectives)}
    if collector.report and scenario == "B" and any(v["rule"] == "planned_date" for v in collector.report["hard_violations"]):
        slipped = sum(1 for v in collector.report["hard_violations"] if v["rule"] == "planned_date")
        result["solver_status"] = "OPTIMAL_WITH_OVERRUN" if status == cp_model.OPTIMAL else status_name
        result["message"] = (f"No zero-overrun schedule exists here: {slipped} activities miss their planned completion date. " +
                             ("Supply levers were exhausted first. The least priced overrun is proven for this local model. " if status == cp_model.OPTIMAL else "Supply levers were exhausted first. This is a diagnostic incumbent; minimum overrun is not proven. ") +
                             "This submission would hard-fail a strict Scenario B check.")
    if collector.disagreement:
        # Earlier incumbents were independently validated, so they are retained and
        # remain safe to export; the search is simply no longer trustworthy past this point.
        result["solver_status"] = "CHECKER_DISAGREEMENT"
        result["error"] = "Solver/checker disagreement: " + str(collector.disagreement)
        result["message"] = "The model proposed a schedule the independent checker rejected; the search was stopped. Any schedule shown is the last checked incumbent."
    if scenario == "B" and not relax_deadline and not philosophy and status == cp_model.INFEASIBLE and (cancel_event is None or not cancel_event.is_set()):
        # No zero-overrun schedule exists. Reopen the horizon and price the slip rather
        # than reporting an impossible case, spending whatever budget phase 1 left.
        remaining = max(0, seconds - (time.monotonic() - started))
        if remaining <= 0:
            return result
        fallback = solve(instance, scenario, remaining, overrides, baseline, callback, cancel_event=cancel_event, relax_deadline=True, bookings=bookings, warm_start=warm_start)
        fallback["elapsed_seconds"] = round(time.monotonic() - started, 2)
        fallback["deadline_relaxed"] = True
        return fallback
    if status == cp_model.MODEL_INVALID:
        result["error"] = engine.solution_info()
    if not collector.best:
        result["message"] = "No complete schedule found within the search budget. Increase the budget or inspect demand and capacity." if status == cp_model.UNKNOWN else "No schedule satisfies this local model and the selected policy. Review the constraints; no workload has been dropped."
    return result
