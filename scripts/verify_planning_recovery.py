"""Simulated abandoned batch across a real revision replacement; no credential output."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
from google.cloud import storage
from google.oauth2.credentials import Credentials

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from trackaccess.store import Store, RunLease, LeaseLost

project = 'qwiklabs-gcp-00-71d4c677d0cc'
sdk = '/private/tmp/google-cloud-sdk/bin/gcloud'
token = subprocess.run([sdk, 'auth', 'print-access-token'], env={**os.environ, 'CLOUDSDK_CONFIG': '/private/tmp/codex-gcloud-config'}, capture_output=True, text=True, check=True).stdout.strip()
bucket = storage.Client(project=project, credentials=Credentials(token)).bucket(project + '-nightshift-state')
store = Store(bucket=bucket)
report = json.loads(Path(os.getenv('NIGHTSHIFT_VERIFY_REPORT', '.nightshift/deployment/planning-verification.json')).read_text())
client = httpx.Client(base_url=os.getenv('NIGHTSHIFT_VERIFY_URL', report['url']), timeout=45)
path = Path('.nightshift/deployment/planning-recovery.json')

def get(route):
    response = client.get(route)
    response.raise_for_status()
    return response.json()

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

if sys.argv[1] == 'prepare':
    saved = store.get('runs/' + report['batch_id'])
    batch = copy.deepcopy(saved)
    bid = uuid4().hex
    batch.update(id=bid, status='running', label='Simulated interrupted recovery batch',
                 _lease={'owner': 'simulated-old-worker', 'expires_at': time.time() - 5})
    first_cost = batch['children'][0]['budget_used_seconds']
    for i, child in enumerate(batch['children']):
        child.update(id=f'{bid}--{i}', parent_id=bid)
        if i == 1:
            child.update(status='running', allocated_seconds=18, seconds=18, _deadline_at=time.time() - 1)
            child.pop('budget_used_seconds', None)
        elif i > 1:
            child.update(status='queued', schedule=None, validation=None)
            for field in ('started_at', 'finished_at', 'budget_used_seconds', 'elapsed_seconds', '_deadline_at', 'allocated_seconds'):
                child.pop(field, None)
    batch['remaining_seconds'] = 90 - first_cost - 18
    generation = store._write('runs/' + bid, batch, 0)
    approved = get('/api/instances/' + report['instance_id'] + '/plan')
    path.write_text(json.dumps({'simulation': True, 'batch_id': bid, 'generation': generation,
        'approved_run_id': approved['approved_run_id'], 'approved_fingerprint': fingerprint(approved),
        'first_child_fingerprint': fingerprint(batch['children'][0]), 'initial_remaining_seconds': batch['remaining_seconds'],
        'initial_batch': batch}, indent=2))
    print('Prepared abandoned batch ' + bid, flush=True)
else:
    fixture = json.loads(path.read_text())
    bid = fixture['batch_id']
    stale = copy.deepcopy(fixture['initial_batch'])
    stale['_lease']['expires_at'] = time.time() + 3600
    stale_writer = RunLease(store, 'runs/' + bid, 'simulated-old-worker', stale, fixture['generation'])
    # Parent and child pollers race to recover the same batch.
    with ThreadPoolExecutor(5) as executor:
        initial = list(executor.map(get, ['/api/runs/' + bid, '/api/runs/' + bid + '--1',
            '/api/runs/' + bid + '--2', '/api/disruptions/recoveries/' + bid, '/api/runs/' + bid]))
    try:
        stale_writer.update({'label': 'stale writer must never persist'})
        raise AssertionError('Stale ownership was not fenced')
    except LeaseLost:
        fixture['stale_write_rejected'] = True
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        batch = get('/api/runs/' + bid)
        if batch['status'] not in ('queued', 'running'):
            break
        time.sleep(1)
    assert batch['status'] == 'completed', batch.get('error')
    persisted = store.get('runs/' + bid)
    assert '_lease' not in persisted
    assert fingerprint(persisted['children'][0]) == fixture['first_child_fingerprint'], 'Completed child repeated or changed'
    assert persisted['children'][1]['budget_used_seconds'] == 18, 'Abandoned budget was reset'
    assert persisted['remaining_seconds'] <= fixture['initial_remaining_seconds']
    assert sum(c['budget_used_seconds'] for c in persisted['children']) <= 90.01
    assert all(c['status'] in ('completed', 'no_solution') for c in persisted['children'])
    assert fingerprint(get('/api/instances/' + report['instance_id'] + '/plan')) == fixture['approved_fingerprint']
    for run in report['runs'].values():
        survived = get('/api/runs/' + run['id'])
        assert survived['validation']['feasible'] and survived['validation']['score'] == run['score']
    fixture.pop('initial_batch')
    fixture.update(passed=True, completed_child_unchanged=True, approved_plan_survived=True,
        completed_versions_survived=True, budget_not_reset=True, final_remaining_seconds=persisted['remaining_seconds'],
        concurrent_pollers=5, url=str(client.base_url))
    path.write_text(json.dumps(fixture, indent=2) + '\n')
    print(json.dumps(fixture, indent=2), flush=True)
