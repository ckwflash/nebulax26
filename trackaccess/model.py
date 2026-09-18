"""Server-side model access, using the attached Cloud Run identity for Vertex."""
import asyncio
from dataclasses import dataclass
from functools import lru_cache
import os
import threading

import google.auth
from google.auth.transport.requests import Request
import httpx


@dataclass(frozen=True)
class ChatConfig:
    provider: str
    model: str
    project: str = ""
    location: str = "global"

    @property
    def configured(self):
        return bool(self.project) if self.provider == "vertex" else self.provider == "gemini" and bool(os.getenv("GEMINI_API_KEY"))


def chat_config():
    provider = os.getenv("NIGHTSHIFT_CHAT_PROVIDER", "auto").lower()
    if provider == "auto":
        provider = "vertex" if os.getenv("VERTEX_PROJECT") else "gemini" if os.getenv("GEMINI_API_KEY") else "evidence"
    if provider == "vertex":
        return ChatConfig(provider, os.getenv("VERTEX_MODEL", "gemini-3.8-flash"),
                          os.getenv("VERTEX_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT", ""),
                          os.getenv("VERTEX_LOCATION", "global"))
    return ChatConfig(provider if provider in ("gemini", "evidence") else "evidence",
                      os.getenv("GEMINI_MODEL", "gemini-3.8-flash"))


_credential_lock = threading.Lock()


@lru_cache(maxsize=1)
def _credentials():
    return google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])[0]


class _BoundedAuthRequest(Request):
    def __call__(self, *args, **kwargs):
        kwargs["timeout"] = 5
        return super().__call__(*args, **kwargs)


def vertex_headers():
    # Refresh once across concurrent requests; never persist or expose the token.
    with _credential_lock:
        credentials = _credentials()
        if not credentials.valid:
            credentials.refresh(_BoundedAuthRequest())
        if not credentials.token:
            raise ValueError("No runtime identity token available")
        return {"Authorization": f"Bearer {credentials.token}"}


async def generate_content(config, payload):
    if config.provider == "vertex":
        if not config.project:
            raise ValueError("Vertex project is not configured")
        host = "aiplatform.googleapis.com" if config.location == "global" else f"{config.location}-aiplatform.googleapis.com"
        url = f"https://{host}/v1/projects/{config.project}/locations/{config.location}/publishers/google/models/{config.model}:generateContent"
        headers = await asyncio.wait_for(asyncio.to_thread(vertex_headers), timeout=6)
    else:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.model}:generateContent"
        headers = {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()
