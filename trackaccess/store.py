"""Atomic local storage and authoritative, generation-checked GCS storage."""
import copy
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from uuid import uuid4

try:
    import fcntl
except ModuleNotFoundError:  # Windows dev box; the cross-process file lease is POSIX-only
    fcntl = None

from google.api_core.exceptions import GoogleAPIError, NotFound, PreconditionFailed
from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY

GCS_RETRY = DEFAULT_RETRY.with_deadline(8)


class StorageError(RuntimeError):
    """Persistence is unavailable; callers must not report a successful save."""


class Conflict(RuntimeError):
    pass


class LeaseLost(RuntimeError):
    pass


class Store:
    def __init__(self, *, bucket=None, clock=time.time):
        self.root = Path(os.getenv("NIGHTSHIFT_DATA", ".nightshift/store"))
        self.root.mkdir(parents=True, exist_ok=True)
        name = os.getenv("NIGHTSHIFT_GCS_BUCKET", "")
        self.bucket = bucket if bucket is not None else (storage.Client().bucket(name) if name else None)
        self.clock = clock
        self.lock = threading.RLock()

    def _path(self, key):
        if not re.fullmatch(r"[a-zA-Z0-9_/-]+", key) or ".." in key:
            raise ValueError("Invalid storage key")
        return self.root / f"{key}.json"

    def _read(self, key):
        path = self._path(key)
        if self.bucket is not None:
            for _ in range(5):
                blob = self.bucket.blob(f"{key}.json")
                try:
                    blob.reload(timeout=10, retry=GCS_RETRY)
                except NotFound:
                    return None, 0
                except GoogleAPIError as exc:
                    raise StorageError("Durable storage is unavailable. Please retry.") from exc
                version = int(blob.generation)
                try:
                    content = blob.download_as_bytes(if_generation_match=version, timeout=10, retry=GCS_RETRY)
                    return json.loads(content), version
                except (NotFound, PreconditionFailed):
                    # reload() pins the download to a generation. A concurrent
                    # checkpoint replacement can remove that generation (404)
                    # without removing the run. Re-read current metadata.
                    continue
                except GoogleAPIError as exc:
                    raise StorageError("Durable storage is unavailable. Please retry.") from exc
            raise StorageError("Schedule changed while reading. Please retry.")
        if path.exists():
            content = path.read_bytes()
            return json.loads(content), hashlib.sha256(content).hexdigest()
        return None, 0

    def _write(self, key, value, version=None):
        path = self._path(key)
        content = json.dumps(value, separators=(",", ":"))
        if self.bucket is not None:
            blob = self.bucket.blob(f"{key}.json")
            try:
                blob.upload_from_string(content, content_type="application/json", if_generation_match=version, timeout=10, retry=GCS_RETRY)
                return int(blob.generation)
            except PreconditionFailed as exc:
                raise Conflict("Object generation changed") from exc
            except GoogleAPIError as exc:
                raise StorageError("Durable storage is unavailable. Please retry.") from exc
        with self.lock, (self.root / ".write-lock").open("a") as lockfile:
            if fcntl is not None:
                fcntl.flock(lockfile, fcntl.LOCK_EX)
            try:
                current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else 0
                if version is not None and version != current:
                    raise Conflict("Local checkpoint changed")
                path.parent.mkdir(parents=True, exist_ok=True)
                temp = path.with_suffix(f".{uuid4().hex}.tmp")
                temp.write_text(content)
                temp.replace(path)
            finally:
                if fcntl is not None:
                    fcntl.flock(lockfile, fcntl.LOCK_UN)
        return hashlib.sha256(content.encode()).hexdigest()

    def put(self, key, value):
        self._write(key, value)

    def get(self, key):
        return self._read(key)[0]

    def claim_run(self, run_id):
        key = f"runs/{run_id}"
        for _ in range(5):
            value, version = self._read(key)
            if not value or value.get("status") not in ("queued", "running"):
                return None
            now = self.clock()
            if value.get("_lease", {}).get("expires_at", 0) > now:
                return None
            owner = uuid4().hex
            value.update(status="running", _lease={"owner": owner, "expires_at": now + 60})
            try:
                generation = self._write(key, value, version)
                return RunLease(self, key, owner, value, generation)
            except Conflict:
                continue
        return None


class RunLease:
    """Owner writes, including heartbeat and completion, share one CAS stream."""
    def __init__(self, store, key, owner, value, version):
        self.store, self.key, self.owner = store, key, owner
        self.value, self.version = value, version
        self.lock = threading.RLock()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.value)

    def update(self, changes=None, *, finish=False):
        with self.lock:
            now = self.store.clock()
            lease = self.value.get("_lease", {})
            if lease.get("owner") != self.owner or lease.get("expires_at", 0) <= now:
                raise LeaseLost("Run ownership expired")
            updated = copy.deepcopy(self.value)
            updated.update(copy.deepcopy(changes or {}))
            if finish:
                updated.pop("_lease", None)
            else:
                updated["_lease"] = {"owner": self.owner, "expires_at": now + 60}
            try:
                version = self.store._write(self.key, updated, self.version)
            except Conflict as exc:
                raise LeaseLost("Another worker owns this run") from exc
            self.value, self.version = updated, version
