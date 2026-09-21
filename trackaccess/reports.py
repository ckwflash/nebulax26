"""Printable document pack rendered from a stored run.

Every figure comes from the run's `validation` and `schedule`; nothing here re-solves or
re-scores. Output is self-contained HTML with print styles, so "Save as PDF" in any
browser produces the paper version.
"""
from collections import defaultdict
from datetime import date, timedelta
from html import escape

from .domain import Instance

CATALOG = [
    {"id": "management-summary", "name": "Management summary", "audience": "For the executive team",
     "description": "Feasibility, delays, priority impacts, ECLO use and the most congested locations.",
     "size_hint": "1–2 pages"},
    {"id": "risk-resilience", "name": "Risk & resilience report", "audience": "For the planning team",
     "description": "Location-weeks at capacity, the busiest weeks, and contracts with no slack left.",
     "size_hint": "2–3 pages"},
    {"id": "contractor-access-pack", "name": "Contractor access pack", "audience": "For each contractor",
     "description": "One section per contract: booked access nights by week, locations and weekly limits.",
     "size_hint": "1 page per contract"},
    {"id": "delay-eclo-register", "name": "Delay and ECLO register", "audience": "For commercial review",
     "description": "Every contract's completion against deadline, and every ECLO access in the plan.",
     "size_hint": "1–2 pages"},
]
REPORT_IDS = {r["id"] for r in CATALOG}
PRIORITY = {1: "P1", 2: "P2", 3: "P3"}

STYLE = """
:root{--ink:#14213a;--muted:#5b6578;--line:#dfe3ea;--ok:#176842;--warn:#8a5a00;--bad:#a12a22;--band:#f5f7fa}
*{box-sizing:border-box}
body{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:#fff;margin:0;padding:32px 40px;max-width:1000px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
h3{font-size:13.5px;margin:18px 0 6px}
.meta{color:var(--muted);font-size:12px;margin-bottom:18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.tile{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.tile b{display:block;font-size:19px}.tile span{color:var(--muted);font-size:11.5px}
table{border-collapse:collapse;width:100%;margin:6px 0 4px;font-size:12px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--band);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.note{color:var(--muted);font-size:11.5px}
.banner{border:1px solid var(--bad);color:var(--bad);border-radius:6px;padding:8px 12px;margin:10px 0}
.section{break-inside:avoid}.page{break-before:page}
@media print{body{padding:0}.noprint{display:none}}
"""


def _week_range(instance: Instance, week: int) -> str:
    first = instance.start + timedelta(days=(week - 1) * 7)
    return f"{first:%d %b} – {instance.week_end(week):%d %b %Y}"


def _loc(location_id: str) -> str:
    """SEC:ALP:S01_S02:EB -> ALP S01–S02 EB; PLAT:BET:S15:EB -> BET S15 platform EB."""
    parts = location_id.split(":")
    if len(parts) != 4:
        return location_id
    kind, line, body, bound = parts
    return f"{line} {body.replace('_', '–')} {bound}" if kind == "SEC" else f"{line} {body} platform {bound}"


def _table(headers, rows, numeric=()):
    head = "".join(f'<th class="n">{escape(h)}</th>' if i in numeric else f"<th>{escape(h)}</th>" for i, h in enumerate(headers))
    body = "".join(
        "<tr>" + "".join(f'<td class="n">{c}</td>' if i in numeric else f"<td>{c}</td>" for i, c in enumerate(r)) + "</tr>"
        for r in rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body or '<tr><td colspan=99 class=note>None.</td></tr>'}</tbody></table>"


def _tiles(items):
    return '<div class="tiles">' + "".join(f"<div class=tile><b>{v}</b><span>{escape(k)}</span></div>" for k, v in items) + "</div>"


def _page(title, instance, run, body):
    v = run["validation"]
    status = "Feasible" if v["feasible"] else f"{len(v['hard_violations'])} hard violations"
    banner = "" if v["feasible"] else (
        '<div class="banner">This plan is not feasible and must not be issued. '
        f"{len(v['hard_violations'])} hard violation(s) remain.</div>")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title><style>{STYLE}</style></head><body>
<h1>{escape(title)}</h1>
<div class="meta">{escape(instance.name)} · Scenario {escape(run['scenario'])} · {escape(status)} · run <span class="mono">{escape(run['id'])}</span>
 · horizon {instance.start:%d %b %Y}, {instance.weeks} weeks · generated {date.today():%d %b %Y}</div>
