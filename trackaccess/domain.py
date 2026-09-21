from __future__ import annotations

import csv
import hashlib
import io
import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FILES = {
    "lines": "01_LINES.csv", "stations": "02_STATIONS.csv",
    "sectors": "03_SECTORS.csv", "supply": "04_LOCATION_SUPPLY.csv",
    "buffers": "05_BUFFER_LOCATION.csv", "parameters": "06_PARAMETERS.csv",
    "projects": "07_PROJECT_DETAILS.csv", "activities": "08_ACTIVITY_DETAILS.csv",
}
Scenario = Literal["A", "B", "C"]


class InputError(ValueError):
    pass


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Project(Record):
    contract_number: str
    contract_description: str
    contract_award_date: date
    activity_type: str
    nature_of_activity: str
    contract_priority: int = Field(ge=1, le=3)
    contract_completion_date: date
    planned_completion_date: date
    number_of_workfronts: int = Field(ge=1)
    access_type: Literal["PM", "PC", "C"]
    number_of_maximum_access_per_week: int = Field(ge=1)


class Activity(Record):
    activity_id: str
    contract_number: str
    activity_type: str
    start_location_id: str
    end_location_id: str
    total_accesses: int = Field(ge=1)
    planned_start_date: date
    predecessor_activity_id: str = ""
    activity_priority: int = Field(ge=1, le=3)


