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

    def list_blobs(self, prefix, **kwargs):
        from types import SimpleNamespace
        if self.fail:
            raise ServiceUnavailable("offline")
        return [SimpleNamespace(name=name) for name in self.objects if name.startswith(prefix)]


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


def test_checkpoint_replacement_during_download_is_not_a_missing_run(storage, monkeypatch):
    store, bucket, _ = storage
    store.put('runs/job', {'status': 'running', 'progress': 1})
    original = FakeBlob.download_as_bytes
    calls = []

    def replaced(blob, **kwargs):
        calls.append(blob.generation)
        if len(calls) == 1:
            store.put('runs/job', {'status': 'running', 'progress': 2})
            # GCS can return 404 for the old generation selected by reload().
            raise NotFound('requested generation no longer exists')
        return original(blob, **kwargs)

    monkeypatch.setattr(FakeBlob, 'download_as_bytes', replaced)
    assert store.get('runs/job') == {'status': 'running', 'progress': 2}
    assert len(calls) == 2 and calls[0] != calls[1]


def test_actual_deletion_during_download_is_confirmed_by_fresh_metadata(storage, monkeypatch):
    store, bucket, _ = storage
    store.put('runs/job', {'status': 'running'})

    def deleted(blob, **kwargs):
        del bucket.objects[blob.key]
        raise NotFound('object was deleted')

    monkeypatch.setattr(FakeBlob, 'download_as_bytes', deleted)
    assert store.get('runs/job') is None


@pytest.mark.parametrize('failure', [NotFound, PreconditionFailed])
def test_continuous_generation_churn_returns_storage_error_not_false_absence(storage, monkeypatch, failure):
    store, _, _ = storage
    store.put('runs/job', {'status': 'running'})
    attempts = []

    def changed(blob, **kwargs):
        attempts.append(blob.generation)
        raise failure('generation changed during read')

    monkeypatch.setattr(FakeBlob, 'download_as_bytes', changed)
    with pytest.raises(StorageError, match='changed while reading'):
        store.get('runs/job')
    assert len(attempts) == 5


def test_batch_lease_fences_children_and_control_cas(storage):
    store, bucket, now = storage
    children = [{'id': 'batch--0', 'status': 'completed', 'schedule': {'checked': True}},
                {'id': 'batch--1', 'status': 'running', 'allocated_seconds': 18}]
    store.put('runs/batch', {'kind': 'batch', 'status': 'queued', 'children': children, 'remaining_seconds': 54})
    old = store.claim_run('batch')
    now[0] += 61
    with ThreadPoolExecutor(4) as pool:
        claims = list(pool.map(lambda _: Store(bucket=bucket, clock=lambda: now[0]).claim_run('batch'), range(4)))
    owners = [c for c in claims if c]
    assert len(owners) == 1
    with pytest.raises(LeaseLost):
        old.update({'children': []})
    assert owners[0].snapshot()['children'] == children
    assert owners[0].snapshot()['remaining_seconds'] == 54
    store.put('plans/book', {'approved': 'a', 'commitments': []})
    _, generation = store._read('plans/book')
    Store(bucket=bucket).update('plans/book', lambda old: {'approved': 'b', 'commitments': ['request1']})
    with pytest.raises(Conflict):
        store._write('plans/book', {'approved': 'c', 'commitments': []}, generation)
    assert store.get('plans/book') == {'approved': 'b', 'commitments': ['request1']}


def test_listing_uses_authoritative_bucket_and_surfaces_failure(storage):
    store, bucket, _ = storage
    store.put('instances/saved', {'saved': True})
    local = Store()
    local.put('instances/local-only', {'saved': False})
    assert store.keys('instances') == ['instances/saved']
    assert 'instances/local-only' in local.keys('instances')
    bucket.fail = True
    with pytest.raises(StorageError):
        store.keys('instances')
