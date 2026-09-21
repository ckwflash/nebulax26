"""Durable approvals, booking assessments and leased serial recovery batches."""
import copy
import hashlib
import json
import time
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .domain import Override, Record, Schedule, capacity_at
from .planning import Booking, Philosophy, SOLVER_VERSION, Weights
from .store import Conflict, LeaseLost

router = APIRouter()


def server():
    from . import api
    return api


def empty_control(instance_id):
    return {'instance_id': instance_id, 'approved_run_id': None, 'revision': 0,
            'commitments': {}, 'requests': {}}


def plan_control(instance_id):
    return server().store.get('plans/' + instance_id) or empty_control(instance_id)


def initialize_plan(instance_id, run):
    if not run['validation']['feasible']:
        return
    def initialize(current):
        if current is not None:
            return current
        return {**empty_control(instance_id), 'approved_run_id': run['id'], 'revision': 1}
    server().store.update('plans/' + instance_id, initialize)


def plan_reply(control):
    api = server()
    return {'instance_id': control['instance_id'], 'approved_run_id': control['approved_run_id'],
            'revision': control['revision'], 'commitments': list(control['commitments'].values()),
            'run': api.public_run(api.run_for(control['approved_run_id'])) if control['approved_run_id'] else None}


@router.get('/api/instances/{instance_id}/plan')
def get_plan(instance_id: str):
    server().instance_for(instance_id)
    return plan_reply(plan_control(instance_id))


class AdoptRequest(Record):
    run_id: str
    expected_approved_run_id: str | None
    expected_revision: int = Field(ge=0)


def assert_current(control, expected_id, revision):
    if control['approved_run_id'] != expected_id or control['revision'] != revision:
        raise HTTPException(409, 'The approved plan changed. Reload and compare against the latest plan.')


def adoption_report(run, instance_id, commitments):
    api = server()
    if run.get('kind') == 'batch' or run['instance_id'] != instance_id or run['status'] != 'completed' or not run.get('schedule'):
        raise HTTPException(409, 'Adoption requires a completed schedule for this demand book.')
    bookings = list(commitments.values()) + run.get('bookings', [])
    report = api.checked_run(run, bookings)
    if not report['feasible']:
        raise HTTPException(409, 'This schedule does not meet the scenario rules and accepted booking commitments.')
    return report


@router.post('/api/instances/{instance_id}/plan/adopt')
def adopt_plan(instance_id: str, request: AdoptRequest):
    api = server()
    run = api.run_for(request.run_id)
    def adopt(current):
        control = current or empty_control(instance_id)
        assert_current(control, request.expected_approved_run_id, request.expected_revision)
        adoption_report(run, instance_id, control['commitments'])
        # A booking assessment must be accepted through its request decision so
        # the plan and the promised booking cannot diverge.
        unaccepted = [b for b in run.get('bookings', []) if b.get('request_id') and b['request_id'] not in control['commitments']]
        if unaccepted:
            raise HTTPException(409, 'Accept this booking through Contractor Requests so the commitment is saved with the plan.')
        control.update(approved_run_id=run['id'], revision=control['revision'] + 1, adopted_at=api.now())
        return control
    return plan_reply(api.store.update('plans/' + instance_id, adopt))


class ContractorRequest(Record):
    instance_id: str = Field(pattern=r'^[a-f0-9]{16}$')
    contract_number: str
    activity_id: str
    location_id: str
    week_from: int = Field(ge=1)
    week_to: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=1000)
    contractor: str = Field(default='', max_length=120)
    client_request_id: str = Field(default_factory=lambda: uuid4().hex, pattern=r'^[a-zA-Z0-9_-]{1,100}$')


