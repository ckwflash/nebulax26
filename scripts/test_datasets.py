"""Run the fixture matrix locally or through the deployed upload/solve/export API."""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import zipfile

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from trackaccess.domain import FILES, Instance, Schedule
from trackaccess.export import export_zip, read_schedule, save_schedule
from trackaccess.solver import solve
from trackaccess.validation import validate


def check_result(case, scenario, instance, result, folder):
    expected = case["expected"][scenario]
    if not expected["feasible"]:
        assert result["solver_status"] == "INFEASIBLE", result["solver_status"]
        assert not result.get("schedule"), "An impossible instance returned a partial schedule"
        return {"score": None, "bound": result.get("model_bound"), "coverage": None, "optimal": False, "primary_optimal": False, "proven_infeasible": True}
    assert result["solver_status"] in ("OPTIMAL", "FEASIBLE"), result["solver_status"]
    assert result.get("schedule"), "No complete schedule returned"
    schedule = Schedule(**result["schedule"])
    checked = validate(instance, schedule)
    assert checked["feasible"] and checked["safety_verified"], checked["hard_violations"]
    assert checked["coverage_percent"] == 100
    if "score" in expected:
        assert checked["score"] == expected["score"], f"Score {checked['score']} != independent expectation {expected['score']}"
    if result["solver_status"] == "OPTIMAL":
        assert result["model_bound"] == checked["score"], "Optimal score/bound disagree"
    # Check conservation directly as well as through the validator.
    delivered = defaultdict(int)
    for access in schedule.access:
        delivered[access.activity_id] += 2 + access.eclo
    assert set(delivered) == set(instance.activities)
    for aid, job in instance.activities.items():
        assert 2 * job.total_accesses <= delivered[aid] <= 2 * job.total_accesses + 1
    if case["slug"] == "06_live_interchange":
        assert all(set(instance.affected_lines[a]) == {"X", "Y"} for a in instance.activities)
        assert len(set(schedule.witness.values())) == 2
        forged = schedule.model_copy(deep=True)
        forged.witness = dict.fromkeys(forged.witness, 1)
        assert "closure" in {v["rule"] for v in validate(instance, forged)["hard_violations"]}
    if case["slug"] == "05_predecessor_chain":
        for pred, successor in (("A501", "A502"), ("A502", "A503")):
            assert max(r.week for r in schedule.access if r.activity_id == pred) < min(r.week for r in schedule.access if r.activity_id == successor)
    if case["slug"] == "07_eclo_window" and scenario == "C":
        weeks = [r.week for r in schedule.access if r.eclo]
        assert len(weeks) == 2 and max(weeks) - min(weeks) <= 1
    save_schedule(schedule, folder)
    roundtrip = validate(instance, read_schedule(folder))
    assert roundtrip["feasible"] and roundtrip["score"] == checked["score"]
    return {"score": checked["score"], "bound": result.get("model_bound"), "coverage": checked["coverage_percent"],
            "optimal": result["solver_status"] == "OPTIMAL", "proven_infeasible": False,
            "primary_optimal": "score" in expected or result["solver_status"] == "OPTIMAL",
            "independent_expected_score": expected.get("score")}


def check_zip(blob, folder):
    names = {"SCHEDULE_ACCESS.csv", "SCHEDULE_OCCUPANCY.csv", "RESULTS.csv"}
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert set(archive.namelist()) == names and len(archive.namelist()) == 3
        assert archive.testzip() is None
        for name in names:
            assert archive.read(name).decode() == (folder / name).read_text(), f"Export content mismatch: {name}"