<p class="note">Local validation · rule {escape(str(v["rule_version"]))}. Official judging acceptance is separate.</p>
<div class="noprint note">Use your browser's Print → Save as PDF for a paper copy.</div>
{banner}{body}</body></html>"""


def _contract_rows(instance, v):
    rows = []
    for c in sorted(v["contracts"], key=lambda c: (-c["overrun_days"], c["priority"], c["contract_number"])):
        p = instance.projects.get(c["contract_number"])
        late = c["overrun_days"]
        rows.append([
            f'<span class="mono">{escape(c["contract_number"])}</span>',
            escape(p.contract_description if p else ""),
            PRIORITY.get(c["priority"], str(c["priority"])),
            escape(str(c["planned_completion_date"])),
            escape(str(c["simulated_completion_date"])),
            f'<span class="{"bad" if late else "ok"}">{late}</span>',
        ])
    return rows


def management_summary(instance: Instance, run) -> str:
    v, s = run["validation"], run["validation"]["soft_scores"]
    late = [c for c in v["contracts"] if c["overrun_days"] > 0]
    by_priority = s.get("priority_overrun", {})
    tiles = _tiles([
        ("Objective score (lower is better)", v["score"]),
        ("Activities scheduled", f"{v['completed_activities']}/{v['total_activities']}"),
        ("Contracts overrunning", s["contracts_overrunning"]),
        ("Total overrun days", s["overrun_days_total"]),
        ("ECLO accesses", s["eclo_nights_total"]),
        ("Excess access nights", s["excess_access_nights_total"]),
    ])
    bound = instance.lower_bounds().get(run["scenario"])
    gap = (f"<p>No plan for this scenario can score below <b>{bound}</b>; this plan scores "
           f"<b>{v['score']}</b>{' — it has reached the bound.' if bound is not None and v['score'] <= bound else '.'}</p>"
           if bound is not None else "")
    pri = _table(["Priority", "Overrun days"], [[PRIORITY.get(int(k), k), n] for k, n in sorted(by_priority.items())], numeric=(1,))
    full = sorted((c for c in v["capacity"] if c["used"] >= c["capacity"] > 0), key=lambda c: (c["location_id"], c["week"]))
    per_loc = defaultdict(int)
    for c in full:
        per_loc[c["location_id"]] += 1
    top = sorted(per_loc.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    body = f"""{tiles}{gap}
<div class="section"><h2>Late contracts</h2>
{_table(["Contract", "Description", "Priority", "Planned", "Simulated", "Days late"], _contract_rows(instance, {"contracts": late}), numeric=(5,))}</div>
<div class="section"><h2>Overrun by priority</h2>{pri}</div>
<div class="section"><h2>Most congested locations</h2>
<p class="note">Weeks in which the location is booked to its full nominal capacity.</p>
{_table(["Location", "Weeks at capacity"], [[escape(_loc(l)), n] for l, n in top], numeric=(1,))}</div>
<div class="section"><h2>Checks</h2>
{_table(["Check", "Result"], [
        ["Structurally valid", "Yes" if v["structurally_valid"] else '<span class="bad">No</span>'],
        ["Safety witness verified", "Yes" if v["safety_verified"] else '<span class="bad">No</span>'],
        ["Hard violations", len(v["hard_violations"])],
        ["Rule version", escape(str(v["rule_version"]))],
    ])}</div>"""
    return _page("Management summary", instance, run, body)


def risk_resilience(instance: Instance, run) -> str:
    v = run["validation"]
    cap = v["capacity"]
    full = [c for c in cap if c["used"] >= c["capacity"] > 0]
    over = [c for c in cap if c["excess"] > 0]
    weekly = defaultdict(lambda: [0, 0])
    for c in cap:
        weekly[c["week"]][0] += c["used"]
        weekly[c["week"]][1] += c["capacity"]
    busiest = sorted(weekly.items(), key=lambda kv: (-(kv[1][0] / kv[1][1] if kv[1][1] else 0), kv[0]))[:8]
    # On time, but finishing in the very week of the planned date: any slip makes it late.
    tight = [c for c in v["contracts"] if c["overrun_days"] == 0
             and c["completion_week"] >= instance.week(date.fromisoformat(str(c["planned_completion_date"])))]
    week_rows = [[w, _week_range(instance, w), used, total, f"{(used / total * 100 if total else 0):.0f}%"] for w, (used, total) in busiest]
    body = f"""{_tiles([
        ("Location-weeks at capacity", len(full)),
        ("Location-weeks over nominal supply", len(over)),
        ("Late contracts", sum(1 for c in v["contracts"] if c["overrun_days"] > 0)),
        ("On-time contracts with no slack", len(tight)),
    ])}
