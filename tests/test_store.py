import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed, ServiceUnavailable

from trackaccess.store import Conflict, LeaseLost, StorageError, Store


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.counter = 0
        self.lock = threading.Lock()
        self.fail = False

    def blob(self, key):
        return FakeBlob(self, key)


class FakeBlob:
    def __init__(self, bucket, key):
        self.bucket, self.key = bucket, key
        self.generation = None

    def reload(self, **kwargs):
        if self.bucket.fail:
            raise ServiceUnavailable('offline')
        with self.bucket.lock:
            if self.key not in self.bucket.objects:
                raise NotFound('missing')
            self.generation = self.bucket.objects[self.key][0]

    def download_as_bytes(self, if_generation_match, **kwargs):
        with self.bucket.lock:
            version, content = self.bucket.objects[self.key]
            if version != if_generation_match:
                raise PreconditionFailed('changed')
            return content.encode()

    def upload_from_string(self, content, if_generation_match=None, **kwargs):
        if self.bucket.fail:
            raise ServiceUnavailable('offline')
        with self.bucket.lock:
            actual = self.bucket.objects.get(self.key, (0, ''))[0]
            if if_generation_match is not None and actual != if_generation_match:
                raise PreconditionFailed('changed')
            self.bucket.counter += 1
            self.generation = self.bucket.counter
            self.bucket.objects[self.key] = self.generation, content


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setenv('NIGHTSHIFT_DATA', str(tmp_path))
    monkeypatch.delenv('NIGHTSHIFT_GCS_BUCKET', raising=False)
    monkeypatch.delenv('NIGHTSHIFT_SNAPSHOT_URL', raising=False)
    now = [1000.0]
    bucket = FakeBucket()
    store = Store(bucket=bucket, clock=lambda: now[0])
    return store, bucket, now


def test_gcs_authoritative_across_instances(storage):
    store, bucket, now = storage
    store.put('instances/book', {'files': {'one.csv': 'a,b'}})
    store._path('instances/book').parent.mkdir(parents=True)
    store._path('instances/book').write_text('{"stale":true}')
    fresh = Store(bucket=bucket)
    assert fresh.get('instances/book') == {'files': {'one.csv': 'a,b'}}
    assert fresh.get('instances/missing') is None


def test_storage_failure_never_falls_back_to_local(storage):
    store, bucket, _ = storage
    store.put('runs/job', {'status': 'queued'})
    bucket.fail = True
    with pytest.raises(StorageError):
        store.put('runs/job', {'status': 'completed'})
    with pytest.raises(StorageError):
        store.get('runs/job')
    assert not store._path('runs/job').exists()
    bucket.fail = False
    assert store.get('runs/job')['status'] == 'queued'


def test_only_one_competing_worker_claims(storage):
    store, bucket, now = storage
    store.put('runs/job', {'status': 'queued'})
    stores = [Store(bucket=bucket, clock=lambda: now[0]) for _ in range(8)]
    with ThreadPoolExecutor(8) as pool:
        owners = list(pool.map(lambda s: s.claim_run('job'), stores))
    assert sum(owner is not None for owner in owners) == 1


def test_expiry_recovery_keeps_incumbent_and_fences_old_owner(storage):
    store, bucket, now = storage
    store.put('runs/job', {'status': 'queued', 'schedule': {'checked': True}})
    old = store.claim_run('job')
    now[0] += 61
    fresh = Store(bucket=bucket, clock=lambda: now[0]).claim_run('job')
    assert fresh.snapshot()['schedule'] == {'checked': True}
    with pytest.raises(LeaseLost):
        old.update({'status': 'completed'}, finish=True)
    fresh.update({'status': 'completed', 'score': 25.2}, finish=True)
    assert store.get('runs/job')['score'] == 25.2
    assert '_lease' not in store.get('runs/job')
    assert store.claim_run('job') is None


def test_generation_change_blocks_stale_owner_even_before_expiry(storage):
    store, _, _ = storage
    store.put('runs/job', {'status': 'queued'})
    owner = store.claim_run('job')
    store.put('runs/job', {'status': 'completed', 'score': 30})
    with pytest.raises(LeaseLost):
        owner.update({'score': 999})
    assert store.get('runs/job')['score'] == 30


def test_heartbeat_extends_ownership_without_losing_progress(storage):
    store, _, now = storage
    store.put('runs/job', {'status': 'queued'})
    owner = store.claim_run('job')
    owner.update({'schedule': {'score': 25.2}})
    now[0] += 50
    owner.update()
    now[0] += 20
    assert store.claim_run('job') is None
    assert store.get('runs/job')['schedule']['score'] == 25.2
    owner.update({'status': 'completed'}, finish=True)


def test_failed_heartbeat_does_not_extend_lease(storage):
    store, bucket, now = storage
    store.put('runs/job', {'status': 'queued'})
    owner = store.claim_run('job')
    now[0] += 30
    bucket.fail = True
    with pytest.raises(StorageError):
        owner.update()
    bucket.fail = False
    now[0] += 31
    assert store.claim_run('job') is not None


def test_local_storage_remains_compatible(storage):
    local = Store()
    local.put('runs/local', {'status': 'queued'})
    owner = local.claim_run('local')
    owner.update({'status': 'completed'}, finish=True)
    assert local.get('runs/local') == {'status': 'completed'}


def test_invalid_key_rejected_before_backend_access(storage):
    store, bucket, _ = storage
    with pytest.raises(ValueError):
        store.put('../escape', {})
    assert not bucket.objects
