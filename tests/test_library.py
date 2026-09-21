import io
import copy
import threading
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from trackaccess import api, library
from trackaccess.domain import FILES, Instance
from trackaccess.store import StorageError, Store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('NIGHTSHIFT_DATA', str(tmp_path))
    monkeypatch.delenv('NIGHTSHIFT_GCS_BUCKET', raising=False)
    monkeypatch.setenv('NIGHTSHIFT_SOLVER_THREADS', '6')
    monkeypatch.setattr(api, 'store', Store())
    with TestClient(api.app) as value:
        yield value
    deadline = time.monotonic() + 15
    while api.active_jobs and time.monotonic() < deadline:
        time.sleep(.02)
    assert not api.active_jobs


def upload(client, name='Library book', slug='01_slack_baseline'):
    instance = Instance.from_directory('testdata/datasets/' + slug)
    response = client.post('/api/instances', data={'name': name}, files=[('files', (n, s, 'text/csv')) for n, s in instance.files.items()])
    assert response.status_code == 200, response.text
    return response.json()


def wait(client, bid):
    for _ in range(500):
        run = client.get('/api/runs/' + bid).json()
        if run['status'] not in ('queued', 'running'):
            return run
        time.sleep(.03)
    pytest.fail('Batch did not finish')


@pytest.mark.parametrize('cores', [1, 2, 4, 6, 8, 10, 32])
def test_parallel_scenarios_share_the_cpu_budget(monkeypatch, cores):
    monkeypatch.setenv('NIGHTSHIFT_SOLVER_THREADS', str(cores))
    batch = {'force': True, 'children': [{'scenario': s} for s in 'ABC']}
    library.configure_scenarios(batch)
    threads = [child['solver_threads'] for child in batch['children']]
    assert all(t >= 1 for t in threads)
    assert sum(sorted(threads, reverse=True)[:batch['parallel_workers']]) == cores
    if cores == 8:
        assert threads == [3, 3, 2]


def test_all_scenarios_durable_history_and_exact_exports(client, monkeypatch):
    book = upload(client)
    response = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 2, 'client_request_id': 'one-upload'})
    assert response.status_code == 202, response.text
    batch = response.json()
    assert [c['scenario'] for c in batch['children']] == ['A', 'B', 'C']
    assert batch['seconds'] == 6
    assert api.active_jobs <= {batch['id']}
    duplicate = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 2, 'client_request_id': 'one-upload'})
    assert duplicate.json()['id'] == batch['id']
    done = wait(client, batch['id'])
    assert done['status'] == 'completed'
    assert [c['allocated_seconds'] for c in done['children']] == [2, 2, 2]
    for child in done['children']:
        assert child['validation']['feasible'] and child['validation']['coverage_percent'] == 100
        exported = client.get(f"/api/runs/{child['id']}/export")
        assert exported.status_code == 200
        assert f"-{child['scenario']}-" in exported.headers['content-disposition']
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            assert sorted(archive.namelist()) == ['RESULTS.csv', 'SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv']
    assert client.get(f"/api/instances/{book['id']}/plan").json()['approved_run_id'] is None
    monkeypatch.setattr(api, 'store', Store())  # Fresh process/store, same durable records.
    history = client.get(f"/api/instances/{book['id']}/history").json()
    assert set(history['latest']) == {'A', 'B', 'C'}
    assert len(history['versions']) == 3
    assert client.get('/api/instances').json()[0]['name'] == 'Library book'
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/instances/{book['id']}/source").content)) as archive:
        assert set(archive.namelist()) == set(FILES.values())
    other = upload(client, 'Another book', '02_eclo_deadline')
    assert not client.get(f"/api/instances/{other['id']}/history").json()['versions']
    assert len(client.get('/api/instances').json()) == 2


def test_progress_is_visible_before_last_scenario_finishes(client, monkeypatch):
    book = upload(client)
    original = api.compute_run
    started = threading.Barrier(4)
    release = threading.Event()
    def controlled(run, cancelled, persist, budget=None):
        assert run['solver_threads'] == 2
        started.wait(10)
        if run['scenario'] == 'B':
            assert release.wait(10)
        return original(run, cancelled, persist, budget)
    monkeypatch.setattr(api, 'compute_run', controlled)
    batch = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1}).json()
    try:
        started.wait(10)  # All three entered compute before any can finish.
        for _ in range(100):
            history = client.get(f"/api/instances/{book['id']}/history").json()
            if all(history['latest'][s]['status'] == 'completed' for s in 'AC'):
                break
            time.sleep(.03)
        assert history['latest']['A']['status'] == 'completed'
        assert history['latest']['B']['status'] == 'running'
        assert history['latest']['C']['status'] == 'completed'
        assert client.get(f"/api/runs/{history['latest']['B']['id']}/export").status_code == 409
        assert api.active_jobs == {batch['id']}
    finally:
        release.set()
    wait(client, batch['id'])


def test_cached_scenarios_survive_restart_and_skip_solver(client, monkeypatch):
    book = upload(client)
    first = wait(client, client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1}).json()['id'])
    monkeypatch.setattr(api, 'store', Store())
    def forbidden(*args, **kwargs):
        pytest.fail('A cache hit must not submit computation')
    monkeypatch.setattr(api, 'submit_job', forbidden)
    second = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1}).json()
    assert second['status'] == 'completed'
    assert second['id'] != first['id']
    for old, cached in zip(first['children'], second['children']):
        assert cached['cache_hit'] and cached['cached_from_id'] == old['id']
        assert cached['elapsed_seconds'] == 0 and cached['schedule'] == old['schedule']
        assert client.get(f"/api/runs/{cached['id']}/export").status_code == 200


