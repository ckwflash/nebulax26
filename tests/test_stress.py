"""Use the actual frontend-generated stress requests against the real solver."""
import json
import os
import subprocess

import pytest

from trackaccess.domain import Instance, Override
from trackaccess.export import read_schedule
from trackaccess.solver import solve
from trackaccess.validation import validate


@pytest.fixture(scope='module')
def cases(tmp_path_factory):
    path = tmp_path_factory.mktemp('stress') / 'cases.json'
    subprocess.run(['node', 'scripts/check_frontend.mjs', '/src/data/stress.check.ts'],
                   env={**os.environ, 'STRESS_CASES_PATH': str(path)}, check=True, capture_output=True, text=True)
    return json.loads(path.read_text())


@pytest.mark.parametrize('scenario,preset', [('A', 0), ('B', 0), ('C', 0), ('C', 1), ('A', 2)])
def test_stress_preset_changes_score_or_proves_infeasible(cases, scenario, preset):
    instance = Instance.from_directory('PS1/01_data')
    baseline = read_schedule('outputs/' + scenario)
    before = validate(instance, baseline)
    selected = [c for c in cases if c['scenario'] == scenario][preset]
    overrides = [Override(**o) for o in selected['overrides']]
    assert not validate(instance, baseline, overrides)['feasible']
    result = solve(instance, scenario, 15, overrides, baseline=baseline, warm_start=baseline, workers=4)
    if result['schedule']:
        assert result['validation']['coverage_percent'] == 100
        if result['validation']['feasible']:
            assert result['validation']['score'] > before['score'], (selected, result)
        else:
            # B keeps a diagnostic schedule when even ECLO cannot meet dates;
            # this is a hard failure, never an unchanged successful plan.
            assert scenario == 'B' and result['deadline_relaxed']
            assert {v['rule'] for v in result['validation']['hard_violations']} == {'planned_date'}
    else:
        assert result['solver_status'] == 'INFEASIBLE', result
