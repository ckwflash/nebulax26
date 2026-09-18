"""Atomic local persistence, optionally mirrored through a private R2 gateway."""
import json
import os
import re
from pathlib import Path
from uuid import uuid4

import httpx


class Store:
    def __init__(self):
        self.root = Path(os.getenv("NIGHTSHIFT_DATA", ".nightshift/store"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.remote = os.getenv("NIGHTSHIFT_SNAPSHOT_URL", "").rstrip("/")
        self.secret = os.getenv("NIGHTSHIFT_INTERNAL_SECRET", "")

    def _path(self, key):
        if not re.fullmatch(r"[a-zA-Z0-9_/-]+", key) or ".." in key:
            raise ValueError("Invalid storage key")
        return self.root / f"{key}.json"

    def put(self, key, value):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        content = json.dumps(value, separators=(",", ":"))
        temp = path.with_suffix(f".{uuid4().hex}.tmp")
        temp.write_text(content)
        temp.replace(path)
        if self.remote:
            # Do not let a failed mirror invalidate a locally verified incumbent.
            try:
                response = httpx.put(f"{self.remote}/{key}", content=content, headers={"Authorization": f"Bearer {self.secret}", "Content-Type": "application/json"}, timeout=10)
                response.raise_for_status()
            except httpx.HTTPError:
                import logging
                logging.getLogger(__name__).exception("Remote checkpoint failed for %s", key)

    def get(self, key):
        path = self._path(key)
        if path.exists():
            return json.loads(path.read_text())
        if self.remote:
            response = httpx.get(f"{self.remote}/{key}", headers={"Authorization": f"Bearer {self.secret}"}, timeout=10)
            if response.status_code == 200:
                value = response.json()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value))
                return value
        return None