def test_partial_cache_force_and_budget_invalidation(client, monkeypatch):
    book = upload(client)
    endpoint = f"/api/instances/{book['id']}/solve-all"
    first = wait(client, client.post(endpoint, json={'seconds': 1}).json()['id'])
    stored = api.store.get('runs/' + first['id'])
    api.store.put(stored['children'][1]['_cache_key'], {})
    original = api.compute_run
    calls = []
    def counted(run, *args, **kwargs):
        calls.append(run['scenario'])
        return original(run, *args, **kwargs)
    monkeypatch.setattr(api, 'compute_run', counted)
    partial = wait(client, client.post(endpoint, json={'seconds': 1}).json()['id'])
    assert calls == ['B']
    assert [c['cache_hit'] for c in partial['children']] == [True, False, True]
    calls.clear()
    wait(client, client.post(endpoint, json={'seconds': 1, 'force': True}).json()['id'])
    assert sorted(calls) == list('ABC')
    calls.clear()
    wait(client, client.post(endpoint, json={'seconds': 2}).json()['id'])
    assert sorted(calls) == list('ABC')


def test_cache_identity_includes_effective_constraints_and_versions(client, monkeypatch):
    book = upload(client)
    child = api.prepare_run(api.RunRequest(instance_id=book['id'], scenario='A', seconds=1))
    key = library.scenario_cache_key(child)
    assert library.scenario_cache_key({**child, 'id': 'another', 'label': 'Renamed'}) == key
    for field, value in [('scenario', 'B'), ('instance_id', '0' * 16), ('baseline_id', 'approved'),
                         ('bookings', [{'activity_id': 'A001', 'week_from': 1, 'week_to': 1}]),
                         ('overrides', [{'location_id': 'L001', 'week': 1, 'closed': True}])]:
        assert library.scenario_cache_key({**child, field: value}) != key
    monkeypatch.setattr(library, 'SOLVER_VERSION', 'new-model')
    assert library.scenario_cache_key(child) != key


def test_parallel_recovery_keeps_completed_children_and_exhausted_budgets(client, monkeypatch):
    book = upload(client)
    first = wait(client, client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1}).json()['id'])
    batch = api.store.get('runs/' + first['id'])
    batch.update(id='parallel-recovery', status='running', remaining_seconds=0, force=True)
    for index, child in enumerate(batch['children']):
        child.update(id=f'parallel-recovery--{index}', parent_id=batch['id'])
        if index:
            child.update(status='running', allocated_seconds=1, _deadline_at=api.store.clock() - 20)
    completed = copy.deepcopy(batch['children'][0])
    api.store.put('runs/' + batch['id'], batch)
    def forbidden(*args, **kwargs):
        pytest.fail('Recovery must not grant a fresh computation budget')
    monkeypatch.setattr(api, 'solve', forbidden)
    recovered = wait(client, batch['id'])
    assert recovered['children'][0] == api.public_run(completed)
    assert api.store.get('runs/' + batch['id'])['children'][0] == completed
    assert recovered['remaining_seconds'] == 0
    assert all(c['status'] == 'completed' for c in recovered['children'])
    assert [c['budget_used_seconds'] for c in recovered['children'][1:]] == [1, 1]


def test_library_backfills_older_books_and_keeps_names_and_dates(client):
    instance = Instance.from_directory('testdata/datasets/01_slack_baseline')
    api.store.put('instances/' + instance.id, {'name': 'Historical book', 'files': instance.files})
    entries = client.get('/api/instances').json()
    assert entries[0]['created_at'] is None
    assert entries[0]['name'] == 'Historical book'
    response = client.post('/api/instances', files=[('files', (n, s)) for n, s in instance.files.items()])
    assert response.json()['name'] == 'Historical book'
    created = api.store.get('instances/' + instance.id)['created_at']
    upload(client, 'Renamed book')
    assert api.store.get('instances/' + instance.id)['created_at'] == created
    assert len(client.get('/api/instances').json()) == 1
    assert client.get('/api/instances').json()[0]['name'] == 'Renamed book'


def test_history_keeps_older_versions_and_rejects_failed_exports(client):
    book = upload(client, slug='10_impossible_workload')
    for nonce in ('first', 'second'):
        batch = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1, 'client_request_id': nonce}).json()
        wait(client, batch['id'])
    history = client.get(f"/api/instances/{book['id']}/history").json()
    assert len(history['versions']) == 6
    for run in history['latest'].values():
        assert not run.get('validation', {}).get('feasible') if run.get('validation') else True
        assert client.get(f"/api/runs/{run['id']}/export").status_code == 409


def test_catalogue_failure_is_visible(client, monkeypatch):
    original = api.store._write
    def fail(key, *args, **kwargs):
        if key.startswith('catalog/'):
            raise StorageError('Saved dataset library unavailable')
        return original(key, *args, **kwargs)
    monkeypatch.setattr(api.store, '_write', fail)
    instance = Instance.from_directory('testdata/datasets/01_slack_baseline')
    response = client.post('/api/instances', files=[('files', (n, s)) for n, s in instance.files.items()])
    assert response.status_code == 503
    assert client.get('/api/instances').status_code == 503
    monkeypatch.setattr(api.store, '_write', original)
    assert len(client.get('/api/instances').json()) == 1
