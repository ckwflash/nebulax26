import copy
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from trackaccess import api
from trackaccess.domain import Instance, Override, Schedule
from trackaccess.planning import Booking, check_planning
from trackaccess.solver import solve
from trackaccess.store import LeaseLost, StorageError, Store
from trackaccess.validation import validate
from trackaccess import workflows


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('NIGHTSHIFT_DATA', str(tmp_path))
    monkeypatch.delenv('NIGHTSHIFT_GCS_BUCKET', raising=False)
    monkeypatch.setattr(api, 'store', Store())
    with TestClient(api.app) as value:
        yield value
    deadline = time.monotonic() + 20
    while api.active_jobs and time.monotonic() < deadline:
        time.sleep(.05)
    assert not api.active_jobs


def wait(client, rid):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        response = client.get('/api/runs/' + rid)
        assert response.status_code == 200, response.text
        run = response.json()
        if run['status'] not in ('queued', 'running'):
            return run
        time.sleep(.03)
    pytest.fail('Run did not finish')


def setup(client, scenario='A', slug='01_slack_baseline'):
    instance = Instance.from_directory('testdata/datasets/' + slug)
    response = client.post('/api/instances', files=[('files', (name, text, 'text/csv')) for name, text in instance.files.items()])
    assert response.status_code == 200
    rid = client.post('/api/runs', json={'instance_id': instance.id, 'scenario': scenario, 'seconds': 3}).json()['id']
    run = wait(client, rid)
    assert run['validation']['feasible']
    result = client.post('/api/instances/' + instance.id + '/plan/adopt', json={'run_id': rid, 'expected_approved_run_id': None, 'expected_revision': 0})
    assert result.status_code == 200, result.text
    return instance, run, result.json()


def request_for(client, instance, run):
    aid = next(iter(instance.activities))
    a = instance.activities[aid]
    week = next(r['week'] for r in run['schedule']['access'] if r['activity_id'] == aid)
    body = {'instance_id': instance.id, 'contract_number': a.contract_number, 'activity_id': aid,
            'location_id': sorted(instance.routes[aid])[0], 'week_from': week, 'week_to': week,
            'reason': 'Reserve the programme', 'client_request_id': 'same-request'}
    response = client.post('/api/requests', json=body)
    assert response.status_code == 201, response.text
    return response.json(), body


def test_plan_upload_and_stale_adoption(client):
    instance, run, plan = setup(client)
    assert client.get('/api/instances/' + instance.id + '/plan').json()['run']['id'] == run['id']
    response = client.post('/api/instances/' + instance.id + '/plan/adopt', json={'run_id': run['id'], 'expected_approved_run_id': None, 'expected_revision': 0})
    assert response.status_code == 409
    other = Instance.from_directory('testdata/datasets/02_eclo_deadline')
    client.post('/api/instances', files=[('files', (name, text)) for name, text in other.files.items()])
    assert client.get('/api/instances/' + other.id + '/plan').json()['run'] is None
    assert client.post('/api/runs', json={'instance_id': other.id, 'scenario': 'A', 'baseline_id': run['id']}).status_code == 422


def test_request_acceptance_and_commitment_inheritance(client):
    instance, run, plan = setup(client)
    request, body = request_for(client, instance, run)
    assert client.post('/api/requests', json=body).json()['id'] == request['id']
    assert len(client.get('/api/requests', params={'instance_id': instance.id}).json()) == 1
    response = client.post(f"/api/requests/{request['id']}/assessment", json={'seconds': 3})
    assert response.status_code == 202, response.text
    batch = wait(client, response.json()['id'])
    assessment = client.get(f"/api/requests/{request['id']}/assessment").json()
    assert assessment['options'][0]['feasible']
    assert client.post(f"/api/requests/{request['id']}/assessment", json={'seconds': 3}).json()['id'] == batch['id']
    option = assessment['options'][0]['run']
    # Direct adoption cannot bypass the booking decision.
    assert client.post('/api/instances/' + instance.id + '/plan/adopt', json={'run_id': option['id'], 'expected_approved_run_id': run['id'], 'expected_revision': 1}).status_code == 409
    response = client.post(f"/api/requests/{request['id']}/decision", json={'decision': 'accepted', 'run_id': option['id'], 'expected_approved_run_id': run['id'], 'expected_revision': 1})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['request']['status'] == 'accepted'
    assert saved['plan']['approved_run_id'] == option['id']
    assert saved['plan']['commitments'][0]['request_id'] == request['id']
    assert client.get('/api/runs/' + option['id'] + '/export').status_code == 200
    inherited = client.post('/api/runs', json={'instance_id': instance.id, 'scenario': 'C', 'seconds': 3}).json()
    assert inherited['bookings'] == saved['plan']['commitments']
    done = wait(client, inherited['id'])
    booking = saved['plan']['commitments'][0]
    assert any(r['activity_id'] == booking['activity_id'] and booking['week_from'] <= r['week'] <= booking['week_to'] for r in done['schedule']['access'])


