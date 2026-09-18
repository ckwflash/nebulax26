"""Prepare or verify a simulated interrupted checkpoint across a real revision replacement."""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx
from google.cloud import storage
from google.oauth2.credentials import Credentials

sdk = '/private/tmp/google-cloud-sdk/bin/gcloud'
env = {**os.environ, 'CLOUDSDK_CONFIG': '/private/tmp/codex-gcloud-config'}
def token(kind):
    return subprocess.run([sdk, 'auth', kind], env=env, check=True, capture_output=True, text=True).stdout.strip()

report = json.loads(Path('.nightshift/deployment/verification.json').read_text())
client = httpx.Client(base_url=report['url'], headers={'Authorization': 'Bearer ' + token('print-identity-token')}, timeout=30)
bucket = storage.Client(project='qwiklabs-gcp-00-71d4c677d0cc', credentials=Credentials(token('print-access-token'))).bucket('qwiklabs-gcp-00-71d4c677d0cc-nightshift-state')
path = Path('.nightshift/deployment/recovery.json')

def get(route):
    response = client.get(route)
    response.raise_for_status()
    return response.json()

if sys.argv[1] == 'prepare':
    completed = get('/api/runs/' + report['runs']['A']['id'])
    interrupted = {**completed, 'id': uuid4().hex, 'status': 'running', 'seconds': 1,
                   'baseline_id': completed['id'], 'label': 'Deployment recovery check',
                   '_lease': {'owner': 'simulated-terminated-worker', 'expires_at': time.time() - 1}}
    bucket.blob('runs/' + interrupted['id'] + '.json').upload_from_string(json.dumps(interrupted), content_type='application/json', if_generation_match=0)
    path.write_text(json.dumps({'simulation': True, 'run_id': interrupted['id'], 'completed_run_id': completed['id'], 'schedule': completed['schedule']}, indent=2))
    print('Prepared simulated interrupted checkpoint', interrupted['id'], flush=True)
else:
    fixture = json.loads(path.read_text())
    # Concurrent requests must not cause competing writes or lose the incumbent.
    route = '/api/runs/' + fixture['run_id']
    with ThreadPoolExecutor(5) as pool:
        initial = list(pool.map(lambda _: get(route), range(5)))
    assert all(r['schedule'] for r in initial)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        current = get(route)
        if current['status'] not in ('queued', 'running'):
            break
        time.sleep(1)
    assert current['status'] == 'completed', current.get('error', current['status'])
    assert current['validation']['feasible'] and current['validation']['score'] == 25.2
    original = get('/api/runs/' + fixture['completed_run_id'])
    assert original['schedule'] == fixture['schedule']
    assert get('/api/instances/' + report['instance_id'])['id'] == report['instance_id']
    persisted = json.loads(bucket.blob('runs/' + fixture['run_id'] + '.json').download_as_bytes())
    assert persisted['status'] == 'completed' and '_lease' not in persisted
    fixture.pop('schedule')
    fixture.update(passed=True, completed_version_survived=True, instance_survived=True, recovered_score=25.2)
    path.write_text(json.dumps(fixture, indent=2)+'\n')
    print(json.dumps(fixture, indent=2))
