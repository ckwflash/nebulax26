"""Exercise a deployed planner without logging credentials or uploaded contents."""
import io
import json
import os
import subprocess
import time
import zipfile
from pathlib import Path

import httpx

base = os.environ['NIGHTSHIFT_VERIFY_URL'].rstrip('/')
headers = {}
if os.getenv('NIGHTSHIFT_VERIFY_PRIVATE') == '1':
    env = {**os.environ, 'CLOUDSDK_CONFIG': '/private/tmp/codex-gcloud-config'}
    token = subprocess.run(['/private/tmp/google-cloud-sdk/bin/gcloud', 'auth', 'print-identity-token'], env=env, check=True, capture_output=True, text=True).stdout.strip()
    headers['Authorization'] = 'Bearer ' + token
client = httpx.Client(base_url=base, headers=headers, timeout=30)


def request(method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response


def wait(run):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        current = request('GET', '/api/runs/' + run['id']).json()
        if current['status'] not in ('queued', 'running'):
            assert current['status'] == 'completed', current.get('error', current['status'])
            assert current['validation']['feasible'] and current['validation']['safety_verified']
            return current
        time.sleep(1.5)
    raise AssertionError('Run exceeded verification timeout')


assert 'Nightshift' in request('GET', '/').text
assert request('GET', '/api/health').json()['ok']
with Path('PS1.zip').open('rb') as stream:
    instance = request('POST', '/api/instances', files={'files': ('PS1.zip', stream, 'application/zip')}).json()
results = {}
for scenario, score in [('A', 137.9), ('B', 30), ('C', 62.7)]:
    run = wait(request('POST', '/api/runs', json={'instance_id': instance['id'], 'scenario': scenario, 'seconds': 60}).json())
    assert run['validation']['score'] == score
    assert run['validation']['coverage_percent'] == 100
    assert '_lease' not in run
    blob = request('GET', '/api/runs/' + run['id'] + '/export').content
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert set(archive.namelist()) == {'SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv', 'RESULTS.csv'}
        assert archive.testzip() is None
    results[scenario] = run
    print(f'{scenario}: {score}, checked, export verified', flush=True)
a = results['A']
explanation = request('POST', '/api/chat', json={'instance_id': instance['id'], 'run_id': a['id'], 'message': 'Explain C006'}).json()
assert 'A036 needs 7 work units' in explanation['answer'] and explanation['evidence']
location = next(c for c in a['validation']['capacity'] if c['used'] > 0)
preview = wait(request('POST', '/api/runs', json={'instance_id': instance['id'], 'scenario': 'A', 'seconds': 60, 'baseline_id': a['id'], 'overrides': [{'location_id': location['location_id'], 'week': location['week'], 'capacity': 0, 'closed': True}]}).json())
assert preview['overrides'][0]['closed']
assert request('GET', '/api/runs/' + a['id']).json()['schedule'] == a['schedule']
report = {'url': base, 'instance_id': instance['id'], 'runs': {k: {'id': v['id'], 'score': v['validation']['score'], 'status': v['solver_status']} for k, v in results.items()}, 'preview_id': preview['id'], 'baseline_unchanged': True, 'explanation_verified': True, 'export_verified': True}
Path('.nightshift/deployment/verification.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