def test_failed_acceptance_is_atomic(client, monkeypatch):
    instance, run, plan = setup(client)
    request, _ = request_for(client, instance, run)
    batch = client.post(f"/api/requests/{request['id']}/assessment", json={'seconds': 3}).json()
    wait(client, batch['id'])
    candidate = client.get(f"/api/requests/{request['id']}/assessment").json()['options'][0]['run_id']
    original = api.store._write
    def fail(key, *args, **kwargs):
        if key.startswith('plans/'):
            raise StorageError('Durable storage unavailable')
        return original(key, *args, **kwargs)
    monkeypatch.setattr(api.store, '_write', fail)
    response = client.post(f"/api/requests/{request['id']}/decision", json={'decision': 'accepted', 'run_id': candidate, 'expected_approved_run_id': run['id'], 'expected_revision': 1})
    assert response.status_code == 503
    assert workflows.plan_control(instance.id)['approved_run_id'] == run['id']
    assert not workflows.plan_control(instance.id)['commitments']
    assert workflows.plan_control(instance.id)['requests'][request['id']]['status'] == 'pending'


def test_recoveries_are_one_job_and_separate_scores(client):
    instance, run, _ = setup(client)
    body = {'instance_id': instance.id, 'scenario': 'A', 'baseline_id': run['id'], 'seconds': 5,
            'overrides': [{'location_id': sorted(instance.supply)[0], 'week': instance.weeks, 'capacity': 2, 'closed': False}], 'client_request_id': 'same-batch'}
    response = client.post('/api/disruptions/recoveries', json=body)
    assert response.status_code == 202, response.text
    bid = response.json()['id']
    assert len(response.json()['runs']) == 5
    assert api.active_jobs <= {bid}
    assert client.post('/api/disruptions/recoveries', json=body).json()['id'] == bid
    batch = wait(client, bid)
    result = client.get('/api/disruptions/recoveries/' + bid).json()
    assert result['status'] == 'completed'
    assert [r['run']['scenario'] for r in result['results']] == ['A', 'B', 'A', 'C', 'C']
    assert sum(c['budget_used_seconds'] for c in batch['children']) <= 5.001
    for row in result['results']:
        child = row['run']
        assert child['model_bound'] is None
        if child['schedule']:
            assert child['validation']['feasible']
            assert child['optimization']['stages'][0]['value'] is not None
            if child['scenario'] != 'A':
                assert child['diff']['score_delta'] is None
    child = result['results'][0]['run']
    improved = client.post('/api/runs/' + child['id'] + '/improve', json={'seconds': 3})
    assert improved.status_code == 202, improved.text
    improved = wait(client, improved.json()['id'])
    assert improved['baseline_id'] == run['id'] and improved['philosophy'] == 'churn'
    assert improved['overrides'] == child['overrides']


def test_strategy_locks_and_booking_checker():
    instance = Instance.from_directory('testdata/datasets/02_eclo_deadline')
    baseline = Schedule(**solve(instance, 'A', 2)['schedule'])
    # Hard B policy may not relax under a recovery strategy.
    impossible = Booking(activity_id=next(iter(instance.activities)), week_from=3, week_to=3)
    result = solve(instance, 'B', 2, baseline=baseline, philosophy='deadlines', bookings=[impossible])
    assert result['schedule'] is None and result['solver_status'] == 'INFEASIBLE'
    first = baseline.access[0]
    report = check_planning(instance, baseline, validate(instance, baseline),
                            [Booking(activity_id=first.activity_id, week_from=instance.weeks + 1, week_to=instance.weeks + 1)])
    assert not report['feasible'] and any(v['rule'] == 'booking_requirement' for v in report['hard_violations'])


