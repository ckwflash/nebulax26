import copy
import csv
import io
import json
import random
from pathlib import Path

import pytest

from trackaccess.domain import FILES, Instance, InputError, Override, Schedule
from trackaccess.export import csv_files, read_schedule, save_schedule
from trackaccess.solver import solve
from trackaccess.validation import validate

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def public():
    return Instance.from_directory(ROOT / "PS1/01_data")


def table(rows):
    out = io.StringIO()
    writer = csv.DictWriter(out, list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def alter(instance, key, update):
    files = instance.files.copy()
    rows = copy.deepcopy(instance.tables[key])
    update(rows)
    files[FILES[key]] = table(rows)
    return Instance(files)


def test_public_routes_and_bounds(public):
    assert len(public.activities) == 54
    assert len(public.supply) == 76
    assert public.lower_bounds()["A"] == 130.9
    assert public.lower_bounds()["B"] == 30
    assert public.routes["A003"] == {"SEC:BET:H01_H02:EB", "SEC:BET:H02_S15:EB", "SEC:BET:S15_S16:EB", "PLAT:BET:H01:EB", "PLAT:BET:H02:EB", "PLAT:BET:S15:EB", "PLAT:BET:S16:EB"}
    assert "SEC:BET:H01_H02:WB" in public.protected["A074"]
    assert "PLAT:BET:H01:EB" in public.protected["A074"]
    assert not any(":ALP:" in loc for loc in public.protected["A003"])
    assert public.protected["A035"] == public.routes["A035"]


def test_reference_regression(public):
    report = validate(public, read_schedule(ROOT / "PS1/03_submission_sample"))
    assert report["structurally_valid"]
    assert report["safety_verified"]
    assert report["feasible"]
    assert report["score"] == 137.9
    assert report["soft_scores"]["overrun_days_total"] == 28


@pytest.mark.parametrize("scenario,score", [("A",137.9),("B",30),("C",62.7)])
def test_public_optima(public, scenario, score, tmp_path):
    result = solve(public, scenario, 15)
    assert result["schedule"], result
    schedule = Schedule(**result["schedule"])
    checked = validate(public, schedule)
    assert checked["feasible"], checked["hard_violations"]
    assert checked["score"] == score
    assert checked["coverage_percent"] == 100
    save_schedule(schedule, tmp_path)
    assert validate(public, read_schedule(tmp_path))["score"] == score
    assert set(csv_files(schedule)) == {"SCHEDULE_ACCESS.csv", "SCHEDULE_OCCUPANCY.csv", "RESULTS.csv"}


@pytest.fixture()
def sample_a():
    return read_schedule(ROOT / "outputs/A")


def tags(public, schedule):
    return {v["rule"] for v in validate(public, schedule)["hard_violations"]}


def test_reject_missing_workload(public, sample_a):
    sample_a.access = [r for r in sample_a.access if r.activity_id != "A036"]
    assert "workload" in tags(public, sample_a)


def test_reject_route_hole(public, sample_a):
    sample_a.occupancy.pop()
    assert "route" in tags(public, sample_a)


def test_reject_duplicate_week(public, sample_a):
    sample_a.access.append(sample_a.access[0].model_copy())
    assert "access_week" in tags(public, sample_a)


def test_reject_eclo_in_a(public, sample_a):
    sample_a.access[0].eclo = 1
    assert "eclo" in tags(public, sample_a)


def test_reject_wrong_results(public, sample_a):
    sample_a.results[0].overrun_days = 999
    assert "results" in tags(public, sample_a)


def test_reject_forged_timing(public, sample_a):
    sample_a.witness = {k: 1 for k in sample_a.witness}
    assert {"closure", "witness"} & tags(public, sample_a)


def test_zero_capacity_override(public, sample_a):
    row = sample_a.occupancy[0]
    report = validate(public, sample_a, [Override(location_id=row.location_id, week=row.week, capacity=0)])
    assert "capacity" in {v["rule"] for v in report["hard_violations"]}


def test_invalid_inputs(public):
    with pytest.raises(InputError, match="Duplicate|duplicate"):
        alter(public, "activities", lambda rows: rows.append(rows[0].copy()))
    with pytest.raises(InputError, match="cycle"):
        alter(public, "activities", lambda rows: rows[0].update(predecessor_activity_id=rows[0]["activity_id"]))
    with pytest.raises(InputError, match="Unknown predecessor"):
        alter(public, "activities", lambda rows: rows[0].update(predecessor_activity_id="MISSING"))
    with pytest.raises(InputError, match="one line and bound"):
        alter(public, "activities", lambda rows: rows[0].update(end_location_id="SEC:ALP:S01_S02:WB"))
    with pytest.raises(InputError, match="Missing"):
        Instance({})


def synthetic(seed):
    """Known feasible: six jobs get disjoint three-week windows in 18 weeks."""
    rng = random.Random(seed)
    tables = {}
    tables["lines"] = [{"line_code": l, "line_name": f"Test {l}"} for l in ("X", "Y")]
    stations, sectors, supply = [], [], []
    for line in ("X", "Y"):
        names = [line+"0", "HUB1", "HUB2", line+"3"]
        for i, name in enumerate(names):
            stations.append(dict(station_id=name,line_code=line,seq=i+1,is_interchange=int(name.startswith("HUB"))))
            for b in ("EB", "WB"):
                supply.append(dict(location_id=f"PLAT:{line}:{name}:{b}",location_kind="platform sector",line_code=line,bound=b,supply_capacity=6))
        for i in range(3):
            sid=f"SEC:{line}:{names[i]}_{names[i+1]}"
            sectors.append(dict(sector_id=sid,line_code=line,from_station_id=names[i],to_station_id=names[i+1],seq=i+1,is_shared=0))
            for b in ("EB", "WB"):
                supply.append(dict(location_id=f"{sid}:{b}",location_kind="tunnel sector",line_code=line,bound=b,supply_capacity=6))
    tables.update(stations=stations,sectors=sectors,supply=supply)
    tables["parameters"]=[dict(key="horizon_start",value="2027-01-04"),dict(key="horizon_weeks",value=18)]
    tables["buffers"]=[dict(nature_of_works=n,up_to_buffer_sectors=b,opposite_bound_required=m) for n,b,m in [("Live",2,1),("Non-live (Consist)",1,0),("Non-live (Others)",0,0)]]
    projects, activities=[],[]
    for i in range(6):
        cid,aid=f"PROJ{seed}_{i}",f"JOB{seed}_{i}"
        projects.append(dict(contract_number=cid,contract_description="Synthetic",contract_award_date="2026-01-01",activity_type="Renewal",nature_of_activity=rng.choice(["Live","Non-live (Consist)","Non-live (Others)"]),contract_priority=rng.randint(1,3),contract_completion_date="2027-05-09",planned_completion_date="2027-05-09",number_of_workfronts=1,access_type=rng.choice(["C","PC","PM"]),number_of_maximum_access_per_week=1))
        line=rng.choice(["X","Y"]);parts=[s for s in sectors if s["line_code"]==line];first,last=sorted(rng.sample(range(3),2));bound=rng.choice(["EB","WB"])
        activities.append(dict(activity_id=aid,contract_number=cid,activity_type="Renewal",start_location_id=parts[first]["sector_id"]+":"+bound,end_location_id=parts[last]["sector_id"]+":"+bound,total_accesses=rng.randint(1,3),planned_start_date="2027-01-04",predecessor_activity_id="",activity_priority=rng.randint(1,3)))
    rng.shuffle(activities);rng.shuffle(projects);rng.shuffle(stations);rng.shuffle(sectors)
    tables.update(projects=projects,activities=activities)
    return Instance({FILES[k]:table(v) for k,v in tables.items()})


@pytest.mark.parametrize("seed",range(100))
def test_generated_feasible_instances(seed):
    instance = synthetic(seed)
    scenario = "ABC"[seed % 3]
    result = solve(instance, scenario, 3)
    assert result["schedule"], (seed,result)
    assert result["validation"]["feasible"], (seed,result["validation"])
    assert result["validation"]["score"] == 0


def test_impossible_deadline_is_not_partial():
    instance=synthetic(123)
    instance=alter(instance,"activities",lambda rows:rows[0].update(total_accesses="99"))
    result=solve(instance,"B",3)
    assert result["solver_status"]=="INFEASIBLE"
    assert result["schedule"] is None


def test_predecessor_and_allocation(public, sample_a):
    dependent=next(r for r in sample_a.access if r.activity_id=="A004")
    dependent.week=1
    dependent.access_night=99
    result=tags(public,sample_a)
    assert "predecessor" in result and "allocation" in result


def test_c_window_rejects_scattered_eclo(public):
    schedule=read_schedule(ROOT/"outputs/C")
    rows=[r for r in schedule.access if r.activity_id=="A003"]
    rows[0].eclo=1;rows[-1].eclo=1
    assert "eclo_window" in tags(public,schedule)


def test_updated_brief_cross_contract_fs_zero_lag():
    instance=synthetic(900)
    ids=sorted(instance.activities)
    predecessor,successor=ids[:2]
    def update(rows):
        for row in rows:
            if row['activity_id'] in (predecessor,successor):
                row.update(total_accesses='1',planned_start_date='2027-01-04')
            if row['activity_id']==successor:
                row['predecessor_activity_id']=predecessor
    instance=alter(instance,'activities',update)
    assert instance.activities[predecessor].contract_number!=instance.activities[successor].contract_number
    result=solve(instance,'A',3)
    assert result['validation']['feasible']
    schedule=Schedule(**result['schedule'])
    pred_last=max(r.week for r in schedule.access if r.activity_id==predecessor)
    successor_rows=[r for r in schedule.access if r.activity_id==successor]
    assert min(r.week for r in successor_rows)>pred_last
    successor_rows[0].week=pred_last
    assert 'predecessor' in {v['rule'] for v in validate(instance,schedule)['hard_violations']}


def test_updated_brief_cross_contract_cycle_rejected():
    instance=synthetic(901)
    first,second=sorted(instance.activities)[:2]
    def cycle(rows):
        for row in rows:
            if row['activity_id']==first:row['predecessor_activity_id']=second
            if row['activity_id']==second:row['predecessor_activity_id']=first
    with pytest.raises(InputError,match='cycle'):
        alter(instance,'activities',cycle)


def test_hard_closure_cannot_be_bought_in_b(public):
    schedule=read_schedule(ROOT/'outputs/B')
    row=schedule.access[0]
    loc=next(iter(public.routes[row.activity_id]))
    override=Override(location_id=loc,week=row.week,capacity=0,closed=True)
    report=validate(public,schedule,[override])
    assert 'closure' in {v['rule'] for v in report['hard_violations']}
    repaired=solve(public,'B',10,[override],baseline=schedule)
    assert repaired['validation']['feasible']
    for access in repaired['schedule']['access']:
        assert access['week']!=row.week or loc not in public.protected[access['activity_id']]


def test_contract_without_work():
    instance=synthetic(222)
    def extra(rows):
        row=rows[0].copy();row['contract_number']='EMPTY_CONTRACT';rows.append(row)
    instance=alter(instance,'projects',extra)
    result=solve(instance,'A',3)
    assert result['validation']['feasible']
    empty=next(r for r in result['schedule']['results'] if r['contract_number']=='EMPTY_CONTRACT')
    assert empty['simulated_completion_date']==str(instance.start)


def test_c_forced_eclo_stays_continuous():
    instance=synthetic(223)
    def harder(rows):
        # Isolate workload/window behavior from multi-possession closures.
        rows[:] = rows[:1]
        rows[0].update(total_accesses='6',planned_start_date='2027-01-04')
    instance=alter(instance,'activities',harder)
    instance=alter(instance,'parameters',lambda rows: next(r for r in rows if r['key']=='horizon_weeks').update(value='5'))
    result=solve(instance,'C',5)
    assert result['validation']['feasible']
    for window in result['validation']['eclo_windows'].values():
        assert window[1]-window[0]<=1
    assert result['validation']['soft_scores']['eclo_nights_total']==2


def test_tight_b_deadline_still_delivers_a_schedule(public):
    """An unreachable B deadline must be priced, not filtered into INFEASIBLE.

    The brief forbids declaring a case impossible, so B slips dates only after its
    supply levers are spent, and the checker still reports the overrun honestly.
    """
    files = dict(public.files)
    rows = list(csv.DictReader(io.StringIO(files[FILES["projects"]])))
    for row in rows:
        row["planned_completion_date"] = str(public.week_end(6))
    files[FILES["projects"]] = table(rows)
    result = solve(Instance(files), "B", 30)

    assert result["schedule"] is not None, "B returned no schedule for a tight deadline"
    report = result["validation"]
    assert report["coverage_percent"] == 100.0
    assert report["completed_activities"] == report["total_activities"]
    # Overrun is the only thing allowed to break; nothing structural may.
    assert {v["rule"] for v in report["hard_violations"]} == {"planned_date"}
    assert result["solver_status"] == "OPTIMAL_WITH_OVERRUN"
