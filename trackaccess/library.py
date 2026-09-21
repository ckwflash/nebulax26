"""Durable dataset catalogue, scenario batches and compact schedule history."""
import copy
import hashlib
import io
import json
import logging
import os
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field

from . import RULE_VERSION
from .domain import Instance, Record
from .planning import SOLVER_VERSION
from .store import LeaseLost, StorageError
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
    force: bool = False


@router.post('/api/instances/{instance_id}/solve-all', status_code=202)
def solve_all(instance_id: str, request: ScenarioBatchRequest):
    api = server()
    api.instance_for(instance_id)
    # Request identity survives retries, including a lost submission response.
    bid = 'scenarios-' + hashlib.sha256((instance_id + ':' + request.client_request_id).encode()).hexdigest()[:24]
    batch = make_batch(instance_id, plan_control(instance_id)['approved_run_id'],
                       [{'scenario': s, 'seconds': request.seconds, 'label': 'Scenario ' + s} for s in 'ABC'],
                       3 * request.seconds, batch_id=bid,
                       metadata={'purpose': 'dataset_scenarios', 'per_child_seconds': request.seconds,
                                 'execution': 'parallel', 'force': request.force})
    return api.public_run(batch)


CACHE_FIELDS = ('schedule', 'validation', 'solver_status', 'model_bound', 'optimization',
                'diff', 'deadline_relaxed', 'message')


def scenario_cache_key(child):
    inputs = {k: child.get(k) for k in ('instance_id', 'scenario', 'seconds', 'baseline_id',
                                       'overrides', 'bookings', 'philosophy', 'weights', 'resume_from_id')}
    payload = [RULE_VERSION, SOLVER_VERSION, inputs]
    return 'scenario-cache/' + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def restore_scenario(child):
    api = server()
    cached = api.store.get(child['_cache_key'])
    if not cached or cached.get('solver_version') != SOLVER_VERSION:
        return False
    if cached.get('schedule'):
        if (cached.get('validation') or {}).get('rule_version') != RULE_VERSION:
            return False
        checked = api.checked_run({**child, 'schedule': cached['schedule']})
        if not checked['feasible']:
            return False
    elif cached.get('solver_status') != 'INFEASIBLE':
        return False
    child.update({k: copy.deepcopy(cached[k]) for k in CACHE_FIELDS if k in cached})
    if child.get('schedule'):
        child['validation'] = checked
    child.update(status='completed' if child.get('schedule') else 'no_solution', cache_hit=True,
                 cached_from_id=cached['id'], cached_elapsed_seconds=cached.get('elapsed_seconds'),
                 elapsed_seconds=0, budget_used_seconds=0, allocated_seconds=0, finished_at=api.now())
    return True


def configure_scenarios(batch):
    total_threads = max(1, min(32, int(os.getenv('NIGHTSHIFT_SOLVER_THREADS', '4'))))
    batch['parallel_workers'] = min(3, total_threads)
    threads, extra = divmod(total_threads, batch['parallel_workers'])
    for index, child in enumerate(batch['children']):
        child.update(solver_threads=threads + int(index < extra), cache_hit=False)
        child['_cache_key'] = scenario_cache_key(child)
        if not batch.get('force'):
            restore_scenario(child)


def execute_scenarios(batch, lease, cancelled):
    """Three independent budgets, one lease and serialized parent checkpoints."""
    api = server()
    batch = copy.deepcopy(batch)
    lock = threading.RLock()

    def checkpoint():
        if cancelled.is_set():
            raise LeaseLost('Batch ownership was lost')
        lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds']})

    def execute(index):
        with lock:
            child = batch['children'][index]
            if child['status'] not in ('queued', 'running'):
                return
            newly_started = child['status'] == 'queued'
            if newly_started and not batch.get('force') and restore_scenario(child):
                checkpoint()
                return
            if newly_started:
                allocation = min(batch['per_child_seconds'], batch['remaining_seconds'])
                batch['remaining_seconds'] -= allocation
                child.update(status='running', started_at=api.now(), seconds=allocation,
                             allocated_seconds=allocation, _deadline_at=api.store.clock() + allocation)
                checkpoint()
            allocation = child['allocated_seconds']
            remaining = allocation if newly_started else max(0, min(allocation, child['_deadline_at'] - api.store.clock()))
            consumed_before = allocation - remaining
            # compute_run mutates its run while checkpoint callbacks run on another
            # thread. Each solver owns a copy; shared children change only under lock.
            working = copy.deepcopy(child)

        def persist(changes):
            with lock:
                child.update(changes)
                checkpoint()

        completed = api.compute_run(working, cancelled, persist, remaining)
        with lock:
            child.update(completed)
            used = min(allocation, consumed_before + completed.get('elapsed_seconds', remaining))
            child['budget_used_seconds'] = used
            batch['remaining_seconds'] += max(0, allocation - used)
            checkpoint()
        if (completed.get('validation') or {}).get('feasible') or completed.get('solver_status') == 'INFEASIBLE':
            if not completed.get('error'):
                try:
                    api.store.put(child['_cache_key'], {**completed, 'solver_version': SOLVER_VERSION})
                except StorageError:
                    logging.getLogger(__name__).warning('Scenario result saved, but cache write unavailable')

    with ThreadPoolExecutor(max_workers=batch['parallel_workers'], thread_name_prefix='scenario') as workers:
        futures = [workers.submit(execute, i) for i in range(len(batch['children']))]
        try:
            for future in as_completed(futures):
                future.result()
        except BaseException:
            cancelled.set()
            raise
    lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds'],
                  'status': 'completed', 'finished_at': api.now()}, finish=True)


@router.get('/api/instances/{instance_id}/source')
def source(instance_id: str):
    instance = server().instance_for(instance_id)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in instance.files.items():
            archive.writestr(name, content)
    return Response(stream.getvalue(), media_type='application/zip',
                    headers={'Content-Disposition': f'attachment; filename="demand-book-{instance.id}.zip"'})