def test_batch_resume_does_not_repeat_children_or_reset_budget(client, monkeypatch):
    instance, run, _ = setup(client)
    baseline = copy.deepcopy(run)
    baseline.update(id='batch-resume--0', parent_id='batch-resume', status='completed', allocated_seconds=1, budget_used_seconds=1)
    interrupted = {**copy.deepcopy(run), 'id': 'batch-resume--1', 'parent_id': 'batch-resume',
                   'status': 'running', 'seconds': 1, 'allocated_seconds': 1, '_deadline_at': api.store.clock() - 100}
    batch = {'id': 'batch-resume', 'kind': 'batch', 'instance_id': instance.id, 'baseline_id': run['id'],
             'status': 'running', 'seconds': 2, 'remaining_seconds': 0, 'children': [baseline, interrupted]}
    api.store.put('runs/batch-resume', batch)
    def forbidden(*args, **kwargs):
        pytest.fail('An exhausted child must not start the solver again')
    monkeypatch.setattr(api, 'solve', forbidden)
    # Poll child IDs: only the owning batch may be admitted.
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda _: client.get('/api/runs/batch-resume--1'), range(3)))
    done = wait(client, 'batch-resume')
    assert done['children'][0] == baseline
    assert done['children'][1]['status'] == 'completed'
    assert done['remaining_seconds'] == 0
    assert done['children'][1]['budget_used_seconds'] == 1


def test_counteroffer_reject_and_stale_assessment(client):
    instance, run, _ = setup(client)
    request, _ = request_for(client, instance, run)
    batch = client.post(f"/api/requests/{request['id']}/assessment", json={'seconds': 3}).json()
    wait(client, batch['id'])
    options = client.get(f"/api/requests/{request['id']}/assessment").json()['options']
    alternative = next(o for o in options if o['kind'] == 'ALTERNATIVE' and o['feasible'])
    body = {'decision': 'countered', 'run_id': alternative['run_id'], 'expected_approved_run_id': run['id'], 'expected_revision': 1}
    result = client.post(f"/api/requests/{request['id']}/decision", json=body)
    assert result.status_code == 200, result.text
    assert result.json()['plan']['approved_run_id'] == run['id'] and not result.json()['plan']['commitments']
    # Even re-adopting the same run invalidates an old assessment revision.
    client.post(f'/api/instances/{instance.id}/plan/adopt', json={'run_id': run['id'], 'expected_approved_run_id': run['id'], 'expected_revision': 1}).raise_for_status()
    assert client.get(f"/api/requests/{request['id']}/assessment").json()['stale']
    body.update(decision='accepted', expected_revision=2)
    assert client.post(f"/api/requests/{request['id']}/decision", json=body).status_code == 409
    body.update(decision='rejected', run_id=None)
    rejected = client.post(f"/api/requests/{request['id']}/decision", json=body)
    assert rejected.status_code == 200 and rejected.json()['plan']['approved_run_id'] == run['id']
    assert rejected.json()['plan']['revision'] == 2


def test_true_minimum_churn_and_p1_lock():
    from trackaccess.planning import objective_values, placements
    instance = Instance.from_directory('testdata/datasets/01_slack_baseline')
    instance.activities[next(iter(instance.activities))].activity_priority = 1
    baseline = Schedule(**solve(instance, 'A', 3)['schedule'])
    first = next(iter(instance.activities))
    week = next(w for w in range(1, instance.weeks + 1) if w not in {r.week for r in baseline.access if r.activity_id == first})
    booking = Booking(activity_id=first, week_from=week, week_to=week)
    result = solve(instance, 'A', 3, baseline=baseline, bookings=[booking], philosophy='churn')
    assert result['optimization']['stages'][0]['status'] == 'OPTIMAL'
    assert result['optimization']['stages'][0]['value'] == 1
    assert result['validation']['feasible']
    p1 = solve(instance, 'C', 3, baseline=baseline, philosophy='p1')
    assert p1['validation']['feasible']
    before, after = placements(baseline), placements(Schedule(**p1['schedule']))
    for aid, a in instance.activities.items():
        if a.activity_priority == 1:
            assert before[aid] == after[aid]
    custom = solve(instance, 'C', 3, baseline=baseline, bookings=[booking], philosophy='custom')
    expected = objective_values(instance, Schedule(**custom['schedule']), custom['validation'], baseline, 'custom')
    assert custom['optimization']['stages'][0]['value'] == expected[0]
    # A closure through a P1 protection footprint makes locking unavailable.
    aid = next(aid for aid, a in instance.activities.items() if a.activity_priority == 1)
    week = min(w for w, _ in before[aid])
    blocked = solve(instance, 'C', 3, baseline=baseline, philosophy='p1', overrides=[Override(location_id=sorted(instance.protected[aid])[0], week=week, capacity=0, closed=True)])
    assert blocked['schedule'] is None and blocked['solver_status'] == 'INFEASIBLE'


