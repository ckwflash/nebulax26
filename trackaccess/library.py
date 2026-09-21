"""Durable dataset catalogue, scenario batches and compact schedule history."""
import hashlib
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field

from . import RULE_VERSION
from .domain import Instance, Record
from .workflows import make_batch, plan_control, server

router = APIRouter()


def dataset_entry(instance, record):
    return {'id': instance.id, 'name': instance.name,
            'created_at': record.get('created_at'), 'updated_at': record.get('updated_at'),
            'activities': len(instance.activities), 'contracts': len(instance.projects),
            'horizon_weeks': instance.weeks,
            'total_workload': sum(a.total_accesses for a in instance.activities.values())}


def save_instance(instance, *, rename=False):
    api = server()
    timestamp = api.now()
    saved = api.store.update('instances/' + instance.id, lambda old: {
        **(old or {}), 'files': instance.files,
        'name': instance.name if rename or not old else old['name'],
        'created_at': (old or {}).get('created_at', timestamp), 'updated_at': timestamp})
    instance.name = saved['name']
    entry = dataset_entry(instance, saved)
    api.store.update('catalog/instances', lambda old: {**(old or {}), instance.id: entry})
    return instance


@router.get('/api/instances')
def list_instances():
    api = server()
    catalogue = api.store.get('catalog/instances') or {}
    # Backfill datasets saved before the library existed. Their original upload
    # timestamps are unknown; never manufacture a historical date.
    missing = [key for key in api.store.keys('instances') if key.split('/')[-1] not in catalogue]
    def entry_for(key):
        record = api.store.get(key)
        if not record:
            return None
        instance = Instance(record['files'], record['name'])
        return dataset_entry(instance, record)
    if missing:
        with ThreadPoolExecutor(max_workers=8) as readers:
            entries = {entry['id']: entry for entry in readers.map(entry_for, missing) if entry}
        catalogue = api.store.update('catalog/instances', lambda old: {**entries, **(old or {})})
    return sorted(catalogue.values(), key=lambda entry: (entry.get('updated_at') or '', entry['id']), reverse=True)


def summary(run):
    report = run.get('validation') or {}
    return {key: run.get(key) for key in ('id', 'instance_id', 'scenario', 'status', 'label', 'created_at',
                                        'solver_status', 'error', 'message')} | {
        'has_schedule': bool(run.get('schedule')), 'feasible': report.get('feasible', False),
        'score': report.get('score'), 'rule_version': report.get('rule_version')}


def register_run(run):
    """Index only references here; lease owners remain the sole run writers."""
    api = server()
    children = run.get('children', [run])
    record = {'id': run['id'], 'created_at': run.get('created_at', api.now()), 'finished': False,
              'runs': [summary(child) for child in children]}
    def add(old):
        index = old or {'jobs': {}}
        index['jobs'].setdefault(run['id'], record)
        return index
    api.store.update('history/' + run['instance_id'], add)


@router.get('/api/instances/{instance_id}/history')
def history(instance_id: str):
    api = server()
    api.instance_for(instance_id)
    control = plan_control(instance_id)
    index = api.store.get('history/' + instance_id) or {'jobs': {}}
    approved_id = control['approved_run_id']
    if approved_id and not any(approved_id == run['id'] for job in index['jobs'].values() for run in job['runs']):
        approved = api.run_for(approved_id)
        register_run(api.run_for(approved['parent_id']) if approved.get('parent_id') else approved)
        index = api.store.get('history/' + instance_id)
    updates = {}
    full = {}
    versions = []
    for jid, record in index['jobs'].items():
        if record.get('finished') and record.get('rule_version') == RULE_VERSION:
            versions.extend(record['runs'])
            continue
        job = api.get_run(jid)  # Polling resumes an abandoned parent, once.
        children = job.get('children', [job])
        checked = [api.run_for(c['id']) if c.get('schedule') and (c.get('validation') or {}).get('rule_version') != RULE_VERSION else c for c in children]
        full.update({c['id']: c for c in checked})
        rows = [summary(c) for c in checked]
        versions.extend(rows)
        if job['status'] not in ('queued', 'running'):
            updates[jid] = {**record, 'runs': rows, 'finished': True, 'rule_version': RULE_VERSION}
    if updates:
        def cache(old):
            result = old or {'jobs': {}}
            result['jobs'].update(updates)
            return result
        api.store.update('history/' + instance_id, cache)
    versions.sort(key=lambda row: (row['created_at'], row['id']), reverse=True)
    latest = {}
    for row in versions:
        if row['scenario'] not in latest:
            latest[row['scenario']] = api.public_run(full.get(row['id']) or api.get_run(row['id']))
    return {'instance_id': instance_id, 'versions': versions, 'latest': latest}


class ScenarioBatchRequest(Record):
    client_request_id: str = Field(default_factory=lambda: uuid4().hex, pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    seconds: int = Field(default=90, ge=1, le=90)


@router.post('/api/instances/{instance_id}/solve-all', status_code=202)
def solve_all(instance_id: str, request: ScenarioBatchRequest):
    api = server()
    api.instance_for(instance_id)
    # Request identity survives retries, including a lost submission response.
    bid = 'scenarios-' + hashlib.sha256((instance_id + ':' + request.client_request_id).encode()).hexdigest()[:24]
    batch = make_batch(instance_id, plan_control(instance_id)['approved_run_id'],
                       [{'scenario': s, 'seconds': request.seconds, 'label': 'Scenario ' + s} for s in 'ABC'],
                       3 * request.seconds, batch_id=bid,
                       metadata={'purpose': 'dataset_scenarios', 'per_child_seconds': request.seconds})
    return api.public_run(batch)


@router.get('/api/instances/{instance_id}/source')
def source(instance_id: str):
    instance = server().instance_for(instance_id)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in instance.files.items():
            archive.writestr(name, content)
    return Response(stream.getvalue(), media_type='application/zip',
                    headers={'Content-Disposition': f'attachment; filename="demand-book-{instance.id}.zip"'})
