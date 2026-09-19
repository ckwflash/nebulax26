from __future__ import annotations

import io
import json
import os
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .domain import FILES, InputError, Instance, Override, Scenario, Schedule
from .export import export_zip, read_schedule
from .model import chat_config
from .solver import solve
from .store import LeaseLost, StorageError, Store
from .validation import validate

app = FastAPI(title="Nightshift", version="0.1.0")
store = Store()
pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="solver")
active_jobs = set()
job_lock = threading.RLock()
BASE = Path(__file__).resolve().parent.parent


def instance_for(instance_id):
    try:
        saved = store.get(f"instances/{instance_id}")
    except ValueError:
        raise HTTPException(422, "Invalid demand-book identifier.")
    if not saved:
        raise HTTPException(404, "Demand book not found. Upload the eight CSV files again.")
    return Instance(saved["files"], saved["name"])


def run_for(run_id):
    try:
        run = store.get(f"runs/{run_id}")
    except ValueError:
        run = None
    if not run:
        raise HTTPException(404, "Schedule version not found.")
    return run


@app.get("/api/health")
def health():
    config = chat_config()
    return {"ok": True, "validation": "local", "chat_configured": config.configured,
            "chat_provider": config.provider, "chat_model": config.model if config.configured else None}


@app.get("/api/demo")
def demo():
    instance = Instance.from_directory(BASE / "PS1/01_data")
    instance.name = "NebulaX · public demand book"
    store.put(f"instances/{instance.id}", {"files": instance.files, "name": instance.name})
    seed = BASE / "outputs/A"
    schedule = read_schedule(seed if (seed / "SCHEDULE_ACCESS.csv").exists() else BASE / "PS1/03_submission_sample")
    result = validate(instance, schedule)
    run_id = f"reference-{instance.id}" if not result["feasible"] else f"public-A-{instance.id}"
    metadata = json.loads((seed / "report.json").read_text()) if result["feasible"] and (seed / "report.json").exists() else {}
    run = {"id": run_id, "instance_id": instance.id, "scenario": "A", "status": "completed", "label": "Public A" if result["feasible"] else "Reference A", "created_at": now(), "overrides": [], "baseline_id": None,
           "schedule": schedule.model_dump(mode="json"), "validation": result, "solver_status": "PRECOMPUTED" if result["feasible"] else "REFERENCE", "elapsed_seconds": 0, "model_bound": None}
    if metadata:
        run.update(solver_status=metadata.get("solver_status", "PRECOMPUTED"), elapsed_seconds=metadata.get("elapsed_seconds", 0), model_bound=metadata.get("model_bound"))
    store.put(f"runs/{run_id}", run)
    return {"instance": instance.summary(), "run": run}


@app.post("/api/instances")
async def upload_instance(files: list[UploadFile] = File(...)):
    if not 1 <= len(files) <= 8:
        raise HTTPException(422, "Upload eight CSVs or one ZIP containing them.")
    texts = {}
    total = 0
    try:
        for upload in files:
            blob = await upload.read(5_000_001)
            total += len(blob)
            if total > 5_000_000:
                raise InputError("Uploads must total at most 5 MB.")
            if (upload.filename or "").lower().endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                    size = 0
                    for entry in archive.infolist():
                        name = Path(entry.filename).name
                        if name not in FILES.values() or "__MACOSX" in entry.filename:
                            continue
                        size += entry.file_size
                        if size > 5_000_000:
                            raise InputError("Expanded CSV files exceed 5 MB.")
                        if name in texts:
                            raise InputError(f"Duplicate {name} in upload.")
                        texts[name] = archive.read(entry).decode("utf-8-sig")
            else:
                name = Path(upload.filename or "").name
                if name not in FILES.values() or name in texts:
                    raise InputError(f"Unexpected or duplicate file: {name}.")
                texts[name] = blob.decode("utf-8-sig")
        instance = Instance(texts, "Uploaded demand book")
    except (InputError, ValueError, UnicodeError, zipfile.BadZipFile) as exc:
        raise HTTPException(422, str(exc)) from exc
    store.put(f"instances/{instance.id}", {"files": instance.files, "name": instance.name})
    return instance.summary()


