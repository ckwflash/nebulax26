#!/usr/bin/env python3
"""Verify the frontend stress requests against hosted, independently checked solves."""
import argparse
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import time
from uuid import uuid4

import httpx

from trackaccess.domain import Instance, Override, Schedule
from trackaccess.validation import validate


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cases_path = args.output.with_name('stress-cases.json')
    subprocess.run(['node', 'scripts/check_frontend.mjs', '/src/data/stress.check.ts'],
                   env={**os.environ, 'STRESS_CASES_PATH': str(cases_path)}, check=True)
    cases = json.loads(cases_path.read_text())
    public = Instance.from_directory('PS1/01_data')
    files = dict(public.files)
    rows = list(csv.DictReader(io.StringIO(files['07_PROJECT_DETAILS.csv'])))
    rows[0]['contract_description'] += ' stress verification ' + uuid4().hex[:8]
    stream = io.StringIO(); writer = csv.DictWriter(stream, fieldnames=rows[0].keys())
    writer.writeheader(); writer.writerows(rows); files['07_PROJECT_DETAILS.csv'] = stream.getvalue()
    instance = Instance(files, 'Stress regression')
    report = {'url': args.url, 'instance_id': instance.id, 'cases': []}
    def save():
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    with httpx.Client(base_url=args.url, timeout=60) as client:
        def call(method, path, **kwargs):
            r = client.request(method, path, **kwargs); r.raise_for_status(); return r.json()
        def wait(run):
            end = time.monotonic() + 180
            while run['status'] in ('queued', 'running'):
                assert time.monotonic() < end
                time.sleep(.5); run = call('GET', '/api/runs/' + run['id'])
            return run
        call('POST', '/api/instances', data={'name': 'Stress regression'},
             files=[('files', (name, content, 'text/csv')) for name, content in files.items()])
        endpoint = '/api/instances/' + instance.id
        initial = call('GET', endpoint + '/plan')
        batch = wait(call('POST', endpoint + '/solve-all', json={'seconds': 90}))
        baselines = {c['scenario']: c for c in batch['children']}
        assert all(c['validation']['feasible'] for c in baselines.values())
        report['baselines'] = {s: {'id': r['id'], 'score': r['validation']['score']} for s, r in baselines.items()}
        save()
        for scenario, index in [('A', 0), ('B', 0), ('C', 0), ('C', 1), ('A', 2)]:
            selected = [c for c in cases if c['scenario'] == scenario][index]
            baseline = baselines[scenario]
            started = time.monotonic()
            done = wait(call('POST', '/api/runs', json={'instance_id': instance.id, 'scenario': scenario,
                        'baseline_id': baseline['id'], 'seconds': 30, 'overrides': selected['overrides'],
                        'label': selected['name']}))
            assert done['status'] in ('completed', 'no_solution'), done
            checked = None
            if done.get('schedule'):
                checked = validate(instance, Schedule(**done['schedule']), [Override(**o) for o in selected['overrides']])
                assert checked['feasible'] == done['validation']['feasible']
                assert checked['score'] == done['validation']['score']
                assert checked['coverage_percent'] == 100
                if checked['feasible']:
                    assert checked['score'] > baseline['validation']['score']
                else:
                    assert scenario == 'B' and done['deadline_relaxed']
                    assert {v['rule'] for v in checked['hard_violations']} == {'planned_date'}
            else:
                assert done['solver_status'] == 'INFEASIBLE'
            exported = client.get('/api/runs/' + done['id'] + '/export')
            assert exported.status_code == (200 if checked and checked['feasible'] else 409)
            entry = {'scenario': scenario, 'preset': selected['name'], 'run_id': done['id'],
                     'before': baseline['validation']['score'], 'after': checked['score'] if checked else None,
                     'feasible': checked['feasible'] if checked else False, 'solver_status': done['solver_status'],
                     'overrun_days': checked['soft_scores']['overrun_days_total'] if checked else None,
                     'changed_activities': len(done.get('diff', {}).get('changed_activities', [])),
                     'wall_seconds': round(time.monotonic() - started, 2), 'passed': True}
            report['cases'].append(entry); save(); print(json.dumps(entry), flush=True)
        assert call('GET', endpoint + '/plan') == initial
        report.update(passed=True, approved_plan_unchanged=True)
        save()


if __name__ == '__main__':
    main()
