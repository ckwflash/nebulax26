import argparse
import json
from pathlib import Path

from .domain import Instance
from .export import read_schedule, save_schedule
from .solver import solve
from .validation import validate


def main():
    parser = argparse.ArgumentParser(description="Nightshift railway access planner (local rules)")
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("solve")
    s.add_argument("--instance", default="PS1/01_data")
    s.add_argument("--scenario", choices=["A", "B", "C", "all"], default="all")
    s.add_argument("--seconds", type=float, default=60)
    s.add_argument("--out", default="outputs")
    v = sub.add_parser("validate")
    v.add_argument("--instance", default="PS1/01_data")
    v.add_argument("--submission", required=True)
    e = sub.add_parser("inspect")
    e.add_argument("--instance", default="PS1/01_data")
    args = parser.parse_args()
    instance = Instance.from_directory(args.instance)
    if args.command == "inspect":
        print(json.dumps(instance.summary(), indent=2))
    elif args.command == "validate":
        report = validate(instance, read_schedule(args.submission))
        print(json.dumps(report, indent=2))
        raise SystemExit(0 if report["feasible"] else 2)
    else:
        failed = False
        for scenario in "ABC" if args.scenario == "all" else [args.scenario]:
            result = solve(instance, scenario, args.seconds)
            out = Path(args.out) / scenario
            out.mkdir(parents=True, exist_ok=True)
            (out / "report.json").write_text(json.dumps({k: v for k, v in result.items() if k != "schedule"}, indent=2))
            if result["schedule"]:
                from .domain import Schedule
                save_schedule(Schedule(**result["schedule"]), out)
                print(f"{scenario}: {result['solver_status']} | score {result['validation']['score']} | {result['elapsed_seconds']}s")
            else:
                failed = True
                print(f"{scenario}: {result['solver_status']} — {result.get('message')}")
        raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
