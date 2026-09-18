"""Build reproducible PS1 test fixtures with independent, documented expectations.

This generator does not import the planner or obtain expected scores by solving.
"""
from __future__ import annotations

import copy
import csv
from datetime import date, timedelta
import hashlib
import io
import json
from pathlib import Path
import random
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "testdata"
SEED = 20260918
FILES = {
    "lines": "01_LINES.csv", "stations": "02_STATIONS.csv", "sectors": "03_SECTORS.csv",
    "supply": "04_LOCATION_SUPPLY.csv", "buffers": "05_BUFFER_LOCATION.csv",
    "parameters": "06_PARAMETERS.csv", "projects": "07_PROJECT_DETAILS.csv",
    "activities": "08_ACTIVITY_DETAILS.csv",
}
START = date(2027, 1, 4)


def csv_text(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def encode(tables):
    return {FILES[key]: csv_text(rows) for key, rows in tables.items()}


def zip_bytes(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)
    return stream.getvalue()


def network(weeks, capacity=4):
    tables = {key: [] for key in FILES}
    for line in ("X", "Y"):
        tables["lines"].append(dict(line_code=line, line_name=f"Synthetic {line}"))
        stations = [f"{line}0", "H1", "H2", f"{line}3"]
        for i, station in enumerate(stations):
            tables["stations"].append(dict(station_id=station, line_code=line, seq=i+1, is_interchange=int(station in ("H1", "H2"))))
            for bound in ("EB", "WB"):
                tables["supply"].append(dict(location_id=f"PLAT:{line}:{station}:{bound}", location_kind="platform sector", line_code=line, bound=bound, supply_capacity=capacity))
        for i, (a, b) in enumerate(zip(stations, stations[1:])):
            sid = f"SEC:{line}:{a}_{b}"
            tables["sectors"].append(dict(sector_id=sid, line_code=line, from_station_id=a, to_station_id=b, seq=i+1, is_shared=int(a == "H1" and b == "H2")))
            for bound in ("EB", "WB"):
                tables["supply"].append(dict(location_id=f"{sid}:{bound}", location_kind="tunnel sector", line_code=line, bound=bound, supply_capacity=capacity))
    tables["parameters"] = [dict(key="horizon_start", value=str(START)), dict(key="horizon_weeks", value=weeks)]
    tables["buffers"] = [dict(nature_of_works=n, up_to_buffer_sectors=r, opposite_bound_required=m) for n, r, m in
                         [("Live", 2, 1), ("Non-live (Consist)", 1, 0), ("Non-live (Others)", 0, 0)]]
    return tables


def add_job(tables, number, *, demand=1, start=1, deadline=1, priority=2,
            kind="C", nature="Non-live (Others)", location="SEC:X:X0_H1:EB", predecessor=""):
    cid, aid = f"C{number:03d}", f"A{number:03d}"
    end = str(START + timedelta(days=7*deadline-1))
    tables["projects"].append(dict(contract_number=cid, contract_description=f"Synthetic test contract {number}",
        contract_award_date="2026-01-01", activity_type="Renewal", nature_of_activity=nature,
        contract_priority=priority, contract_completion_date=end, planned_completion_date=end,
        number_of_workfronts=1, access_type=kind, number_of_maximum_access_per_week=2 if nature == "Live" else 3))
    tables["activities"].append(dict(activity_id=aid, contract_number=cid, activity_type="Renewal",
        start_location_id=location, end_location_id=location, total_accesses=demand,
        planned_start_date=str(START + timedelta(days=7*(start-1))), predecessor_activity_id=predecessor, activity_priority=3))


def public_tables():
    return {key: list(csv.DictReader(io.StringIO((ROOT / "PS1/01_data" / name).read_text()))) for key, name in FILES.items()}


def independent_a_bound(tables):
    """Earliest standard-only finishes ignoring resource competition (a lower bound)."""
    params = {r["key"]: r["value"] for r in tables["parameters"]}
    origin = date.fromisoformat(params["horizon_start"])
    jobs = {r["activity_id"]: r for r in tables["activities"]}
    projects = {r["contract_number"]: r for r in tables["projects"]}
    finishes = {}

    def finish(aid):
        if aid not in finishes:
            job = jobs[aid]
            first = max(1, (date.fromisoformat(job["planned_start_date"]) - origin).days // 7 + 1)
            if job["predecessor_activity_id"]:
                first = max(first, finish(job["predecessor_activity_id"]) + 1)
            finishes[aid] = first + int(job["total_accesses"]) - 1
        return finishes[aid]

    tenths = 0
    for aid, job in jobs.items():
        project = projects[job["contract_number"]]
        late = max(0, (origin + timedelta(days=7*finish(aid)-1) - date.fromisoformat(project["planned_completion_date"])).days)
        tenths += late * {1: 100, 2: 10, 3: 1}[int(project["contract_priority"])] * {1: 13, 2: 12, 3: 10}[int(job["activity_priority"])]
    return tenths / 10


def independent_c_bound(tables):
    """Relax resources/precedence; enumerate 0–2 ECLO accesses per activity.

    C's two-week continuity rule and one access/week permit at most two ECLO
    accesses per activity. Ignoring conflicts can only lower the minimum cost.
    """
    params = {r["key"]: r["value"] for r in tables["parameters"]}
    origin = date.fromisoformat(params["horizon_start"])
    projects = {r["contract_number"]: r for r in tables["projects"]}
    total = 0
    for job in tables["activities"]:
        project = projects[job["contract_number"]]
        first = max(1, (date.fromisoformat(job["planned_start_date"]) - origin).days // 7 + 1)
        weight = {1: 100, 2: 10, 3: 1}[int(project["contract_priority"])] * {1: 13, 2: 12, 3: 10}[int(job["activity_priority"])]
        alternatives = []
        for eclo in range(3):
            accesses = (2 * int(job["total_accesses"]) - eclo + 1) // 2
            if accesses < eclo:
                continue
            end = origin + timedelta(days=7 * (first + accesses - 1) - 1)
            late = max(0, (end - date.fromisoformat(project["planned_completion_date"])).days)
            alternatives.append(late * weight + 50 * eclo)
        total += min(alternatives)
    return total / 10


def duplicate_network(source):
    """Two disjoint copies: no shared IDs, resources, contracts or ECLO windows."""
    output = {key: [] for key in FILES}
    output["parameters"] = copy.deepcopy(source["parameters"])
    output["buffers"] = copy.deepcopy(source["buffers"])
    for replica in (1, 2):
        line_map = {r["line_code"]: f"D{replica}{r['line_code']}" for r in source["lines"]}
        station_map = {r["station_id"]: f"D{replica}{r['station_id']}" for r in source["stations"]}
        sector_map = {r["sector_id"]: f"SEC:{line_map[r['line_code']]}:{station_map[r['from_station_id']]}_{station_map[r['to_station_id']]}" for r in source["sectors"]}
        contract_map = {r["contract_number"]: f"C{replica}{r['contract_number'][1:]}" for r in source["projects"]}
        activity_map = {r["activity_id"]: f"A{replica}{r['activity_id'][1:]}" for r in source["activities"]}

        def location(old):
            kind, line, body, bound = old.split(":")
            return f"{sector_map[f'SEC:{line}:{body}']}:{bound}" if kind == "SEC" else f"PLAT:{line_map[line]}:{station_map[body]}:{bound}"

        for key in ("lines", "stations", "sectors", "supply", "projects", "activities"):
            for original in source[key]:
                row = original.copy()
                if "line_code" in row:
                    row["line_code"] = line_map[row["line_code"]]
                for field in ("station_id", "from_station_id", "to_station_id"):
                    if field in row:
                        row[field] = station_map[row[field]]
                if "sector_id" in row:
                    row["sector_id"] = sector_map[row["sector_id"]]
                for field in ("location_id", "start_location_id", "end_location_id"):
                    if field in row:
                        row[field] = location(row[field])
                if "contract_number" in row:
                    row["contract_number"] = contract_map[row["contract_number"]]
                for field in ("activity_id", "predecessor_activity_id"):
                    if row.get(field):
                        row[field] = activity_map[row[field]]
                output[key].append(row)
    return output


def build_cases():
    cases = []

    def add(slug, title, tables, scores, proof, features, *, oracle="analytic", feasible=True):
        expected = {s: {"feasible": feasible, **({"score": scores[i]} if scores[i] is not None else {})} for i, s in enumerate("ABC")}
        cases.append(dict(slug=slug, title=title, files=encode(tables), expected=expected,
                          oracle=oracle, proof=proof, features=features,
                          activities=len(tables["activities"]), contracts=len(tables["projects"]),
                          workload=sum(int(r["total_accesses"]) for r in tables["activities"])))

    t = network(4)
    for i, loc in enumerate(("SEC:X:X0_H1:EB", "SEC:X:H2_X3:WB", "SEC:Y:Y0_H1:EB"), 101):
        add_job(t, i, demand=2, deadline=4, location=loc)
    add("01_slack_baseline", "Slack baseline", t, (0, 0, 0), "All jobs can finish in weeks 1–2 without extra supply or ECLO. Scores are nonnegative, so zero is optimal.", ["zero-cost baseline", "two lines", "full workload"])

    t = network(3)
    add_job(t, 201, demand=3, deadline=2)
    add("02_eclo_deadline", "ECLO versus deadline slip", t, (70, 10, 10), "Three units require three standard weeks: A incurs 7 days × P2 weight 10 = 70. Two ECLO accesses deliver exactly three units by week 2 for cost 10 in B/C.", ["ECLO yield", "deadline", "scenario trade-off"])

    t = network(2, capacity=1)
    for i in range(301, 306):
        add_job(t, i)
    add("03_sharing_limit", "Five compatible jobs, four sharing places", t, (70, 21, 21), "Only four jobs fit a possession. A delays one job one week (70). B/C buy a second possession at one sector and two platforms: 3 × 7 = 21.", ["sharing limit of four", "location accounting", "supply congestion"])

    t = network(3, capacity=1)
    for i, kind in enumerate(("PM", "PC", "PC"), 401):
        add_job(t, i, kind=kind)
    add("04_exclusive_mixes", "PM isolation and PC incompatibility", t, (210, 42, 91), "The three jobs require separate possessions. A completes in weeks 1/2/3: (0+7+14) × 10 = 210. B buys two extra possessions at three locations (42). C permits one extra: two jobs in week 1 and one in week 2 cost 21+70=91.", ["PM exclusive", "PC cannot share with PC", "C excess cap"])

    t = network(5)
    add_job(t, 501, demand=2, deadline=2)
    add_job(t, 502, demand=2, deadline=4, predecessor="A501")
    add_job(t, 503, deadline=5, predecessor="A502")
    add("05_predecessor_chain", "Cross-contract strict precedence", t, (0, 0, 0), "A501 takes weeks 1–2, A502 weeks 3–4, A503 week 5. This meets each deadline with zero cost. Every successor must start in a strictly later week.", ["FS+0", "cross-contract references", "boundary dates"])

    t = network(1)
    add_job(t, 601, nature="Live", location="SEC:X:H1_H2:EB")
    add_job(t, 602, nature="Live", location="SEC:Y:H1_H2:WB")
    add("06_live_interchange", "Live protection through an interchange", t, (0, 0, 0), "Two different opportunities in week 1 deliver both jobs without ECLO or excess. Their mirrored cross-line protection intersects, so assigning the same opportunity must be rejected.", ["opposite-bound mirror", "cross-line protection", "timing witness"])

    t = network(6)
    add_job(t, 701, demand=3, deadline=2)
    add_job(t, 702, demand=3, start=4, deadline=5)
    add("07_eclo_window", "Separated demand peaks on one line", t, (140, 20, 80), "A has two one-week P2 delays: 140. B uses ECLO in weeks 1/2 and 4/5 for 20. C can use only one two-week window on X: compress one job for 10 and delay the other for 70. ECLO on just one access cannot remove either delay.", ["C continuity window", "two demand peaks", "B versus C"])

    t = public_tables()
    rng = random.Random(SEED)
    for row in t["projects"]:
        row["contract_priority"] = str(rng.randint(1, 3))
        if row["contract_number"] in ("C006", "C010"):
            row["contract_priority"] = "1"
    for row in t["activities"]:
        row["activity_priority"] = str(rng.randint(1, 3))
    add("08_priority_pressure", "Public network with high-priority bottlenecks", t, (independent_a_bound(t), 30, independent_c_bound(t)), "Seed 20260918 changes only priority weights and promotes C006/C010 to P1. Feasibility is preserved. The resource-free standard-work A bound is 2240; B's objective is unchanged at 30. C permits at most two ECLO accesses per activity: independently minimizing each activity's delay plus 0/1/2 ECLO costs gives a resource-free lower bound of 720. Valid schedules attain both A/C bounds, proving optimality without relying on CP-SAT's status alone.", ["54 activities", "weighted priorities", "realistic regression"], oracle="analytical A/C lower bounds; invariant B")

    t = duplicate_network(public_tables())
    add("09_double_network", "Two independent copies of the public network", t, (50.4, 60, 50.4), "Duplicate every identifier and network resource into two disjoint components. Each feasible solution restricts to a feasible original solution, and two original solutions combine. Scores add, so optima are exactly twice the certified public scores. This is a scale test, not a claim of doubled congestion.", ["108 activities", "384 work units", "four lines", "scale and separability"], oracle="compositional from certified public optima")

    t = network(2)
    add_job(t, 1001, demand=4, deadline=2)
    add("10_impossible_workload", "Impossible workload within the horizon", t, (None, None, None), "One activity needs four units in two weeks. With at most one access per week, even ECLO can deliver only 2 × 1.5 = 3 units. All scenarios must report INFEASIBLE with no partial schedule or export.", ["expected infeasibility", "no dropped workload", "export blocked"], feasible=False)
    return cases


def main():
    cases = build_cases()
    manifest = {"version": 1, "seed": SEED, "authority": "local model; official validator unavailable", "cases": []}
    for case in cases:
        folder = DEST / "datasets" / case["slug"]
        folder.mkdir(parents=True, exist_ok=True)
        for filename, content in case["files"].items():
            (folder / filename).write_text(content)
        archive = zip_bytes(case["files"])
        (DEST / "zips").mkdir(parents=True, exist_ok=True)
        (DEST / "zips" / f"{case['slug']}.zip").write_bytes(archive)
        manifest["cases"].append({k: v for k, v in case.items() if k != "files"} | {"zip_sha256": hashlib.sha256(archive).hexdigest()})
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    bundle = {f"datasets/{case['slug']}.zip": (DEST / "zips" / f"{case['slug']}.zip").read_bytes() for case in cases}
    bundle["manifest.json"] = (DEST / "manifest.json").read_bytes()
    if (DEST / "README.md").exists():
        bundle["README.md"] = (DEST / "README.md").read_bytes()
    if (DEST / "TEST_RESULTS.md").exists():
        bundle["TEST_RESULTS.md"] = (DEST / "TEST_RESULTS.md").read_bytes()
    for mode in ("local", "hosted", "hosted-extended", "hosted-post-fix"):
        report = DEST / "results" / mode / "REPORT.md"
        if report.exists():
            bundle[f"reports/{mode}.md"] = report.read_bytes()
    (DEST / "nightshift-test-datasets.zip").write_bytes(zip_bytes(bundle))
    print(f"Generated {len(cases)} datasets and reproducible ZIPs in {DEST}")


if __name__ == "__main__":
    main()
