import io
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
    started = threading.Event()
    release = threading.Event()
    def controlled(run, cancelled, persist, budget=None):
        if run['scenario'] == 'B':
            started.set()
            assert release.wait(10)
        return original(run, cancelled, persist, budget)
    monkeypatch.setattr(api, 'compute_run', controlled)
    batch = client.post(f"/api/instances/{book['id']}/solve-all", json={'seconds': 1}).json()
    try:
        assert started.wait(10)
        history = client.get(f"/api/instances/{book['id']}/history").json()
        assert history['latest']['A']['status'] == 'completed'
        assert history['latest']['B']['status'] == 'running'
        assert history['latest']['C']['status'] == 'queued'
        assert client.get(f"/api/runs/{history['latest']['C']['id']}/export").status_code == 409
        assert api.active_jobs == {batch['id']}
    finally:
        release.set()
    wait(client, batch['id'])


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
