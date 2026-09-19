"""Contractor access requests, assessed as what-ifs against an approved run.

Granting a contractor an extra possession at a location takes one unit of that
location's capacity from everyone else, so a request for weeks [from, to] is priced as
"capacity - 1 there in those weeks" and re-solved warm from the approved plan. The two
nearest windows of the same length where the location still has room are solved the
same way as counter-offers. Nothing here scores anything itself: every figure below is
read from runs scored by validate().
"""
from .domain import Instance, capacity_at


def request_overrides(instance: Instance, location_id: str, week_from: int, week_to: int, existing=()):
    return [{"location_id": location_id, "week": w, "capacity": max(0, capacity_at(instance, location_id, w, existing) - 1), "closed": False}
            for w in range(week_from, week_to + 1)]


def usage(baseline_run, location_id):
    return {c["week"]: (c["used"], c["capacity"]) for c in baseline_run["validation"]["capacity"] if c["location_id"] == location_id}


def alternatives(instance: Instance, baseline_run, location_id: str, week_from: int, week_to: int, count=2):
    """Nearest same-length windows, not overlapping the request, with a free slot every week."""
    span = week_to - week_from
    used = usage(baseline_run, location_id)
    free = lambda w: used.get(w, (0, instance.supply[location_id]))[0] < used.get(w, (0, instance.supply[location_id]))[1]
    starts = [s for s in range(1, instance.weeks - span + 1)
              if (s + span < week_from or s > week_to) and all(free(w) for w in range(s, s + span + 1))]
    return sorted(starts, key=lambda s: (abs(s - week_from), s))[:count]


def utilisation(baseline_run, instance: Instance, location_id: str, week_from: int, week_to: int, extra=0):
    used = usage(baseline_run, location_id)
    worst = 0
    for w in range(week_from, week_to + 1):
        u, cap = used.get(w, (0, instance.supply[location_id]))
        worst = max(worst, round(100 * (u + extra) / cap) if cap else (100 if u + extra == 0 else 999))
    return worst


def impact(baseline_run, run):
    if not run.get("schedule") or not run.get("validation"):
        return "HIGH"
    if not run["validation"]["feasible"]:
        return "HIGH"
    delta = run["validation"]["score"] - baseline_run["validation"]["score"]
    moved = len((run.get("diff") or {}).get("changed_activities", []))
    if delta < 0:
        return "BENEFICIAL"
    if delta == 0 and moved == 0:
        return "NONE"
    return "LOW" if delta < 5 else "MEDIUM" if delta < 20 else "HIGH"


TONE = {"NONE": "ok", "BENEFICIAL": "ok", "LOW": "ok", "MEDIUM": "warn", "HIGH": "crit"}


def option_points(baseline_run, run):
    if not run.get("schedule") or not run.get("validation"):
        return [{"tone": "bad", "text": run.get("message") or "No schedule could absorb this request."}]
    v, b = run["validation"], baseline_run["validation"]
    moved = len((run.get("diff") or {}).get("changed_activities", []))
    s, bs = v["soft_scores"], b["soft_scores"]
    points = [{"tone": "ok" if moved == 0 else "warn", "text": f"{moved} activit{'y' if moved == 1 else 'ies'} displaced"}]
    extra_over = s["overrun_days_total"] - bs["overrun_days_total"]
    if extra_over:
        points.append({"tone": "bad" if extra_over > 0 else "ok", "text": f"{extra_over:+d} overrun days across the book"})
    extra_eclo = s["eclo_nights_total"] - bs["eclo_nights_total"]
    if extra_eclo:
        points.append({"tone": "warn" if extra_eclo > 0 else "ok", "text": f"{extra_eclo:+d} ECLO accesses"})
    if not v["feasible"]:
        points.append({"tone": "bad", "text": f"{len(v['hard_violations'])} hard violations — cannot be issued"})
    return points


def displaced(instance: Instance, baseline_run, run):
    if not run.get("schedule") or not run.get("validation"):
        return []
    before = {c["contract_number"]: c["overrun_days"] for c in baseline_run["validation"]["contracts"]}
    after = {c["contract_number"]: c["overrun_days"] for c in run["validation"]["contracts"]}
    rows = []
    for aid in (run.get("diff") or {}).get("changed_activities", []):
        a = instance.activities.get(aid)
        if not a:
            continue
        slip = after.get(a.contract_number, 0) - before.get(a.contract_number, 0)
        rows.append({"activity_id": aid, "contract_number": a.contract_number,
                     "priority": instance.projects[a.contract_number].contract_priority,
                     "effect": f"{a.contract_number} {slip:+d} days" if slip else "moves within slack",
                     "tone": "crit" if slip > 0 else "ok"})
    return sorted(rows, key=lambda r: (r["tone"] != "crit", r["priority"], r["activity_id"]))


def draft_response(request, requested, best_alternative, moved=0, slipped=()):
    who = request.get("contractor") or request["contract_number"]
    weeks = lambda o: f"week {o['week_from']}" if o["week_from"] == o["week_to"] else f"weeks {o['week_from']}–{o['week_to']}"
    if requested["impact"] in ("NONE", "BENEFICIAL", "LOW"):
        knock_on = ""
        if moved:
            knock_on = f" {moved} other activit{'y' if moved == 1 else 'ies'} will be re-sequenced"
            knock_on += (f"; {', '.join(slipped)} will finish later as a result." if slipped
                         else " within existing slack, with no change to any completion date.")
        return (f"Dear {who}, your request for {request['request'].lower()} in {weeks(requested)} can be accommodated."
                f"{knock_on} It is approved subject to the usual possession arrangements.")
    if best_alternative:
        absorb = {"NONE": "without moving any other work", "BENEFICIAL": "and which improves the programme",
                  "LOW": "with minimal knock-on"}[best_alternative["impact"]]
        return (f"Dear {who}, {weeks(requested)} cannot be accommodated without displacing other booked work "
                f"({requested['impact'].lower()} impact on the programme). We can offer {weeks(best_alternative)} "
                f"instead, which the location can absorb {absorb}. Please confirm whether this works for your programme.")
    return (f"Dear {who}, {weeks(requested)} cannot be accommodated without displacing other booked work, and no "
            f"nearby window has spare capacity at this location. We will revisit the request at the next planning cycle.")
