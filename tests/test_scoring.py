"""Contract-delay aggregation, grounded in the reported 137.9 A score."""
from pathlib import Path
from zipfile import ZipFile

import pytest

from scripts.generate_test_datasets import add_job, encode, network
from trackaccess.domain import Instance, Schedule
from trackaccess.export import read_schedule
from trackaccess.planning import objective_values
from trackaccess.solver import solve
from trackaccess.validation import validate

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('scenario,score', [('A', 137.9), ('B', 0), ('C', 137.9)])
def test_reported_score_applies_contract_delay_to_all_members(tmp_path, scenario, score):
    # This archive is the exact closure-corrected ZIP subsequently scored by
    # the user at 137.9, with 28 overrun days across three contracts.
    with ZipFile(ROOT / 'tests/fixtures/scored_a.zip') as archive:
        for name in archive.namelist():
            (tmp_path / name).write_bytes(archive.read(name))
    instance = Instance.from_directory(ROOT / 'PS1/01_data')
    schedule = read_schedule(tmp_path)
    schedule.scenario = scenario
    for row in schedule.results:
        row.scenario = scenario
    report = validate(instance, schedule)
    assert report['score'] == score
    assert report['soft_scores']['priority_weighted_score'] == 137.9
    assert report['soft_scores']['overrun_days_total'] == 28
    assert report['soft_scores']['contracts_overrunning'] == 3
    assert {c['contract_number']: c['weighted_overrun_score']
            for c in report['contracts'] if c['overrun_days']} == {
                'C006': 85.4, 'C010': 45.5, 'C014': 7.0}
    assert report['feasible'] == (scenario != 'B')


def two_member_contract():
    tables = network(2)
    add_job(tables, 1, deadline=1)
    add_job(tables, 2, start=2, deadline=1, location='SEC:Y:Y0_H1:EB')
    tables['activities'][0]['activity_priority'] = 1
    tables['activities'][1]['contract_number'] = 'C001'
    tables['projects'] = tables['projects'][:1]
    return Instance(encode(tables))


def test_early_activity_still_contributes_its_weight_and_bound():
    instance = two_member_contract()
    result = solve(instance, 'A', 3)
    # P2 contract, seven days late: (10*1.3 + 10*1.0) * 7.
    assert result['validation']['score'] == 161
    assert result['model_bound'] == 161
    assert instance.lower_bounds()['A'] == 161
    assert next(r['week'] for r in result['schedule']['access'] if r['activity_id'] == 'A001') == 1


def test_optimizer_prioritizes_total_contract_weight():
    tables = network(2)
    add_job(tables, 1, kind='PM', priority=3)
    add_job(tables, 2, kind='PM', priority=3, location='SEC:Y:Y0_H1:EB')
    add_job(tables, 3, kind='PM', priority=3)
    tables['activities'][1].update(contract_number='C001', activity_priority=1)
    tables['activities'][2]['activity_priority'] = 1
    tables['projects'] = [p for p in tables['projects'] if p['contract_number'] != 'C002']
    result = solve(Instance(encode(tables)), 'A', 3)
    assert result['validation']['feasible']
    # Delaying A001 alone used to cost 7, versus A003's 9.1. The actual
    # contract cost is 16.1 because early A002 contributes its weight too.
    assert result['validation']['score'] == result['model_bound'] == 9.1
    assert {r['activity_id']: r['week'] for r in result['schedule']['access']} == {
        'A001': 1, 'A002': 1, 'A003': 2}


def test_custom_objective_and_incumbent_ranking_use_contract_delays():
    instance = two_member_contract()
    baseline = Schedule(**solve(instance, 'A', 3)['schedule'])
    weights = {'churn': 0, 'deadlines': 1, 'passengers': 0, 'priority1': 1}
    result = solve(instance, 'A', 3, baseline=baseline, philosophy='custom', weights=weights)
    score = objective_values(instance, Schedule(**result['schedule']), result['validation'],
                             baseline, 'custom', weights)
    assert score == (2520, 0)  # (161 total + 91 for P1 activity) in tenths.
    assert result['optimization']['stages'][0]['value'] == score[0]