def write_reports(report, dest):
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [f"# Nightshift {report['mode']} dataset test results", "", f"Run: {report['started_at']}", "",
             "Scores and proofs apply to the documented local model. The official validator is unavailable.", "",
             "| Dataset | Scenario | Result | Score | Bound | Solver seconds | Coverage |", "|---|---|---|---:|---:|---:|---:|"]
    for row in report["runs"]:
        values = ["—" if row.get(key) is None else str(row[key]) for key in ("score", "bound", "elapsed_seconds", "coverage")]
        lines.append(f"| {row['dataset']} | {row['scenario']} | {row.get('solver_status', 'ERROR') if row['passed'] else 'FAIL: '+row['error']} | " + " | ".join(values) + " |")
    passed = sum(r["passed"] for r in report["runs"])
    lines.extend(["", f"Checks passed: {passed}/{len(report['runs'])}. Complete schedules: {sum(r.get('coverage') == 100 for r in report['runs'])}. Proven primary-score optima: {sum(r.get('primary_optimal', False) for r in report['runs'])}. Full CP-SAT OPTIMAL status: {sum(r.get('optimal', False) for r in report['runs'])}. Proven infeasible: {sum(r.get('proven_infeasible', False) for r in report['runs'])}.", "",
                  "A feasible schedule attaining an independent lower bound proves the primary score optimal even if CP-SAT is still working on its secondary tie-break objective.", ""])
    if report.get("note"):
        lines.extend([report["note"], ""])
    (dest / "REPORT.md").write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", help="Hosted URL; omit to solve locally")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--only", nargs="*", help="Optional dataset slug filter")
    parser.add_argument("--scenarios", nargs="+", choices=list("ABC"), default=list("ABC"))
    parser.add_argument("--out", type=Path, help="Separate report folder for focused or longer-budget runs")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "testdata/manifest.json").read_text())
    mode = "hosted" if args.url else "local"
    dest = args.out or ROOT / "testdata/results" / mode
    report = {"mode": mode, "started_at": datetime.now(timezone.utc).isoformat(), "budget_seconds": args.seconds,
              "url": args.url, "local_solver_threads": int(os.getenv("NIGHTSHIFT_SOLVER_THREADS", "4")) if not args.url else None,
              "runs": []}
    client = httpx.Client(base_url=args.url, timeout=45) if args.url else None
    if client:
        health = client.get("/api/health")
        health.raise_for_status()
        report["health"] = health.json()
    try:
        for case in manifest["cases"]:
            if args.only and case["slug"] not in args.only:
                continue
            folder = ROOT / "testdata/datasets" / case["slug"]
            instance = Instance.from_directory(folder)
            archive = (ROOT / "testdata/zips" / f"{case['slug']}.zip").read_bytes()
            assert hashlib.sha256(archive).hexdigest() == case["zip_sha256"]
            with zipfile.ZipFile(io.BytesIO(archive)) as opened:
                assert set(opened.namelist()) == set(FILES.values()) and len(opened.namelist()) == 8
                assert {n: opened.read(n).decode() for n in opened.namelist()} == instance.files
            if client:
                response = client.post("/api/instances", files={"files": (f"{case['slug']}.zip", archive, "application/zip")})
                response.raise_for_status()
                assert response.json()["id"] == instance.id
            for scenario in args.scenarios:
                row = {"dataset": case["slug"], "scenario": scenario, "passed": False}
                started = time.monotonic()
                output = dest / case["slug"] / scenario
                output.mkdir(parents=True, exist_ok=True)
                try:
                    if client:
                        response = client.post("/api/runs", json={"instance_id": instance.id, "scenario": scenario,
                            "seconds": args.seconds, "label": f"Test {case['slug']} · {scenario}"})
                        response.raise_for_status()
                        run_id = response.json()["id"]
                        row["run_id"] = run_id
                        deadline = time.monotonic() + args.seconds + 180
                        while True:
                            response = client.get(f"/api/runs/{run_id}")
                            response.raise_for_status()
                            result = response.json()
                            if result["status"] not in ("queued", "running"):
                                break
                            if time.monotonic() >= deadline:
                                raise AssertionError("Hosted run did not finish within the polling deadline")
                            time.sleep(1.5)
                    else:
                        result = solve(instance, scenario, args.seconds)
                    row["solver_status"] = result["solver_status"]
                    row["elapsed_seconds"] = result["elapsed_seconds"]
                    row.update(check_result(case, scenario, instance, result, output))
                    if result.get("schedule"):
                        if client:
                            download = client.get(f"/api/runs/{run_id}/export")
                            download.raise_for_status()
                            blob = download.content
                        else:
                            blob = export_zip(Schedule(**result["schedule"]))
                        check_zip(blob, output)
                        (output / "schedule.zip").write_bytes(blob)
                        row["export_verified"] = True
                    elif client:
                        assert client.get(f"/api/runs/{run_id}/export").status_code == 409
                        row["export_blocked"] = True
                    row["passed"] = True
                    (output / "report.json").write_text(json.dumps({k: v for k, v in result.items() if k != "schedule"}, indent=2) + "\n")
                except Exception as exc:
                    row["error"] = f"{type(exc).__name__}: {exc}"
                row["wall_seconds"] = round(time.monotonic() - started, 2)
                report["runs"].append(row)
                write_reports(report, dest)
                print(json.dumps(row), flush=True)
    finally:
        if client:
            client.close()
    assert len(report["runs"]) > 0
    if not all(r["passed"] for r in report["runs"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
