import asyncio

from google.auth.exceptions import DefaultCredentialsError
import httpx
import pytest

from trackaccess import model
from trackaccess.api import health
from trackaccess.conversation import select_intent
from trackaccess.domain import Instance


@pytest.fixture(autouse=True)
def model_env(monkeypatch):
    for key in ("GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_CLOUD_PROJECT", "VERTEX_PROJECT", "VERTEX_MODEL", "VERTEX_LOCATION", "NIGHTSHIFT_CHAT_PROVIDER"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def instance():
    return Instance.from_directory("PS1/01_data")


def function_call(name, args=None):
    return {"candidates": [{"content": {"parts": [{"functionCall": {"name": name, "args": args or {}}}]}}]}


def vertex_mock(monkeypatch, response, status=200):
    monkeypatch.setenv("NIGHTSHIFT_CHAT_PROVIDER", "vertex")
    monkeypatch.setenv("VERTEX_PROJECT", "test-project")
    monkeypatch.setattr(model, "vertex_headers", lambda: {"Authorization": "Bearer runtime-test-token"})
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(status, json=response)

    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs))
    return requests


@pytest.mark.parametrize("location,host", [("global", "aiplatform.googleapis.com"), ("us-central1", "us-central1-aiplatform.googleapis.com")])
def test_vertex_routes_paraphrases_using_runtime_identity(monkeypatch, instance, location, host):
    requests = vertex_mock(monkeypatch, function_call("capacity"))
    monkeypatch.setenv("VERTEX_LOCATION", location)
    # This paraphrase is not understood by the keyword fallback.
    result = asyncio.run(select_intent("Where are we most squeezed for room?", instance))
    assert result == ("capacity", {}, "vertex", None)
    assert str(requests[0].url) == f"https://{host}/v1/projects/test-project/locations/{location}/publishers/google/models/gemini-3.8-flash:generateContent"
    assert requests[0].headers["authorization"] == "Bearer runtime-test-token"
    assert "x-goog-api-key" not in requests[0].headers
    assert health()["chat_provider"] == "vertex"
    assert health()["chat_configured"] is True


@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_vertex_failures_preserve_checked_evidence(monkeypatch, instance, status):
    vertex_mock(monkeypatch, {"error": {"message": "provider unavailable"}}, status)
    tool, args, mode, notice = asyncio.run(select_intent("Explain C006", instance))
    assert (tool, args, mode) == ("explain", {"entity_id": "C006"}, "evidence")
    assert notice


@pytest.mark.parametrize("response", [
    {"candidates": []}, {"candidates": None}, {"candidates": [{"content": {"parts": [{"text": "I changed your score"}]}}]},
    function_call("delete_schedule"), function_call("explain", {"entity_id": "C99999"}),
    function_call("explain", {"entity_id": ["C006"]}), function_call("explain", ["C006"]),
])
def test_unusable_model_response_falls_back(monkeypatch, instance, response):
    vertex_mock(monkeypatch, response)
    tool, args, mode, notice = asyncio.run(select_intent("Explain C006", instance))
    assert (tool, args, mode) == ("explain", {"entity_id": "C006"}, "evidence")
    assert notice


@pytest.mark.parametrize("message,expected,args", [
    ("Give me a handover", "summary", {}),
    ("Close this location", "clarify", {}),
    ("Preview scenario B", "preview_scenario", {"scenario": "B"}),
    ("Close SEC:BET:H01_H02:EB in week 22", "preview_capacity", {"location_id": "SEC:BET:H01_H02:EB", "week": 22, "capacity": 0, "closed": True}),
])
def test_model_cannot_invent_or_replace_preview_parameters(monkeypatch, instance, message, expected, args):
    vertex_mock(monkeypatch, function_call("preview_capacity", {"location_id": "invented", "week": 1, "capacity": 99}))
    assert asyncio.run(select_intent(message, instance)) == (expected, args, "vertex", None)


def test_model_cannot_hide_incomplete_change(monkeypatch, instance):
    vertex_mock(monkeypatch, function_call("summary"))
    assert asyncio.run(select_intent("Close this location", instance))[0] == "clarify"


def test_unavailable_runtime_credentials_fall_back(monkeypatch, instance):
    requests = vertex_mock(monkeypatch, function_call("capacity"))

    def unavailable():
        raise DefaultCredentialsError("No attached identity")

    monkeypatch.setattr(model, "vertex_headers", unavailable)
    assert asyncio.run(select_intent("Explain C006", instance))[2] == "evidence"
    assert requests == []


def test_adc_tokens_are_reused_and_refreshed(monkeypatch):
    class Credentials:
        valid = False
        token = None
        refreshes = 0

        def refresh(self, request):
            self.refreshes += 1
            self.token = f"token-{self.refreshes}"
            self.valid = True

    credentials = Credentials()
    monkeypatch.setattr(model, "_credentials", lambda: credentials)
    assert model.vertex_headers() == model.vertex_headers() == {"Authorization": "Bearer token-1"}
    assert credentials.refreshes == 1
    credentials.valid = False
    assert model.vertex_headers() == {"Authorization": "Bearer token-2"}


def test_provider_configuration_preserves_local_and_key_based_modes(monkeypatch):
    assert health()["chat_configured"] is False
    assert model.chat_config().provider == "evidence"
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert model.chat_config().provider == "gemini"
    monkeypatch.setenv("VERTEX_PROJECT", "test-project")
    assert model.chat_config().provider == "vertex"
    monkeypatch.setenv("NIGHTSHIFT_CHAT_PROVIDER", "evidence")
    assert health()["chat_configured"] is False


def test_missing_vertex_project_is_visible_fallback(monkeypatch, instance):
    monkeypatch.setenv("NIGHTSHIFT_CHAT_PROVIDER", "vertex")
    assert health()["chat_configured"] is False
    assert asyncio.run(select_intent("Explain C006", instance))[3]