@router.post('/api/requests', status_code=201)
def create_request(request: ContractorRequest):
    api = server()
    instance = api.instance_for(request.instance_id)
    a = instance.activities.get(request.activity_id)
    if not a or a.contract_number != request.contract_number or request.location_id not in instance.routes[a.activity_id]:
        raise HTTPException(422, 'Choose an activity in this contract and a location on its route.')
    if not request.reason.strip():
        raise HTTPException(422, 'Enter a reason for this booking request.')
    if request.week_to < request.week_from or request.week_to > instance.weeks:
        raise HTTPException(422, 'Choose an ordered week range inside this demand book.')
    rid = 'REQ-' + hashlib.sha256((request.instance_id + ':' + request.client_request_id).encode()).hexdigest()[:24]
    record = {**request.model_dump(exclude={'client_request_id'}), 'id': rid, 'request': 'Guaranteed activity access',
              'status': 'pending', 'received_at': api.now(), 'assessment_id': None}
    api.store.update('requests/' + rid, lambda old: old or {'instance_id': instance.id})
    def create(current):
        control = current or empty_control(instance.id)
        old = control['requests'].get(rid)
        if old:
            keys = request.model_dump(exclude={'client_request_id'})
            if any(old[k] != v for k, v in keys.items()):
                raise HTTPException(409, 'This request identifier was already used for different booking details.')
        else:
            control['requests'][rid] = record
        return control
    return api.store.update('plans/' + instance.id, create)['requests'][rid]


@router.get('/api/requests')
def list_requests(instance_id: str):
    server().instance_for(instance_id)
    return sorted(plan_control(instance_id)['requests'].values(), key=lambda r: (r['received_at'], r['id']), reverse=True)


def request_context(rid):
    api = server()
    try:
        locator = api.store.get('requests/' + rid)
    except ValueError:
        locator = None
    if not locator:
        raise HTTPException(404, 'Contractor request not found.')
    control = plan_control(locator['instance_id'])
    request = control['requests'].get(rid)
    if not request:
        raise HTTPException(404, 'Contractor request not found.')
    return request, control


def make_batch(instance_id, baseline_id, specs, seconds, *, batch_id=None, metadata=None):
    api = server()
    bid = batch_id or uuid4().hex
    existing = api.store.get('runs/' + bid)
    if existing:
        from .library import register_run
        register_run(existing)
        api.get_run(bid)
        return existing
    children = []
    for i, spec in enumerate(specs):
        run = api.prepare_run(api.RunRequest(instance_id=instance_id, baseline_id=baseline_id, **spec), bid + '--' + str(i))
        run['parent_id'] = bid
        children.append(run)
    batch = {'id': bid, 'kind': 'batch', 'instance_id': instance_id, 'baseline_id': baseline_id,
             'status': 'queued', 'seconds': seconds, 'remaining_seconds': float(seconds), 'children': children,
             'created_at': api.now(), 'solver_version': SOLVER_VERSION, **(metadata or {})}
    try:
        api.submit_job(batch)
    except Conflict:
        batch = api.run_for(bid)
    return batch


def execute_batch(batch, lease, cancelled):
    api = server()
    batch = copy.deepcopy(batch)
    batch['status'] = 'running'
    for i, child in enumerate(batch['children']):
        if child['status'] not in ('queued', 'running'):
            continue
        if cancelled.is_set():
            raise LeaseLost('Batch ownership was lost')
        newly_started = child['status'] == 'queued'
        if newly_started:
            pending = sum(c['status'] in ('queued', 'running') for c in batch['children'][i:])
            allocation = max(0, batch['remaining_seconds'] / pending)
            if batch.get('per_child_seconds') is not None:
                allocation = min(allocation, batch['per_child_seconds'])
            batch['remaining_seconds'] = max(0, batch['remaining_seconds'] - allocation)
            child.update(status='running', seconds=allocation, allocated_seconds=allocation,
                         _deadline_at=api.store.clock() + allocation)
            lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds']})
        allocation = child['allocated_seconds']
        # Initial checkpoint IO is overhead, not computation. For an interrupted
        # child, conservatively charge its elapsed allocation so retries cannot reset it.
        remaining = allocation if newly_started else max(0, min(allocation, child['_deadline_at'] - api.store.clock()))
        consumed_before = allocation - remaining
        def persist(changes):
            if cancelled.is_set():
                raise LeaseLost('Batch ownership was lost')
            # Preserve the allocation deadline across progress writes/restarts.
            child.update(changes)
            lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds']})
        completed = api.compute_run(child, cancelled, persist, remaining)
        child.update(completed)
        used = min(allocation, consumed_before + completed.get('elapsed_seconds', remaining))
        child['budget_used_seconds'] = used
        batch['remaining_seconds'] += max(0, allocation - used)
        lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds']})
    lease.update({'children': batch['children'], 'remaining_seconds': batch['remaining_seconds'],
                  'status': 'completed', 'finished_at': api.now()}, finish=True)


