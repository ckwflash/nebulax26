"""Index existing GCS datasets/runs without changing any solver or approval record."""
import argparse
import json
import os
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from google.cloud import storage
from google.oauth2.credentials import Credentials

from trackaccess import api
from trackaccess.library import dataset_entry, summary
from trackaccess.domain import Instance
from trackaccess.store import Store


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report', default='.nightshift/deployment/library-migration.json')
    args = parser.parse_args()
    token = subprocess.run(['/private/tmp/google-cloud-sdk/bin/gcloud', 'auth', 'print-access-token'],
                           env={**os.environ, 'CLOUDSDK_CONFIG': '/private/tmp/codex-gcloud-config'},
                           capture_output=True, text=True, check=True).stdout.strip()
    bucket = storage.Client(project=args.project, credentials=Credentials(token)).bucket(args.bucket)
    store = Store(bucket=bucket)
    grouped = defaultdict(dict)
    keys = store.keys('runs')
    with ThreadPoolExecutor(max_workers=12) as readers:
        for key, run in zip(keys, readers.map(store.get, keys)):
            if not run or not run.get('instance_id') or not run.get('created_at'):
                continue
            children = run.get('children', [run])
            if any(not all(c.get(field) for field in ('id', 'scenario', 'status', 'created_at')) for c in children):
                continue
            grouped[run['instance_id']][run['id']] = {
                'id': run['id'], 'created_at': run['created_at'], 'finished': False,
                'runs': [summary(c) for c in children]}
    datasets = {}
    for key in store.keys('instances'):
        record = store.get(key)
        instance = Instance(record['files'], record['name'])
        datasets[instance.id] = dataset_entry(instance, record)
    if args.apply:
        store.update('catalog/instances', lambda old: {**datasets, **(old or {})})
        for iid, jobs in grouped.items():
            if iid not in datasets:
                continue
            store.update('history/' + iid, lambda old: {'jobs': {**jobs, **(old or {}).get('jobs', {})}})
    report = {'applied': args.apply, 'datasets': len(datasets), 'jobs_scanned': len(keys),
              'indexed_jobs': sum(len(jobs) for iid, jobs in grouped.items() if iid in datasets),
              'indexed_versions': sum(len(job['runs']) for iid, jobs in grouped.items() if iid in datasets for job in jobs.values()),
              'run_and_approval_records_unchanged': True}
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