def test_batch_partial_results_and_budget_carry_forward(client, monkeypatch):
    instance, baseline, _ = setup(client)
    reached_second, release = threading.Event(), threading.Event()
    calls = []
    original = api.compute_run
    def controlled(run, cancel, persist, budget=None):
        calls.append(budget)
        if len(calls) == 2:
            reached_second.set()
            assert release.wait(5)
        return original(run, cancel, persist, min(budget, .2))
    monkeypatch.setattr(api, 'compute_run', controlled)
    specs = [{'scenario': 'A', 'label': str(i)} for i in range(3)]
    batch = workflows.make_batch(instance.id, baseline['id'], specs, 3)
    try:
        assert reached_second.wait(5)
        partial = client.get('/api/runs/' + batch['id']).json()
        assert partial['children'][0]['status'] == 'completed'
        assert partial['children'][1]['status'] == 'running'
        assert partial['children'][2]['status'] == 'queued'
        assert calls[1] > calls[0]
        assert '_deadline_at' not in str(partial)
        assert api.active_jobs == {batch['id']}
        with api.job_lock:
            api.active_jobs.update({'admitted1', 'admitted2', 'admitted3'})
        assert client.post('/api/runs', json={'instance_id': instance.id, 'scenario': 'A'}).status_code == 429
    finally:
        with api.job_lock:
            api.active_jobs.difference_update({'admitted1', 'admitted2', 'admitted3'})
        release.set()
    assert wait(client, batch['id'])['status'] == 'completed'


def test_improve_retains_better_checked_schedule(client, monkeypatch):
    instance, baseline, _ = setup(client)
    inferior = Schedule(**baseline['schedule'])
    # Shift all independent activities one week; feasible but worse ordinary tiebreak.
    for row in inferior.access: row.week += 1
    for row in inferior.occupancy: row.week += 1
    inferior.witness = {f'{aid}:{int(week) + 1}': slot for key, slot in inferior.witness.items() for aid, week in [key.split(':')]}
    for row in inferior.results:
        end = max(r.week for r in inferior.access if instance.activities[r.activity_id].contract_number == row.contract_number)
        row.simulated_completion_date = instance.week_end(end)
        row.overrun_days = max(0, (row.simulated_completion_date - instance.projects[row.contract_number].planned_completion_date).days)
    report = validate(instance, inferior)
    assert report['feasible']
    monkeypatch.setattr(api, 'solve', lambda *args, **kwargs: {'schedule': inferior.model_dump(mode='json'), 'validation': report, 'solver_status': 'FEASIBLE'})
    improved = client.post('/api/runs/' + baseline['id'] + '/improve', json={'seconds': 1})
    done = wait(client, improved.json()['id'])
    assert done['schedule'] == baseline['schedule']


def test_checkpoint_latency_does_not_block_solver_callback(client, monkeypatch):
    instance, baseline, _ = setup(client)
    run = api.prepare_run(api.RunRequest(instance_id=instance.id, scenario='A', seconds=5))
    writing, solver_returned = threading.Event(), threading.Event()
    checkpoints = []
    def persist(value):
        if value.get('solutions'):
            writing.set()
            assert solver_returned.wait(2), 'Solver callback blocked on durable storage'
        checkpoints.append(value)
    def search(*args, **kwargs):
        callback = args[5]
        callback(Schedule(**baseline['schedule']), baseline['validation'], {'solutions': 1})
        assert writing.wait(2)
        solver_returned.set()
        return {k: baseline[k] for k in ('schedule', 'validation', 'solver_status', 'elapsed_seconds')}
    monkeypatch.setattr(api, 'solve', search)
    done = api.compute_run(run, threading.Event(), persist)
    assert done['status'] == 'completed' and len(checkpoints) == 2


def test_batch_initial_storage_overhead_does_not_reduce_compute_budget(client, monkeypatch):
    instance, baseline, _ = setup(client)
    now = [100.0]
    monkeypatch.setattr(api.store, 'clock', lambda: now[0])
    child = api.prepare_run(api.RunRequest(instance_id=instance.id, scenario='A', seconds=90), 'budget-overhead--0')
    batch = {'id': 'budget-overhead', 'kind': 'batch', 'status': 'queued', 'instance_id': instance.id,
             'children': [child], 'seconds': 90, 'remaining_seconds': 90}
    api.store.put('runs/budget-overhead', batch)
    lease = api.store.claim_run('budget-overhead')
    update = lease.update
    def slow_update(*args, **kwargs):
        result = update(*args, **kwargs)
        now[0] += 2
        return result
    monkeypatch.setattr(lease, 'update', slow_update)
    budgets = []
    def compute(run, cancelled, persist, budget):
        budgets.append(budget)
        return {**run, 'status': 'completed', 'elapsed_seconds': 3}
    monkeypatch.setattr(api, 'compute_run', compute)
    workflows.execute_batch(lease.snapshot(), lease, threading.Event())
    assert budgets == [90]
    assert api.store.get('runs/budget-overhead')['remaining_seconds'] == 87
