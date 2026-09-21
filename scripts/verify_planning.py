"""Hosted acceptance checks. Uses public/synthetic demo data; never prints credentials."""
import io
import json
import os
import time
import zipfile
from pathlib import Path

import httpx

base = os.environ['NIGHTSHIFT_VERIFY_URL'].rstrip('/')
client = httpx.Client(base_url=base, timeout=60)
report_path = Path(os.getenv('NIGHTSHIFT_VERIFY_REPORT', '.nightshift/deployment/planning-verification.json'))
report = {'url': base, 'runs': {}, 'checks': []}


def request(method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response


def wait(run, limit=430):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        run = request('GET', '/api/runs/' + run['id']).json()
        if run['status'] not in ('queued', 'running'):
            assert run['status'] != 'failed', run.get('error')
            return run
        time.sleep(1)
    raise AssertionError('Polling timed out')


def check(name):
    report['checks'].append(name)
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print('PASS ' + name, flush=True)


def plan(iid):
    return request('GET', f'/api/instances/{iid}/plan').json()


def expect(p):
    return {'expected_approved_run_id': p['approved_run_id'], 'expected_revision': p['revision']}


def adopt(iid, run):
    return request('POST', f'/api/instances/{iid}/plan/adopt', json={'run_id': run['id'], **expect(plan(iid))}).json()


def upload(path):
    if os.getenv('NIGHTSHIFT_VERIFY_NAMESPACE') and Path(path).name == '01_slack_baseline.zip':
        data = io.BytesIO()
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(data, 'w') as target:
            for name in source.namelist():
                content = source.read(name)
                if name == '01_LINES.csv': content += b'\n\n'
                target.writestr(name, content)
        return request('POST', '/api/instances', files={'files': ('verification-mini.zip', data.getvalue(), 'application/zip')}).json()
    with Path(path).open('rb') as stream:
        return request('POST', '/api/instances', files={'files': (Path(path).name, stream, 'application/zip')}).json()


assert 'RailPlan' in request('GET', '/').text
health = request('GET', '/api/health').json()
assert health['ok'] and health['chat_provider'] == 'vertex'
report['health'] = health
public = request('GET', '/api/demo').json()
book = upload('PS1.zip')
assert book['id'] == public['instance']['id']
original_plan = plan(book['id'])
for scenario, score in [('A', 137.9), ('B', 30), ('C', 62.7)]:
    done = wait(request('POST', '/api/runs', json={'instance_id': book['id'], 'scenario': scenario, 'seconds': 90, 'label': 'Planning deployment check ' + scenario}).json())
    assert done['validation']['feasible'] and done['validation']['coverage_percent'] == 100
    assert done['validation']['score'] == score
    blob = request('GET', '/api/runs/' + done['id'] + '/export').content
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert sorted(archive.namelist()) == ['RESULTS.csv', 'SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv']
        assert archive.testzip() is None
    report['runs'][scenario] = {'id': done['id'], 'score': score, 'seconds': done['elapsed_seconds']}
    check(f'public {scenario}: score {score}, full coverage, exact three-CSV export')
assert plan(book['id'])['approved_run_id'] == original_plan['approved_run_id']
chat = request('POST', '/api/chat', json={'instance_id': book['id'], 'run_id': report['runs']['A']['id'], 'message': 'Explain why C006 is late and cite the schedule evidence.'}).json()
assert chat['evidence'] and chat['mode'] == 'vertex', chat.get('notice')
report['chat_mode'] = chat['mode']
check('Vertex explanations with evidence; solves do not auto-adopt')

mini = upload('testdata/zips/01_slack_baseline.zip')
iid = mini['id']
base_run = wait(request('POST', '/api/runs', json={'instance_id': iid, 'scenario': 'A', 'seconds': 90}).json())
approved = adopt(iid, base_run)
a = mini['activities'][0]
week = min(r['week'] for r in base_run['schedule']['access'] if r['activity_id'] == a['activity_id'])
reqbody = {'instance_id': iid, 'contract_number': a['contract_number'], 'activity_id': a['activity_id'], 'location_id': a['route'][0], 'week_from': week, 'week_to': week, 'reason': 'Deployment smoke test: guaranteed activity access'}
booking = request('POST', '/api/requests', json=reqbody).json()
assessment = request('POST', f"/api/requests/{booking['id']}/assessment", json={'seconds': 90}).json()
wait(assessment)
assessment = request('GET', f"/api/requests/{booking['id']}/assessment").json()
option = next(o for o in assessment['options'] if o['kind'] == 'REQUESTED')
assert option['feasible']
assert request('POST', f"/api/requests/{booking['id']}/assessment", json={'seconds': 90}).json()['id'] == assessment['id']
alternative = next((o for o in assessment['options'] if o['kind'] == 'ALTERNATIVE' and o['feasible']), None)
if alternative:
    result = request('POST', f"/api/requests/{booking['id']}/decision", json={'decision': 'countered', 'run_id': alternative['run_id'], **expect(approved)}).json()
    assert result['plan']['approved_run_id'] == base_run['id']
result = request('POST', f"/api/requests/{booking['id']}/decision", json={'decision': 'accepted', 'run_id': option['run_id'], **expect(approved)}).json()
assert result['plan']['approved_run_id'] == option['run_id']
assert any(b['request_id'] == booking['id'] for b in result['plan']['commitments'])
assert client.post(f'/api/instances/{iid}/plan/adopt', json={'run_id': base_run['id'], **expect(approved)}).status_code == 409
assert plan(iid)['approved_run_id'] == option['run_id']
second = request('POST', '/api/requests', json={**reqbody, 'reason': 'Deployment rejection check'}).json()
rejected = request('POST', f"/api/requests/{second['id']}/decision", json={'decision': 'rejected', 'run_id': None, **expect(result['plan'])}).json()
assert rejected['plan']['approved_run_id'] == option['run_id']
report.update(instance_id=iid, approved_run_id=option['run_id'], request_id=booking['id'])
check('request assessment, cache, counteroffer, atomic acceptance, rejection and stale approval')

batch = request('POST', '/api/disruptions/recoveries', json={'instance_id': iid, 'scenario': 'A', 'baseline_id': option['run_id'], 'overrides': [{'location_id': a['route'][0], 'week': min(week + 1, mini['horizon_weeks']), 'capacity': 0, 'closed': True}]}).json()
finished = wait(batch)
recovery = request('GET', '/api/disruptions/recoveries/' + batch['id']).json()
assert [o['run']['scenario'] for o in recovery['results']] == ['A', 'B', 'A', 'C', 'C']
assert sum(c['budget_used_seconds'] for c in finished['children']) <= 90.01
for row in recovery['results']:
    child = row['run']
    assert child['status'] in ('completed', 'no_solution')
    if child['schedule']:
        assert child['validation']['feasible'] and child['validation']['coverage_percent'] == 100
        assert child['bookings']
        if child['scenario'] != 'A': assert child['diff']['score_delta'] is None
selected = next(o['run'] for o in recovery['results'] if o['run']['validation'] and o['run']['validation']['feasible'])
improved = wait(request('POST', '/api/runs/' + selected['id'] + '/improve', json={}).json())
for field in ('scenario', 'baseline_id', 'overrides', 'bookings', 'philosophy', 'weights'):
    assert improved[field] == selected[field], field
assert improved['validation']['feasible']
report.update(batch_id=batch['id'], improve_id=improved['id'])
check('five policies, shared budget, inherited bookings, separate scores and 300s improvement')

preview = request('POST', '/api/chat', json={'instance_id': iid, 'run_id': option['run_id'], 'message': 'Preview scenario C'}).json()
assert preview['preview']
preview_done = wait(preview['preview'])
assert preview_done['validation']['feasible'] and preview_done['diff']['score_delta'] is None
assert plan(iid)['approved_run_id'] == option['run_id']
check('chat preview polling and explicit adoption boundary')
report_path.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2), flush=True)