RECOVERY_POLICIES = {
    'churn': {'label': 'Minimum churn', 'guarantees': ['Preserve current scenario rules'], 'objectives': ['Changed activities', 'Scenario score']},
    'deadlines': {'label': 'Protect deadlines', 'guarantees': ['Meet planned deadlines', 'Complete no later than baseline'], 'objectives': ['Supply cost', 'Changed activities']},
    'passengers': {'label': 'Protect passengers', 'guarantees': ['No ECLO', 'No excess capacity'], 'objectives': ['Weighted contract delay', 'Changed activities']},
    'p1': {'label': 'Protect P1', 'guarantees': ['Freeze Priority-1 activity weeks and ECLO assignments'], 'objectives': ['Scenario C score', 'Changed activities']},
    'custom': {'label': 'Custom', 'guarantees': ['Scenario C rules and accepted bookings'], 'objectives': ['Weighted preferences', 'Changed activities']},
}


def batch_reply(batch):
    api = server()
    return {'id': batch['id'], 'status': batch['status'], 'instance_id': batch['instance_id'],
            'baseline_id': batch['baseline_id'], 'seconds': batch['seconds'],
            'remaining_seconds': round(batch['remaining_seconds'], 3),
            'results': [{'philosophy': c.get('philosophy'), 'run': api.public_run(c),
                         'policy': {**RECOVERY_POLICIES.get(c.get('philosophy'), {}), 'scenario': c['scenario']}}
                        for c in batch['children']],
            'error': batch.get('error')}


class RecoveryRequest(Record):
    instance_id: str = Field(pattern=r'^[a-f0-9]{16}$')
    scenario: Literal['A', 'B', 'C']
    baseline_id: str
    overrides: list[Override] = Field(min_length=1, max_length=100)
    weights: Weights = Field(default_factory=Weights)
    philosophies: list[Philosophy] = Field(default_factory=lambda: ['churn', 'deadlines', 'passengers', 'p1', 'custom'], min_length=1, max_length=5)
    seconds: int = Field(default=90, ge=5, le=300)
    client_request_id: str = Field(default_factory=lambda: uuid4().hex, pattern=r'^[a-zA-Z0-9_-]{1,100}$')


@router.post('/api/disruptions/recoveries', status_code=202)
def create_recoveries(request: RecoveryRequest):
    api = server()
    baseline = api.run_for(request.baseline_id)
    if baseline['scenario'] != request.scenario or not (baseline.get('validation') or {}).get('feasible'):
        raise HTTPException(422, 'Choose a feasible baseline with the stated scenario.')
    if len(set(request.philosophies)) != len(request.philosophies):
        raise HTTPException(422, 'Recovery strategies must be unique.')
    scenarios = {'churn': request.scenario, 'deadlines': 'B', 'passengers': 'A', 'p1': 'C', 'custom': 'C'}
    body = request.model_dump(mode='json')
    fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:32]
    specs = [{'scenario': scenarios[p], 'philosophy': p, 'weights': request.weights,
              'overrides': request.overrides, 'label': f'Recovery · {p}'} for p in request.philosophies]
    batch = make_batch(request.instance_id, request.baseline_id, specs, request.seconds, batch_id=fingerprint)
    return {**batch_reply(batch), 'runs': [{'philosophy': c['philosophy'], 'run_id': c['id']} for c in batch['children']]}


@router.get('/api/disruptions/recoveries/{batch_id}')
def get_recoveries(batch_id: str):
    batch = server().get_run(batch_id)
    if batch.get('kind') != 'batch':
        raise HTTPException(404, 'Recovery batch not found.')
    return batch_reply(batch)


class AssessmentRequest(Record):
    seconds: int = Field(default=90, ge=3, le=300)


