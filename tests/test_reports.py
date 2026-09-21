"""Report integration must retain corrected scoring and current feasibility checks."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from trackaccess import api
from trackaccess.export import read_schedule
from trackaccess.store import Store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('NIGHTSHIFT_DATA', str(tmp_path))
    monkeypatch.delenv('NIGHTSHIFT_GCS_BUCKET', raising=False)
    monkeypatch.setattr(api, 'store', Store())
    with TestClient(api.app) as value:
        yield value


def test_document_pack(client):
    run = client.get('/api/demo').json()['run']
    catalog = client.get('/api/reports').json()
    assert {r['id'] for r in catalog} == {'management-summary', 'risk-resilience', 'contractor-access-pack', 'delay-eclo-register'}
    for report in catalog:
        made = client.post(f"/api/reports/{report['id']}/generate", json={'run_id': run['id']})
        assert made.status_code == 200
        page = client.get(made.json()['download_url'])
        assert page.status_code == 200 and page.headers['content-type'].startswith('text/html')
        assert run['id'] in page.text and '<script' not in page.text
        assert run['validation']['rule_version'] in page.text
    pack = client.get(f"/api/reports/contractor-access-pack/download?run={run['id']}").text
    assert 'C006' in pack and 'A036' in pack
    assert client.post('/api/reports/nope/generate', json={'run_id': run['id']}).status_code == 404
    assert client.post('/api/reports/management-summary/generate', json={'run_id': 'missing'}).status_code == 404


@pytest.mark.parametrize('status', ['queued', 'running', 'failed', 'no_solution'])
def test_reports_require_completed_run(client, status):
    run = client.get('/api/demo').json()['run']
    run.update(id='unfinished-report', status=status)
    api.store.put('runs/' + run['id'], run)
    assert client.post('/api/reports/management-summary/generate', json={'run_id': run['id']}).status_code == 409
    assert client.get('/api/reports/management-summary/download?run=' + run['id']).status_code == 409


def test_report_rechecks_stored_score_and_escapes_labels(client):
    run = client.get('/api/demo').json()['run']
    run['validation']['score'] = -12345
    api.store.put('runs/' + run['id'], run)
    instance = api.store.get('instances/' + run['instance_id'])
    instance['name'] = '<script>alert(1)</script>'
    api.store.put('instances/' + run['instance_id'], instance)
    page = client.get('/api/reports/management-summary/download?run=' + run['id'])
    assert page.status_code == 200 and '137.9' in page.text and '-12345' not in page.text
    assert '<script' not in page.text and '&lt;script&gt;' in page.text


def test_infeasible_report_warns_and_export_stays_blocked(client):
    run = client.get('/api/demo').json()['run']
    rejected = read_schedule(Path(__file__).parent / 'fixtures/rejected_a')
    run.update(id='rejected-report', schedule=rejected.model_dump(mode='json'))
    api.store.put('runs/' + run['id'], run)
    page = client.get('/api/reports/management-summary/download?run=' + run['id'])
    assert page.status_code == 200
    assert 'This plan is not feasible and must not be issued' in page.text
    assert '49 hard violation(s)' in page.text
    assert client.get('/api/runs/' + run['id'] + '/export').status_code == 409


def test_report_checks_booking_commitments(client):
    run = client.get('/api/demo').json()['run']
    run.update(id='broken-booking-report', bookings=[{'activity_id': 'A036', 'week_from': 1, 'week_to': 1}])
    api.store.put('runs/' + run['id'], run)
    page = client.get('/api/reports/management-summary/download?run=' + run['id'])
    assert page.status_code == 200 and 'This plan is not feasible and must not be issued' in page.text
    assert client.get('/api/runs/' + run['id'] + '/export').status_code == 409