@app.get("/api/instances/{instance_id}")
def get_instance(instance_id: str):
    return instance_for(instance_id).summary()


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instance_id: str = Field(pattern=r"^[a-f0-9]{16}$")
    scenario: Scenario
    seconds: int = Field(default=90, ge=1, le=300)
    baseline_id: str | None = None
    overrides: list[Override] = Field(default_factory=list, max_length=100)
    label: str = Field(default="", max_length=100)


def now():
    return datetime.now(timezone.utc).isoformat()


def public_run(run):
    return {key: value for key, value in run.items() if not key.startswith("_")}


@app.exception_handler(StorageError)
async def storage_error_handler(request, exc):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def execute_run(run_id):
    import logging
    lease = None
    stopped = threading.Event()
    cancelled = threading.Event()
    heartbeat_thread = None
    run = None
    try:
        lease = store.claim_run(run_id)
        if lease is None:
            return
        run = lease.snapshot()

        def heartbeat():
            while not stopped.wait(10):
                try:
                    lease.update()
                except (StorageError, LeaseLost):
                    cancelled.set()
                    logging.getLogger(__name__).warning("Run %s lost durable ownership; stopping search", run_id)
                    return

        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        heartbeat_thread.start()
        instance = instance_for(run["instance_id"])
        overrides = [Override(**o) for o in run["overrides"]]
        baseline_run = run_for(run["baseline_id"]) if run.get("baseline_id") else None
        baseline_data = run.get("schedule") or (baseline_run or {}).get("schedule")
        baseline = Schedule(**baseline_data) if baseline_data else None
        if baseline:
            retained = baseline.model_copy(deep=True)
            retained.scenario = run["scenario"]
            for row in retained.results:
                row.scenario = run["scenario"]
            checked = validate(instance, retained, overrides)
            if checked["feasible"]:
                run.update(schedule=retained.model_dump(mode="json"), validation=checked)
        run.update(status="running", started_at=now())
        lease.update(public_run(run))
        last_save = 0

        def progress(schedule, report, metrics):
            nonlocal last_save
            if cancelled.is_set():
                return
            run.update(schedule=schedule.model_dump(mode="json"), validation=report, **metrics)
            if time.monotonic() - last_save > 1:
                try:
                    lease.update(public_run(run))
                    last_save = time.monotonic()
                except (StorageError, LeaseLost):
                    cancelled.set()

        result = solve(instance, run["scenario"], run["seconds"], overrides, baseline, progress, cancel_event=cancelled)
        if cancelled.is_set():
            raise LeaseLost("Run ownership or storage became unavailable")
        if not result["schedule"] and run.get("schedule"):
            checked = validate(instance, Schedule(**run["schedule"]), overrides)
            if checked["feasible"]:
                result.update(schedule=run["schedule"], validation=checked, solver_status="FEASIBLE", message="Retained a previously checked incumbent after this search timed out.")
        run.update(result)
        run["status"] = "completed" if run.get("schedule") else "no_solution"
        if baseline_run and run.get("schedule"):
            before = {(r["activity_id"], r["week"], r["eclo"]) for r in baseline_run["schedule"]["access"]}
            after = {(r["activity_id"], r["week"], r["eclo"]) for r in run["schedule"]["access"]}
            run["diff"] = {"changed_activities": sorted({r[0] for r in before ^ after}), "removed_accesses": len(before - after), "added_accesses": len(after - before), "score_delta": round(run["validation"]["score"] - baseline_run["validation"]["score"], 1)}
        stopped.set()
        lease.update({**public_run(run), "finished_at": now()}, finish=True)
    except (StorageError, LeaseLost):
        logging.getLogger(__name__).warning("Run %s paused; last durable checkpoint will be recovered", run_id)
    except Exception as exc:
        # Log the exception type, never uploaded input or credential-bearing responses.
        logging.getLogger(__name__).error("Run %s failed: %s", run_id, type(exc).__name__)
        if lease:
            try:
                stopped.set()
                lease.update({"status": "failed", "error": "The planner failed. Retry the run or inspect the demand book.", "finished_at": now()}, finish=True)
            except (StorageError, LeaseLost):
                pass
    finally:
        stopped.set()
        if heartbeat_thread:
            heartbeat_thread.join(timeout=12)
        with job_lock:
            active_jobs.discard(run_id)