@router.post('/api/requests/{request_id}/assessment', status_code=202)
def assess_request(request_id: str, options: AssessmentRequest):
    api = server()
    request, control = request_context(request_id)
    if request['status'] in ('accepted', 'rejected'):
        raise HTTPException(409, 'This request has already been decided.')
    if not control['approved_run_id']:
        raise HTTPException(409, 'Approve a baseline plan before assessing a booking request.')
    baseline = api.run_for(control['approved_run_id'])
    instance = api.instance_for(request['instance_id'])
    overrides = [Override(**o) for o in baseline['overrides']]
    usage = {(c['location_id'], c['week']): c['used'] for c in baseline['validation']['capacity']}
    length = request['week_to'] - request['week_from'] + 1
    windows = [(request['week_from'], request['week_to'])]
    candidates = sorted(range(1, instance.weeks - length + 2), key=lambda w: (abs(w - request['week_from']), w))
    for first in candidates:
        last = first + length - 1
        if not (last < request['week_from'] or first > request['week_to']):
            continue
        a = instance.activities[request['activity_id']]
        room = any(w >= max(1, instance.week(a.planned_start_date)) and
                   not any(o.closed and o.week == w and o.location_id in instance.protected[a.activity_id] for o in overrides) and
                   all(usage.get((loc, w), 0) < capacity_at(instance, loc, w, overrides) for loc in instance.routes[a.activity_id])
                   for w in range(first, last + 1))
        if room:
            windows.append((first, last))
        if len(windows) == 3:
            break
    specs = [{'scenario': baseline['scenario'], 'label': 'Requested booking' if i == 0 else 'Alternative booking',
              'bookings': [Booking(request_id=request_id, activity_id=request['activity_id'], week_from=f, week_to=t)]}
             for i, (f, t) in enumerate(windows)]
    cache = [SOLVER_VERSION, request, baseline['id'], control['revision'], control['commitments'], options.seconds]
    # assessment_id itself is not an input to assessment cache identity.
    cache[1] = {k: v for k, v in request.items() if k not in ('assessment_id', 'counteroffer_run_id')}
    bid = hashlib.sha256(json.dumps(cache, sort_keys=True).encode()).hexdigest()[:32]
    batch = make_batch(instance.id, baseline['id'], specs, options.seconds, batch_id=bid,
                       metadata={'request_id': request_id, 'plan_revision': control['revision'], 'windows': windows})
    def link(current):
        assert_current(current, baseline['id'], control['revision'])
        current['requests'][request_id]['assessment_id'] = bid
        return current
    api.store.update('plans/' + instance.id, link)
    return assessment_reply(batch, request)