<p class="note">A location-week at capacity cannot absorb a slipped access without displacing other work.
The RailPlan Risk tab adds per-activity fragility scores on top of these figures.</p>
<div class="section"><h2>Busiest weeks</h2>
{_table(["Week", "Dates", "Bookings", "Capacity", "Utilisation"], week_rows, numeric=(0, 2, 3, 4))}</div>
<div class="section"><h2>Location-weeks over nominal supply</h2>
{_table(["Location", "Week", "Used", "Capacity", "Excess"], [[escape(_loc(c["location_id"])), c["week"], c["used"], c["capacity"], f'<span class="bad">{c["excess"]}</span>'] for c in sorted(over, key=lambda c: (c["week"], c["location_id"]))], numeric=(1, 2, 3, 4))}</div>
<div class="section"><h2>Location-weeks at capacity</h2>
{_table(["Location", "Week", "Dates", "Used / capacity"], [[escape(_loc(c["location_id"])), c["week"], _week_range(instance, c["week"]), f'{c["used"]} / {c["capacity"]}'] for c in sorted(full, key=lambda c: (c["location_id"], c["week"]))], numeric=(1,))}</div>
<div class="section"><h2>Contracts with no slack</h2>
{_table(["Contract", "Description", "Priority", "Planned", "Simulated", "Days late"], _contract_rows(instance, {"contracts": tight}), numeric=(5,))}</div>"""
    return _page("Risk & resilience report", instance, run, body)


def contractor_access_pack(instance: Instance, run) -> str:
    v, sched = run["validation"], run["schedule"]
    result = {c["contract_number"]: c for c in v["contracts"]}
    nights = defaultdict(list)
    for a in sched["access"]:
        nights[a["activity_id"]].append(a)
    places = defaultdict(set)
    for o in sched["occupancy"]:
        places[o["activity_id"], o["week"]].add(o["location_id"])
    sections = []
    for i, (number, p) in enumerate(sorted(instance.projects.items())):
        c = result.get(number, {})
        contractor = getattr(p, "contractor", None) or p.contract_description
        rows = []
        for aid, act in sorted(instance.activities.items()):
            if act.contract_number != number:
                continue
            for a in sorted(nights[aid], key=lambda a: (a["week"], a["access_night"])):
                where = sorted(places[aid, a["week"]])
                rows.append([
                    f'<span class="mono">{escape(aid)}</span>', a["week"], _week_range(instance, a["week"]),
                    a["access_night"], '<span class="warn">ECLO</span>' if a["eclo"] else "Standard",
                    escape(", ".join(_loc(l) for l in where) or "—"),
                ])
        late = c.get("overrun_days", 0)
        sections.append(f"""<div class="{'page' if i else ''}"><h2>{escape(number)} · {escape(contractor)}</h2>
<p>{escape(p.activity_type)} · {escape(p.nature_of_activity)} · {PRIORITY.get(p.contract_priority, p.contract_priority)} ·
access type {escape(p.access_type)} · at most <b>{p.number_of_maximum_access_per_week}</b> accesses per week ·
{p.number_of_workfronts} workfront(s)</p>
<p>Planned completion <b>{p.planned_completion_date:%d %b %Y}</b> · simulated completion
<b>{escape(str(c.get("simulated_completion_date", "—")))}</b> ·
<span class="{'bad' if late else 'ok'}">{f"{late} days late" if late else "on time"}</span></p>
{_table(["Activity", "Week", "Dates", "Night slot", "Type", "Locations"], rows, numeric=(1, 3))}</div>""")
    return _page("Contractor access pack", instance, run, "".join(sections))


def delay_eclo_register(instance: Instance, run) -> str:
    v, sched = run["validation"], run["schedule"]
    eclo = sorted((a for a in sched["access"] if a["eclo"]), key=lambda a: (a["week"], a["activity_id"]))
    body = f"""{_tiles([
        ("Contracts overrunning", v["soft_scores"]["contracts_overrunning"]),
        ("Total overrun days", v["soft_scores"]["overrun_days_total"]),
        ("ECLO accesses", len(eclo)),
    ])}
<div class="section"><h2>Completion against deadline</h2>
{_table(["Contract", "Description", "Priority", "Planned", "Simulated", "Days late"], _contract_rows(instance, v), numeric=(5,))}</div>
<div class="section"><h2>ECLO accesses</h2>
<p class="note">Each row is one access taken as an ECLO; the solver uses ECLO only where standard access could not deliver the work on time.</p>
{_table(["Activity", "Contract", "Week", "Dates", "Night slot"], [[
        f'<span class="mono">{escape(a["activity_id"])}</span>',
        escape(instance.activities[a["activity_id"]].contract_number) if a["activity_id"] in instance.activities else "—",
        a["week"], _week_range(instance, a["week"]), a["access_night"]] for a in eclo], numeric=(2, 4))}</div>"""
    return _page("Delay and ECLO register", instance, run, body)


RENDERERS = {
    "management-summary": management_summary,
    "risk-resilience": risk_resilience,
    "contractor-access-pack": contractor_access_pack,
    "delay-eclo-register": delay_eclo_register,
}


def render(report_id: str, instance: Instance, run) -> str:
    return RENDERERS[report_id](instance, run)