class Instance:
    def __init__(self, files: dict[str, str], name: str = "Uploaded demand book"):
        self.files = files
        self.name = name[:120]
        self.id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
        tables = {}
        for key, filename in FILES.items():
            if filename not in files:
                raise InputError(f"Missing {filename}. Upload all eight instance CSVs.")
            reader = csv.DictReader(io.StringIO(files[filename].lstrip("\ufeff")))
            if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
                raise InputError(f"{filename}: missing or duplicate column headers.")
            rows = list(reader)
            if not rows or any(None in r or any(v is None for v in r.values()) for r in rows):
                raise InputError(f"{filename}: empty table or inconsistent column count.")
            tables[key] = [{k.strip(): v.strip() for k, v in row.items()} for row in rows]
        self.tables = tables
        try:
            params = {r["key"]: r["value"] for r in tables["parameters"]}
            self.start = date.fromisoformat(params["horizon_start"])
            self.weeks = int(params["horizon_weeks"])
            if not 1 <= self.weeks <= 156:
                raise InputError("Planning horizon must be between 1 and 156 weeks.")
            self.lines = self._unique(tables["lines"], "line_code")
            self.projects = self._unique([Project(**r) for r in tables["projects"]], "contract_number")
            self.activities = self._unique([Activity(**r) for r in tables["activities"]], "activity_id")
            if len(self.activities) > 500:
                raise InputError("This deployment supports up to 500 activities per instance.")
            self.supply = {k: int(v["supply_capacity"]) for k, v in self._unique(tables["supply"], "location_id").items()}
            if any(v < 0 for v in self.supply.values()):
                raise InputError("Supply capacity cannot be negative.")
            self.buffer_rules = {k: (int(v["up_to_buffer_sectors"]), bool(int(v["opposite_bound_required"]))) for k, v in self._unique(tables["buffers"], "nature_of_works").items()}
            if any(v[0] < 0 for v in self.buffer_rules.values()):
                raise InputError("Buffer length cannot be negative.")
            self.sectors = defaultdict(list)
            self._unique(tables["sectors"], "sector_id")
            station_keys = [(r["line_code"], r["station_id"]) for r in tables["stations"]]
            if len(station_keys) != len(set(station_keys)):
                raise InputError("Duplicate station on the same line.")
            for row in tables["sectors"]:
                if row["line_code"] not in self.lines:
                    raise InputError("Sector references an unknown line.")
                for endpoint in ("from_station_id", "to_station_id"):
                    if (row["line_code"], row[endpoint]) not in station_keys:
                        raise InputError("Sector references an unknown station.")
                self.sectors[row["line_code"]].append(row)
            for line, sectors in self.sectors.items():
                sectors.sort(key=lambda r: int(r["seq"]))
                if any(a["to_station_id"] != b["from_station_id"] for a, b in zip(sectors, sectors[1:])):
                    raise InputError(f"{line}: sectors must form a continuous ordered line.")
            self.interchanges = {r["station_id"] for r in tables["stations"] if r["is_interchange"] == "1"}
            self.routes = {}
            self.protected = {}
            self.affected_lines = {}
            for aid, activity in self.activities.items():
                if activity.contract_number not in self.projects:
                    raise InputError(f"{aid}: unknown contract {activity.contract_number}.")
                p = self.projects[activity.contract_number]
                if p.activity_type != activity.activity_type:
                    raise InputError(f"{aid}: activity type differs from its contract.")
                if p.nature_of_activity not in self.buffer_rules:
                    raise InputError(f"{aid}: unknown nature of works.")
                self.routes[aid], self.protected[aid] = self.expand(activity)
                self.affected_lines[aid] = sorted({loc.split(":")[1] for loc in self.protected[aid]})
                if not self.routes[aid] <= self.supply.keys():
                    raise InputError(f"{aid}: supply is missing route locations.")
            self.order = self._topological_order()
        except (KeyError, ValueError, TypeError) as exc:
            if isinstance(exc, InputError):
                raise
            raise InputError(f"Invalid instance: {exc}") from exc

    @staticmethod
    def _unique(rows, key):
        result = {}
        for row in rows:
            value = getattr(row, key) if isinstance(row, BaseModel) else row[key]
            if not value or value in result:
                raise InputError(f"Empty or duplicate {key}: {value}")
            result[value] = row
        return result

    @classmethod
    def from_directory(cls, path: str | Path):
        path = Path(path)
        return cls({name: (path / name).read_text(encoding="utf-8-sig") for name in FILES.values()}, path.name)

    def week(self, value: date) -> int:
        return (value - self.start).days // 7 + 1

    def week_end(self, week: int) -> date:
        return self.start + timedelta(days=week * 7 - 1)

    def expand(self, activity: Activity):
        """Work span includes endpoints; protection extends by sector count."""
        first, last = activity.start_location_id.split(":"), activity.end_location_id.split(":")
        if len(first) != 4 or len(last) != 4 or first[0] != "SEC" or last[0] != "SEC" or first[1] != last[1] or first[3] != last[3] or first[3] not in ("EB", "WB"):
            raise InputError(f"{activity.activity_id}: route endpoints must be sectors on one line and bound.")
        line, bound = first[1], first[3]
        sectors = self.sectors[line]
        ids = [r["sector_id"] for r in sectors]
        i, j = sorted([ids.index(":".join(first[:3])), ids.index(":".join(last[:3]))])

        def span(lo, hi, direction):
            locations = set()
            for row in sectors[lo:hi + 1]:
                locations.add(f"{row['sector_id']}:{direction}")
                for key in ("from_station_id", "to_station_id"):
                    locations.add(f"PLAT:{line}:{row[key]}:{direction}")
            return locations

        route = span(i, j, bound)
        p = self.projects[activity.contract_number]
        radius, mirror = self.buffer_rules[p.nature_of_activity]
        lo, hi = max(0, i - radius), min(len(sectors) - 1, j + radius)
        protection = span(lo, hi, bound)
        # Non-live buffers reserve tunnel sectors, not their extra platforms.
        # Live power isolation also closes platforms throughout the buffer.
        if p.nature_of_activity != "Live":
            protection = route | {loc for loc in protection if loc.startswith("SEC:")}
        if mirror:
            protection |= span(lo, hi, "WB" if bound == "EB" else "EB")
        if p.nature_of_activity == "Live":
            touched = {loc.split(":")[2] for loc in protection if loc.startswith("PLAT:")} & self.interchanges
            for other, rows in self.sectors.items():
                if other == line:
                    continue
                for index, row in enumerate(rows):
                    ends = {row["from_station_id"], row["to_station_id"]}
                    if ends <= self.interchanges and ends & touched:
                        # Treat the connecting tunnel as Live work on the other
                        # line too: its full buffer and both bounds lose power.
                        for buffered in rows[max(0, index - radius):index + radius + 1]:
                            for direction in ("EB", "WB"):
                                protection.add(f"{buffered['sector_id']}:{direction}")
                                protection |= {f"PLAT:{other}:{buffered[k]}:{direction}"
                                               for k in ("from_station_id", "to_station_id")}
        return route, protection

    def _topological_order(self):
        visited, visiting, result = set(), set(), []
        def visit(aid):
            if aid in visiting:
                raise InputError("Predecessor relationships contain a cycle.")
            if aid in visited:
                return
            if aid not in self.activities:
                raise InputError(f"Unknown predecessor {aid}.")
            visiting.add(aid)
            pred = self.activities[aid].predecessor_activity_id
            if pred:
                visit(pred)
            visiting.remove(aid)
            visited.add(aid)
            result.append(aid)
        for aid in sorted(self.activities):
            visit(aid)
        return result

    def weight10(self, aid):
        a = self.activities[aid]
        return {1: 100, 2: 10, 3: 1}[self.projects[a.contract_number].contract_priority] * {1: 13, 2: 12, 3: 10}[a.activity_priority]

    def summary(self):
        return {"id": self.id, "name": self.name, "horizon_start": str(self.start), "horizon_weeks": self.weeks,
                "total_workload": sum(a.total_accesses for a in self.activities.values()),
                "projects": [p.model_dump(mode="json") for p in self.projects.values()],
                "activities": [{**a.model_dump(mode="json"), "route": sorted(self.routes[aid]), "protected": sorted(self.protected[aid]), "start_week": max(1, self.week(a.planned_start_date))} for aid, a in self.activities.items()],
                "locations": [{"id": loc, "capacity": cap} for loc, cap in self.supply.items()],
                "lines": list(self.lines.values()), "stations": self.tables["stations"],
                "bounds": self.lower_bounds()}

    def lower_bounds(self):
        earliest, details, penalty, eclo = {}, [], 0, 0
        for aid in self.order:
            a = self.activities[aid]
            p = self.projects[a.contract_number]
            start = max(1, self.week(a.planned_start_date), earliest.get(a.predecessor_activity_id, 0) + 1)
            earliest[aid] = start + a.total_accesses - 1
            days = max(0, (self.week_end(earliest[aid]) - p.planned_completion_date).days)
            # A week is eligible only if its end is on/before the deadline.
            slots = max(0, (p.planned_completion_date - self.start).days // 7 + (1 if (p.planned_completion_date-self.start).days % 7 == 6 else 0) - max(1, self.week(a.planned_start_date)) + 1)
            required_eclo = max(0, 2 * (a.total_accesses - slots))
            eclo += required_eclo
            if days or required_eclo:
                details.append({"activity_id": aid, "contract_number": a.contract_number, "standard_accesses": a.total_accesses, "available_weeks": slots, "minimum_overrun_days": days, "minimum_eclo": required_eclo, "deadline_feasible_with_eclo": 3 * slots >= 2 * a.total_accesses, "evidence_id": f"bound:{aid}"})
        for cid, p in self.projects.items():
            members = [aid for aid, a in self.activities.items() if a.contract_number == cid]
            if members:
                completion = self.week_end(max(earliest[aid] for aid in members))
                late = max(0, (completion - p.planned_completion_date).days)
                penalty += late * sum(self.weight10(aid) for aid in members) / 10
        return {"A": round(penalty, 1), "B": 5 * eclo, "minimum_b_eclo": eclo, "details": details, "note": "Analytical lower bounds; resources may increase the score. Local rule interpretation."}


class Access(Record):
    activity_id: str
    access_seq: int = Field(ge=1)
    week: int = Field(ge=1)
    eclo: int = Field(ge=0, le=1)
    access_night: int = Field(ge=1)


class Occupancy(Record):
    activity_id: str
    week: int = Field(ge=1)
    location_id: str
    co_share_group: str = Field(min_length=1)


class Completion(Record):
    scenario: Scenario
    contract_number: str
    simulated_completion_date: date
    overrun_days: int = Field(ge=0)


class Schedule(Record):
    scenario: Scenario
    access: list[Access]
    occupancy: list[Occupancy]
    results: list[Completion]
    # Internal temporal witness. Not an extra column in the official CSV schema.
    witness: dict[str, int] = Field(default_factory=dict)


class Override(Record):
    location_id: str
    week: int = Field(ge=1)
    capacity: int = Field(ge=0, le=50)
    closed: bool = False


def capacity_at(instance, location, week, overrides=()):
    return next((0 if o.closed else o.capacity for o in reversed(overrides) if o.location_id == location and o.week == week), instance.supply[location])