def assessment_reply(batch, request):
    api = server()
    baseline = api.run_for(batch['baseline_id'])
    options = []
    for i, child in enumerate(batch['children']):
        report = child.get('validation')
        feasible = child['status'] == 'completed' and bool(report and report['feasible'])
        booking = next(b for b in child['bookings'] if b.get('request_id') == request['id'])
        diff = child.get('diff') or {}
        changed = diff.get('changed_activities', [])
        delta = diff.get('score_delta')
        impact = 'BENEFICIAL' if feasible and delta is not None and delta < 0 else 'NONE' if feasible and not changed else 'LOW' if feasible and len(changed) <= 2 else 'MEDIUM' if feasible and len(changed) <= 5 else 'HIGH'
        options.append({'kind': 'REQUESTED' if i == 0 else 'ALTERNATIVE', 'run_id': child['id'],
                        'week_from': booking['week_from'], 'week_to': booking['week_to'], 'feasible': feasible,
                        'status': child['status'], 'impact': impact if report else None,
                        'score_before': baseline['validation']['score'], 'score_after': report['score'] if report else None,
                        'points': [{'tone': 'ok' if feasible else 'warn', 'text': f'{len(changed)} activities changed' if report else 'Waiting for a checked result'}],
                        'run': api.public_run(child)})
    first = options[0]
    current = plan_control(request['instance_id'])
    def utilisation(run):
        if not run.get('validation'):
            return None
        values = [r for r in run['validation']['capacity'] if r['location_id'] == request['location_id'] and request['week_from'] <= r['week'] <= request['week_to']]
        if any(r['used'] and not r['capacity'] for r in values):
            return None
        return round(max((100 * r['used'] / r['capacity'] for r in values if r['capacity']), default=0), 1)
    child = batch['children'][0]
    displaced = []
    before = {c['contract_number']: c for c in baseline['validation']['contracts']}
    after = {c['contract_number']: c for c in (child.get('validation') or {}).get('contracts', [])}
    instance = api.instance_for(request['instance_id'])
    for aid in (child.get('diff') or {}).get('changed_activities', []):
        cid = instance.activities[aid].contract_number
        days = after[cid]['overrun_days'] - before[cid]['overrun_days']
        displaced.append({'activity_id': aid, 'contract_number': cid, 'priority': instance.projects[cid].contract_priority,
                          'effect': f'{cid}: {days:+} overrun days', 'tone': 'crit' if days > 0 else 'ok'})
    return {'id': batch['id'], 'status': batch['status'], 'baseline_id': batch['baseline_id'],
            'plan_revision': batch['plan_revision'], 'stale': current['revision'] != batch['plan_revision'],
            'location_id': request['location_id'], 'capacity_before': utilisation(baseline), 'capacity_after': utilisation(child),
            'tiles': [{'label': 'Activities changed', 'value': str(len(displaced)), 'tone': 'warn' if displaced else 'ok', 'note': 'Against the approved baseline'}],
            'displaced': displaced, 'options': options,
            'draft_response': (f"A checked option reserves {request['activity_id']} in weeks {request['week_from']}–{request['week_to']}. Review the changes before accepting."
                               if first['feasible'] else 'The requested booking has no completed feasible option yet. Review alternatives or improve the search.'),
            'error': batch.get('error')}


@router.get('/api/requests/{request_id}/assessment')
def get_assessment(request_id: str):
    request, _ = request_context(request_id)
    if not request.get('assessment_id'):
        raise HTTPException(404, 'No assessment has been started for this request.')
    batch = server().get_run(request['assessment_id'])
    return assessment_reply(batch, request)


class DecisionRequest(Record):
    decision: Literal['accepted', 'rejected', 'countered']
    run_id: str | None = None
    expected_approved_run_id: str | None
    expected_revision: int = Field(ge=0)


@router.post('/api/requests/{request_id}/decision')
def decide_request(request_id: str, decision: DecisionRequest):
    api = server()
    request, _ = request_context(request_id)
    candidate = api.run_for(decision.run_id) if decision.run_id else None
    def decide(control):
        assert_current(control, decision.expected_approved_run_id, decision.expected_revision)
        record = control['requests'][request_id]
        if record['status'] in ('accepted', 'rejected'):
            raise HTTPException(409, 'This request has already been decided.')
        if decision.decision != 'rejected':
            batch = api.run_for(record['assessment_id']) if record.get('assessment_id') else None
            source = candidate
            while source and source.get('resume_from_id'):
                source = api.run_for(source['resume_from_id'])
            if not batch or not source or source.get('parent_id') != batch['id'] or batch['plan_revision'] != control['revision']:
                raise HTTPException(409, 'Reassess this request against the current approved plan.')
            for field in ('scenario', 'baseline_id', 'overrides', 'bookings', 'philosophy', 'weights'):
                if candidate.get(field) != source.get(field):
                    raise HTTPException(409, 'The improved option changed assessment constraints. Reassess before accepting.')
            adoption_report(candidate, request['instance_id'], control['commitments'])
            booking = next((b for b in candidate['bookings'] if b.get('request_id') == request_id), None)
            if not booking:
                raise HTTPException(409, 'The selected option does not guarantee this booking.')
            if decision.decision == 'accepted':
                control['commitments'][request_id] = booking
                control['approved_run_id'] = candidate['id']
                record['accepted_run_id'] = candidate['id']
                control['revision'] += 1
            else:
                record['counteroffer_run_id'] = candidate['id']
        record.update(status=decision.decision, decided_at=api.now())
        return control
    saved = api.store.update('plans/' + request['instance_id'], decide)
    return {'request': saved['requests'][request_id], 'plan': plan_reply(saved)}
