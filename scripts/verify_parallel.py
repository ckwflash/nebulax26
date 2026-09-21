#!/usr/bin/env python3
"""Benchmark cold and cached A/B/C batches against a hosted revision."""
import argparse
import io
import json
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx

from trackaccess.domain import Instance, Schedule
from trackaccess.validation import validate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dataset', action='append', default=[])
    parser.add_argument('--seconds', type=int, default=90)
    parser.add_argument('--cores', type=int, default=8)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--serial', action='store_true', help='Measure the previous serial API once for comparison')
    mode.add_argument('--cached-only', action='store_true', help='Verify existing cache after replacing the revision')
    args = parser.parse_args()
    report = {'url': args.url, 'started_at': datetime.now(timezone.utc).isoformat(),
              'seconds_per_scenario': args.seconds, 'datasets': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def save():
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    with httpx.Client(base_url=args.url, timeout=60) as client:
        def call(method, path, **kwargs):
            response = client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        report['health'] = call('GET', '/api/health')
        for directory in args.dataset or ['PS1/01_data', 'testdata/datasets/09_double_network', 'testdata/datasets/10_impossible_workload']:
            instance = Instance.from_directory(directory)
            book = call('POST', '/api/instances', files=[('files', (name, content, 'text/csv')) for name, content in instance.files.items()])
            endpoint = '/api/instances/' + book['id']
            before = call('GET', endpoint + '/plan')
            entry = {'dataset': directory, 'instance_id': book['id'], 'activities': len(instance.activities), 'runs': {}}
            report['datasets'].append(entry)
            modes = ('cold',) if args.serial else (('cached',) if args.cached_only else ('cold', 'cached'))
            for mode in modes:
                started = time.monotonic()
                payload = {'seconds': args.seconds, 'client_request_id': uuid4().hex}
                if not args.serial:
                    payload['force'] = mode == 'cold'
                batch = call('POST', endpoint + '/solve-all', json=payload)
                submission = time.monotonic() - started
                max_running = 0
                while batch['status'] in ('queued', 'running'):
                    max_running = max(max_running, sum(c['status'] == 'running' for c in batch['children']))
                    if time.monotonic() - started > args.seconds * 3 + 120:
                        raise AssertionError('Batch exceeded deadline')
                    time.sleep(.7)
                    batch = call('GET', '/api/runs/' + batch['id'])
                elapsed = time.monotonic() - started
                assert batch['status'] == 'completed', batch.get('error')
                if not args.serial:
                    assert batch['execution'] == 'parallel' and batch['parallel_workers'] == 3
                item = {'batch_id': batch['id'], 'wall_seconds': round(elapsed, 3),
                        'submission_seconds': round(submission, 3), 'max_running_observed': max_running, 'children': []}
                entry['runs'][mode] = item
                for child in batch['children']:
                    feasible = (child.get('validation') or {}).get('feasible', False)
                    if child.get('schedule'):
                        checked = validate(instance, Schedule(**child['schedule']))
                        assert checked['feasible'] and checked['coverage_percent'] == 100
                        assert checked['score'] == child['validation']['score']
                        exported = client.get('/api/runs/' + child['id'] + '/export')
                        exported.raise_for_status()
                        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
                            assert set(archive.namelist()) == {'SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv', 'RESULTS.csv'}
                    else:
                        assert child['solver_status'] == 'INFEASIBLE', child
                        assert client.get('/api/runs/' + child['id'] + '/export').status_code == 409
                    if not args.serial:
                        assert child['cache_hit'] == (mode == 'cached')
                    if mode == 'cached':
                        assert child['elapsed_seconds'] == 0
                    if not args.serial:
                        index = 'ABC'.index(child['scenario'])
                        threads, extra = divmod(args.cores, min(3, args.cores))
                        assert child['solver_threads'] == threads + int(index < extra)
                    item['children'].append({k: child.get(k) for k in (
                        'id', 'scenario', 'solver_status', 'elapsed_seconds', 'solver_threads',
                        'cache_hit', 'cached_from_id', 'started_at', 'finished_at')} | {
                            'feasible': feasible, 'score': (child.get('validation') or {}).get('score')})
                if mode == 'cold' and all(c.get('started_at') for c in batch['children']):
                    starts = [datetime.fromisoformat(c['started_at']) for c in batch['children']]
                    finishes = [datetime.fromisoformat(c['finished_at']) for c in batch['children']]
                    item['all_three_overlap_seconds'] = round((min(finishes) - max(starts)).total_seconds(), 3)
                print(json.dumps({'dataset': directory, 'mode': mode, **item}), flush=True)
                save()
            assert call('GET', endpoint + '/plan') == before, 'Solving changed the approved plan'
            entry['approved_plan_unchanged'] = True
            save()
    report['passed'] = True
    save()


if __name__ == '__main__':
    main()
