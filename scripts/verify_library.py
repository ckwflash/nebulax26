"""Check hosted dataset persistence using a clearly labelled synthetic demand book."""
import argparse
import io
import json
import time
import zipfile
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    client = httpx.Client(base_url=args.url.rstrip('/'), timeout=180)

    def request(method, path, **kwargs):
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response

    assert request('GET', '/api/health').json()['ok']
    paths = request('GET', '/openapi.json').json()['paths']
    assert 'get' in paths['/api/instances']
    assert '/api/instances/{instance_id}/history' in paths
    prior = request('GET', '/api/instances').json()
    assert prior, 'Previously saved datasets are missing'
    files = {p.name: p.read_text() for p in Path('testdata/datasets/01_slack_baseline').glob('*.csv')}
    files['07_PROJECT_DETAILS.csv'] = files['07_PROJECT_DETAILS.csv'].replace(
        'Synthetic test contract 101', args.label)
    upload_files = [('files', (name, content, 'text/csv')) for name, content in files.items()]
    book = request('POST', '/api/instances', data={'name': args.label}, files=upload_files).json()
    iid = book['id']
    entries = request('GET', '/api/instances').json()
    assert sum(entry['id'] == iid for entry in entries) == 1
    assert next(entry for entry in entries if entry['id'] == iid)['name'] == args.label
    with zipfile.ZipFile(io.BytesIO(request('GET', f'/api/instances/{iid}/source').content)) as archive:
        assert set(archive.namelist()) == set(files)
        assert all(archive.read(name).decode() == content for name, content in files.items())
    assert request('GET', f'/api/instances/{iid}/plan').json()['approved_run_id'] is None
    batch = request('POST', f'/api/instances/{iid}/solve-all',
                    json={'seconds': 10, 'client_request_id': args.label}).json()
    repeated = request('POST', f'/api/instances/{iid}/solve-all',
                       json={'seconds': 10, 'client_request_id': args.label}).json()
    assert batch['id'] == repeated['id']
    deadline = time.monotonic() + 210
    while time.monotonic() < deadline:
        current = request('GET', '/api/runs/' + batch['id']).json()
        print('Batch: ' + current['status'], flush=True)
        if current['status'] not in ('queued', 'running'):
            break
        time.sleep(3)
    assert current['status'] == 'completed', current.get('error', current['status'])
    saved = request('GET', f'/api/instances/{iid}/history').json()
    assert set(saved['latest']) == {'A', 'B', 'C'}
    assert len(saved['versions']) == 3
    scores = {}
    for scenario, run in saved['latest'].items():
        assert run['validation']['feasible']
        assert run['validation']['coverage_percent'] == 100
        scores[scenario] = run['validation']['score']
        with zipfile.ZipFile(io.BytesIO(request('GET', '/api/runs/' + run['id'] + '/export').content)) as archive:
            assert set(archive.namelist()) == {'SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv', 'RESULTS.csv'}
            assert archive.testzip() is None
    plan = request('GET', f'/api/instances/{iid}/plan').json()
    approved = request('POST', f'/api/instances/{iid}/plan/adopt', json={
        'run_id': saved['latest']['A']['id'],
        'expected_approved_run_id': plan['approved_run_id'], 'expected_revision': plan['revision']}).json()
    assert approved['approved_run_id'] == saved['latest']['A']['id']
    report_types = request('GET', '/api/reports').json()
    generated = request('POST', '/api/reports/' + report_types[0]['id'] + '/generate',
                        json={'run_id': saved['latest']['A']['id']}).json()
    assert 'text/html' in request('GET', generated['download_url']).headers['content-type']
    repeated_book = request('POST', '/api/instances', files=upload_files).json()
    assert repeated_book['id'] == iid and repeated_book['name'] == args.label
    client.close()
    client = httpx.Client(base_url=args.url.rstrip('/'), timeout=180)
    reopened = request('GET', f'/api/instances/{iid}/history').json()
    assert {v['id'] for v in reopened['versions']} == {v['id'] for v in saved['versions']}
    assert request('GET', f'/api/instances/{iid}/plan').json()['approved_run_id'] == approved['approved_run_id']
    assert request('GET', f'/api/instances/{iid}').json()['name'] == args.label
    result = {'url': args.url, 'instance_id': iid, 'label': args.label,
              'previous_dataset_count': len(prior), 'dataset_count': len(entries),
              'approved_run_id': approved['approved_run_id'],
              'run_ids': {s: run['id'] for s, run in saved['latest'].items()}, 'scores': scores,
              'save_list_source_download': True, 'all_scenarios': True,
              'repeat_upload_preserves_history': True, 'fresh_client_reopens_plan_and_versions': True,
              'exact_csv_exports': True, 'printable_report': True, 'passed': True}
    Path(args.report).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    client.close()


if __name__ == '__main__':
    main()
