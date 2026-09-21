"""Verify hosted Vertex routing, checked evidence and explicit schedule previews."""
import io
import json
import os
from pathlib import Path
import time
import zipfile

import httpx


base = os.environ["NIGHTSHIFT_VERIFY_URL"].rstrip("/")
client = httpx.Client(base_url=base, timeout=45)


def request(method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


health = request("GET", "/api/health")
assert health["chat_configured"] and health["chat_provider"] == "vertex", health
demo = request("GET", "/api/demo")
baseline = demo["run"]
context = {"instance_id": demo["instance"]["id"], "run_id": baseline["id"]}
checks = []
for message, expected in [
    ("Where are we most squeezed for room? Inspect constrained location-weeks and shared possessions.", "capacity"),
    ("Walk me through C006's missed target.", "explain"),
    ("Give the next shift a concise briefing on this plan.", "summary"),
    ("Preview scenario B", "preview_scenario"),
]:
    result = request("POST", "/api/chat", json={**context, "message": message})
    assert result["mode"] == "vertex" and result["tool"] == expected, {k: result.get(k) for k in ("mode", "tool", "notice")}
    assert not result.get("notice")
    if expected == "explain":
        assert "A036 needs 7 work units" in result["answer"]
        assert any(e["id"] == "bound:A036" for e in result["evidence"])
    if expected == "preview_scenario":
        preview = result["preview"]
        assert preview["baseline_id"] == baseline["id"]
        deadline = time.monotonic() + 180
        while preview["status"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(1)
            preview = request("GET", f"/api/runs/{preview['id']}")
        assert preview["status"] == "completed"
        assert preview["validation"]["score"] == 30
        assert preview["validation"]["coverage_percent"] == 100
    checks.append({"tool": expected, "mode": result["mode"], "evidence_count": len(result["evidence"])})
    print(f"Vertex {expected}: passed", flush=True)

unchanged = request("GET", f"/api/runs/{baseline['id']}")
assert unchanged["schedule"] == baseline["schedule"] and unchanged["scenario"] == "A"
incomplete = request("POST", "/api/chat", json={**context, "message": "Close this location"})
assert incomplete["tool"] == "clarify" and incomplete["preview"] is None

# Read earlier completed runs to check that the deployment retained durable state.
previous = json.loads(Path(".nightshift/deployment/verification.json").read_text())
saved_scores = {}
for scenario, expected in [("A", 137.9), ("B", 30), ("C", 62.7)]:
    run = request("GET", f"/api/runs/{previous['runs'][scenario]['id']}")
    assert run["status"] == "completed" and run["validation"]["score"] == expected
    assert run["validation"]["coverage_percent"] == 100
    saved_scores[scenario] = run["validation"]["score"]
response = client.get(f"/api/runs/{preview['id']}/export")
response.raise_for_status()
with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
    assert set(archive.namelist()) == {"SCHEDULE_ACCESS.csv", "SCHEDULE_OCCUPANCY.csv", "RESULTS.csv"}
    assert archive.testzip() is None

report = {"url": base, "health": health, "routing": checks, "baseline_unchanged": True,
          "incomplete_change_clarifies": True, "preview_id": preview["id"],
          "preview_score": 30, "saved_scores": saved_scores, "export_verified": True}
Path(".nightshift/deployment/vertex-verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
