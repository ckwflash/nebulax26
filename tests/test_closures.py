"""Regression evidence from the user's rejected Scenario A export."""
import json
from pathlib import Path

import pytest

from scripts.generate_test_datasets import add_job, encode, network
from trackaccess.domain import Instance, Schedule
from trackaccess.export import read_schedule, save_schedule
from trackaccess.solver import solve
from trackaccess.validation import validate

ROOT = Path(__file__).resolve().parents[1]
REJECTED = ROOT / 'tests/fixtures/rejected_a'


@pytest.mark.parametrize('with_witness', [False, True])
def test_reproduce_all_49_reported_closure_errors(with_witness):
    instance = Instance.from_directory(ROOT / 'PS1/01_data')
    schedule = read_schedule(REJECTED)
    if with_witness:
        # Reconstruct the solver's internal opportunities from its pN labels.
        schedule.witness = {f'{r.activity_id}:{r.week}': int(r.co_share_group[1:])
                            for r in schedule.occupancy}
    report = validate(instance, schedule)
    actual = sorted(v['detail'] for v in report['hard_violations'] if v['rule'] == 'closure' and 'week' in v)
    assert actual == json.loads((REJECTED / 'closure_errors.json').read_text())
    assert not report['feasible']
    assert 'objective_score' not in report['soft_scores']


def test_buffer_footprints_match_reported_boundaries():
    instance = Instance.from_directory(ROOT / 'PS1/01_data')
    assert 'SEC:ALP:S03_S04:EB' in instance.protected['A025']
    assert 'PLAT:ALP:S04:EB' not in instance.protected['A025']
    # Cross-line Live isolation extends beyond the two interchange platforms.
    assert {'PLAT:BET:S13:WB', 'PLAT:BET:S16:EB', 'SEC:BET:S15_S16:EB'} <= instance.protected['A074']
    assert not any(':BET:' in loc for loc in instance.protected['A025'])


@pytest.mark.parametrize('scenario', 'ABC')
def test_separate_opportunities_cannot_hide_weekly_closure(scenario):
    tables = network(2)
    for number in (1, 2):
        add_job(tables, number, kind='PC', deadline=2)
    result = solve(Instance(encode(tables)), scenario, 3)
    assert result['validation']['feasible']
    assert {r['week'] for r in result['schedule']['access']} == {1, 2}


def test_compatible_work_shares_an_actual_exported_group(tmp_path):
    tables = network(1)
    add_job(tables, 1, kind='PC')
    add_job(tables, 2, kind='C')
    instance = Instance(encode(tables))
    result = solve(instance, 'A', 3)
    assert result['validation']['feasible']
    schedule = Schedule(**result['schedule'])
    save_schedule(schedule, tmp_path)
    (tmp_path / 'timing_witness.json').unlink()
    assert validate(instance, read_schedule(tmp_path))['feasible']
    # Changing every local group breaks co-possession even with a valid witness.
    for row in schedule.occupancy:
        if row.activity_id == 'A002':
            row.co_share_group = 'other'
    assert 'closure' in {v['rule'] for v in validate(instance, schedule)['hard_violations']}


def test_same_label_on_different_lines_does_not_waive_live_closure():
    tables = network(2)
    add_job(tables, 1, nature='Live', location='SEC:X:H1_H2:EB', deadline=2)
    add_job(tables, 2, location='SEC:Y:H1_H2:WB', deadline=2)
    instance = Instance(encode(tables))
    result = solve(instance, 'A', 3)
    assert result['validation']['feasible']
    schedule = Schedule(**result['schedule'])
    for row in schedule.access:
        row.week = 1
    for row in schedule.occupancy:
        row.week = 1
        row.co_share_group = 'same-label'
    schedule.witness = {}
    assert 'closure' in {v['rule'] for v in validate(instance, schedule)['hard_violations']}