@app.post("/api/runs", status_code=202)
def start_run(request: RunRequest):
    instance = instance_for(request.instance_id)
    overrides = request.overrides
    if request.baseline_id:
        baseline = run_for(request.baseline_id)
        if baseline["instance_id"] != instance.id or not baseline.get("schedule"):
            raise HTTPException(422, "Warm start must be a schedule for this demand book.")
        # Overrides accumulate so a second preview does not silently remove a closure.
        overrides = [Override(**o) for o in baseline.get("overrides", [])] + overrides
    merged = {(o.location_id, o.week): o for o in overrides}
    overrides = list(merged.values())
    for override in overrides:
        if override.location_id not in instance.supply or override.week > instance.weeks:
            raise HTTPException(422, "Capacity change references an unknown location or week.")
    with job_lock:
        if len(active_jobs) >= 4:
            raise HTTPException(429, "Four runs are already queued. Wait for one to finish.")
        run_id = uuid4().hex
        run = {**request.model_dump(), "overrides": [o.model_dump() for o in overrides], "id": run_id, "status": "queued", "created_at": now(), "label": request.label or f"Scenario {request.scenario}", "schedule": None, "validation": None}
        store.put(f"runs/{run_id}", run)
        active_jobs.add(run_id)
        pool.submit(execute_run, run_id)
    return run


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = run_for(run_id)
    with job_lock:
        if run["status"] in ("queued", "running") and run_id not in active_jobs and run.get("_lease", {}).get("expires_at", 0) <= store.clock():
            if len(active_jobs) < 4:
                active_jobs.add(run_id)
                pool.submit(execute_run, run_id)
                run["status"] = "queued"
                run["message"] = "Restarting from the last saved checkpoint."
    return public_run(run)


@app.get("/api/runs/{run_id}/export")
def download(run_id: str):
    run = run_for(run_id)
    if not run.get("schedule"):
        raise HTTPException(409, "A complete schedule is not available yet.")
    instance = instance_for(run["instance_id"])
    schedule = Schedule(**run["schedule"])
    report = validate(instance, schedule, [Override(**o) for o in run["overrides"]])
    if not report["feasible"]:
        raise HTTPException(409, "Export requires a complete schedule with checked safety.")
    return Response(export_zip(schedule), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="nightshift-{schedule.scenario}-{run_id[:8]}.zip"'})


class ChatRequest(BaseModel):
    instance_id: str = Field(pattern=r"^[a-f0-9]{16}$")
    run_id: str
    message: str = Field(min_length=1, max_length=3000)


@app.post("/api/chat")
async def chat(request: ChatRequest):
    from .conversation import respond
    run = run_for(request.run_id)
    if run["instance_id"] != request.instance_id or not run.get("schedule"):
        raise HTTPException(422, "Select a completed schedule for this demand book first.")
    return await respond(instance_for(request.instance_id), run, request.message, start_run)


# The portable container serves the built UI and API from the same origin.
# Keep this last so static routing cannot shadow API routes.
if (BASE / "dist/index.html").exists():
    app.mount("/", StaticFiles(directory=BASE / "dist", html=True), name="frontend")
