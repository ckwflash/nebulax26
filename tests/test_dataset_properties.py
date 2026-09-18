"""Relationships that should hold independently of solver implementation details."""
import copy
from datetime import date, timedelta
import hashlib
import io
import json
import random
import zipfile

import pytest

from scripts.generate_test_datasets import ROOT, FILES, build_cases, csv_text, zip_bytes
from trackaccess.domain import Instance
from trackaccess.solver import solve


@pytest.fixture(scope="module")
def cases():
    return {case["slug"]: case for case in build_cases()}


def altered(case, change):
    instance = Instance(case["files"])
    tables = copy.deepcopy(instance.tables)
    change(tables)
    return Instance({FILES[key]: csv_text(rows) for key, rows in tables.items()})


def check(instance, scenario, score):
    result = solve(instance, scenario, 5)
    if score is None:
        assert result["solver_status"] == "INFEASIBLE" and result["schedule"] is None
    else:
        assert result["solver_status"] == "OPTIMAL", result["solver_status"]
        assert result["validation"]["feasible"] and result["validation"]["coverage_percent"] == 100
        assert result["validation"]["score"] == result["model_bound"] == score


def test_saved_datasets_match_reproducible_generator(cases):
    manifest = json.loads((ROOT / "testdata/manifest.json").read_text())
    assert len(cases) == 10
    assert len({Instance(c["files"]).id for c in cases.values()}) == 10
    assert build_cases() == list(cases.values())
    for entry in manifest["cases"]:
        case = cases[entry["slug"]]
        archive = (ROOT / "testdata/zips" / f"{entry['slug']}.zip").read_bytes()
        assert archive == zip_bytes(case["files"])
        assert hashlib.sha256(archive).hexdigest() == entry["zip_sha256"]
        assert entry["expected"] == case["expected"]
        with zipfile.ZipFile(io.BytesIO(archive)) as opened:
            assert len(opened.namelist()) == 8 and set(opened.namelist()) == set(FILES.values())
            assert {name: opened.read(name).decode() for name in opened.namelist()} == case["files"]
        assert Instance.from_directory(ROOT / "testdata/datasets" / entry["slug"]).files == case["files"]


def test_priority_case_has_independently_derived_fixed_bounds(cases):
    case = cases["08_priority_pressure"]
    assert [case["expected"][s]["score"] for s in "ABC"] == [2240, 30, 720]


@pytest.mark.parametrize("scenario,score", [("A", 210), ("B", 42), ("C", 91)])
def test_csv_row_order_does_not_change_optimum(cases, scenario, score):
    def shuffle(tables):
        rng = random.Random(12345)
        for rows in tables.values():
            rng.shuffle(rows)
    check(altered(cases["04_exclusive_mixes"], shuffle), scenario, score)


@pytest.mark.parametrize("scenario", "ABC")
def test_renaming_and_reversing_ids_preserves_precedence(cases, scenario):
    def rename(tables):
        mapping = {"A501": "A903", "A502": "A902", "A503": "A901"}
        contracts = {"C501": "C903", "C502": "C902", "C503": "C901"}
        for row in tables["projects"]:
            row["contract_number"] = contracts[row["contract_number"]]
        for row in tables["activities"]:
            row["activity_id"] = mapping[row["activity_id"]]
            row["contract_number"] = contracts[row["contract_number"]]
            if row["predecessor_activity_id"]:
                row["predecessor_activity_id"] = mapping[row["predecessor_activity_id"]]
    check(altered(cases["05_predecessor_chain"], rename), scenario, 0)


@pytest.mark.parametrize("scenario,score", [("A", 140), ("B", 20), ("C", 80)])
def test_calendar_translation_preserves_cost_and_windows(cases, scenario, score):
    def shift(tables):
        for rows in tables.values():
            for row in rows:
                for key in row:
                    if key.endswith("_date"):
                        row[key] = str(date.fromisoformat(row[key]) + timedelta(days=28))
        for row in tables["parameters"]:
            if row["key"] == "horizon_start":
                row["value"] = str(date.fromisoformat(row["value"]) + timedelta(days=28))
    check(altered(cases["07_eclo_window"], shift), scenario, score)


@pytest.mark.parametrize("scenario", "ABC")
def test_more_supply_eliminates_the_known_bottleneck(cases, scenario):
    def increase(tables):
        for row in tables["supply"]:
            row["supply_capacity"] = "2"
    check(altered(cases["03_sharing_limit"], increase), scenario, 0)


@pytest.mark.parametrize("scenario,score", [("A", 140), ("B", None), ("C", 80)])
def test_longer_horizon_restores_feasibility_but_not_hard_deadline(cases, scenario, score):
    def extend(tables):
        for row in tables["parameters"]:
            if row["key"] == "horizon_weeks":
                row["value"] = "4"
    check(altered(cases["10_impossible_workload"], extend), scenario, score)


def test_scale_case_has_disjoint_protection_and_independent_windows(cases):
    instance = Instance(cases["09_double_network"]["files"])
    assert len(instance.activities) == 108 and len(instance.projects) == 28
    assert sum(a.total_accesses for a in instance.activities.values()) == 384
    components = []
    for prefix in ("A1", "A2"):
        jobs = [aid for aid in instance.activities if aid.startswith(prefix)]
        assert len(jobs) == 54
        components.append(set().union(*(instance.protected[aid] for aid in jobs)))
    assert not components[0] & components[1]
    assert len(instance.lines) == 4
