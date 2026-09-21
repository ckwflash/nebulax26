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

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import RULE_VERSION
from .domain import FILES, InputError, Instance, Override, Scenario, Schedule
from .export import export_zip, read_schedule
from .model import chat_config
from .solver import solve
from .store import Conflict, LeaseLost, StorageError, Store
from .planning import Booking, Philosophy, Weights, check_planning, objective_values, run_diff
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
    if not run and '--' in run_id:
        parent_id, index = run_id.rsplit('--', 1)
        try:
            parent = store.get(f'runs/{parent_id}')
        except ValueError:
            parent = None
        if parent and parent.get('kind') == 'batch' and index.isdigit():
            children = parent.get('children', [])
            if int(index) < len(children):
                run = children[int(index)]
    if not run:
        raise HTTPException(404, "Schedule version not found.")
    # Persisted feasibility belongs to the rules that checked it. Old exports
    # must not retain a green status after a safety-rule correction.
    if run.get('schedule') and (run.get('validation') or {}).get('rule_version') != RULE_VERSION:
        run = {**run, 'validation': checked_run(run)}
        run.update(solver_status='REVALIDATED', model_bound=None)
        run.pop('optimization', None)
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
    from .library import save_instance, register_run
    save_instance(instance)
    seed = BASE / "outputs/A"
    schedule = read_schedule(seed if (seed / "SCHEDULE_ACCESS.csv").exists() else BASE / "PS1/03_submission_sample")
    result = validate(instance, schedule)
    run_id = (f"reference-{instance.id}" if not result["feasible"] else f"public-A-{instance.id}") + '-' + RULE_VERSION.replace('.', '-')
    metadata = json.loads((seed / "report.json").read_text()) if result["feasible"] and (seed / "report.json").exists() else {}
    run = {"id": run_id, "instance_id": instance.id, "scenario": "A", "status": "completed", "label": "Public A" if result["feasible"] else "Reference A", "created_at": now(), "overrides": [], "baseline_id": None,
           "schedule": schedule.model_dump(mode="json"), "validation": result, "solver_status": "PRECOMPUTED" if result["feasible"] else "REFERENCE", "elapsed_seconds": 0, "model_bound": None}
    if metadata:
        run.update(solver_status=metadata.get("solver_status", "PRECOMPUTED"), elapsed_seconds=metadata.get("elapsed_seconds", 0), model_bound=metadata.get("model_bound"))
    run = store.update(f"runs/{run_id}", lambda old: old or run)
    register_run(run)
    from .workflows import initialize_plan
    initialize_plan(instance.id, run)
    return {"instance": instance.summary(), "run": run}


@app.post("/api/instances")
async def upload_instance(files: list[UploadFile] = File(...), name: str = Form(default='', max_length=120)):
    display_name = name.strip()
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
        label = display_name or (Path(files[0].filename or '').stem if len(files) == 1 else 'Uploaded demand book')
        instance = Instance(texts, label or 'Uploaded demand book')
    except (InputError, ValueError, UnicodeError, zipfile.BadZipFile) as exc:
        raise HTTPException(422, str(exc)) from exc
    from .library import save_instance
    instance = save_instance(instance, rename=bool(display_name))
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
    bookings: list[Booking] = Field(default_factory=list, max_length=500)
    philosophy: Philosophy | None = None
    weights: Weights = Field(default_factory=Weights)
    resume_from_id: str | None = None


def now():
    return datetime.now(timezone.utc).isoformat()


def public_run(run):
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if not k.startswith("_")}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value
    return clean(run)


@app.exception_handler(StorageError)
async def storage_error_handler(request, exc):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def checked_run(run, bookings=None):
    instance = instance_for(run['instance_id'])
    baseline = run_for(run['baseline_id']) if run.get('baseline_id') else None
    return check_planning(instance, Schedule(**run['schedule']),
                          validate(instance, Schedule(**run['schedule']), [Override(**o) for o in run.get('overrides', [])]),
                          run.get('bookings', []) if bookings is None else bookings, run.get('philosophy'),
                          Schedule(**baseline['schedule']) if baseline else None)


def compute_run(run, cancelled, persist, budget=None):
    instance = instance_for(run['instance_id'])
    baseline_run = run_for(run['baseline_id']) if run.get('baseline_id') else None
    baseline = Schedule(**baseline_run['schedule']) if baseline_run else None
    resume = run_for(run['resume_from_id']) if run.get('resume_from_id') else None
    incumbent = run.get('schedule') or (resume or {}).get('schedule')
    if not incumbent and baseline:
        retained = baseline.model_copy(deep=True)
        retained.scenario = run['scenario']
        for row in retained.results:
            row.scenario = run['scenario']
        incumbent = retained.model_dump(mode='json')
    if incumbent:
        candidate = {**run, 'schedule': incumbent}
        checked = checked_run(candidate)
        if checked['feasible']:
            run.update(schedule=incumbent, validation=checked)
        else:
            incumbent = None
            run.update(schedule=None, validation=None)
    run.update(status='running', started_at=run.get('started_at') or now())
    persist(public_run(run))
    last_save = 0
    checkpoint = None
    # Keep storage latency outside CP-SAT’s wall-clock computation allowance.
    # Coalesce progress while one fenced write is in flight; drain before completion.
    checkpoints = ThreadPoolExecutor(max_workers=1, thread_name_prefix="checkpoint")
    best = None
    def rank(schedule, report):
        return objective_values(instance, schedule, report, baseline, run.get('philosophy'), run.get('weights'))
    if run.get('schedule') and run.get('validation', {}).get('feasible'):
        best = (rank(Schedule(**run['schedule']), run['validation']), run['schedule'], run['validation'])

    def progress(schedule, report, metrics):
        nonlocal last_save, checkpoint
        if cancelled.is_set():
            return
        run.update(schedule=schedule.model_dump(mode='json'), validation=report, **metrics)
        if time.monotonic() - last_save > 1 and (checkpoint is None or checkpoint.done()):
            if checkpoint is not None and checkpoint.exception() is not None:
                cancelled.set()
                return
            checkpoint = checkpoints.submit(persist, public_run(run))
            checkpoint.add_done_callback(lambda done: cancelled.set() if done.exception() is not None else None)
            last_save = time.monotonic()

    seconds = run['seconds'] if budget is None else budget
    try:
        if seconds <= 0:
            result = {'schedule': run.get('schedule'), 'validation': run.get('validation'),
                      'solver_status': 'FEASIBLE' if run.get('schedule') else 'UNKNOWN',
                      'message': 'This option used its allocated budget before recovery. Improve it to continue.', 'elapsed_seconds': 0}
        else:
            result = solve(instance, run['scenario'], seconds, [Override(**o) for o in run['overrides']], baseline,
                           progress, cancel_event=cancelled, bookings=run.get('bookings', []),
                           philosophy=run.get('philosophy'), weights=run.get('weights'),
                           warm_start=Schedule(**incumbent) if incumbent else None)
    finally:
        checkpoints.shutdown(wait=True)
    if checkpoint is not None:
        checkpoint.result()
    if cancelled.is_set():
        raise LeaseLost('Run ownership or storage became unavailable')
    if not result.get('schedule') and run.get('schedule') and checked_run(run)['feasible']:
        result.update(schedule=run['schedule'], validation=checked_run(run), solver_status='FEASIBLE',
                      message='Retained the last complete checked incumbent.')
    if best and (not result.get('validation') or not result['validation']['feasible'] or rank(Schedule(**result['schedule']), result['validation']) > best[0]):
        result.update(schedule=best[1], validation=best[2], solver_status='FEASIBLE', message='Retained the better checked incumbent.')
        if result.get('optimization'):
            result['optimization']['proven_optimal'] = False
            for i, stage in enumerate(result['optimization']['stages']):
                stage['value'] = best[0][i]
                stage['status'] = 'FEASIBLE'
    run.update(result)
    run['status'] = 'completed' if run.get('schedule') else 'no_solution'
    if baseline_run and run.get('schedule'):
        run['diff'] = run_diff(baseline, Schedule(**run['schedule']), baseline_run['validation'], run['validation'])
    run['finished_at'] = now()
    return public_run(run)


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
        if run.get('kind') == 'batch':
            from .workflows import execute_batch
            execute_batch(run, lease, cancelled)
        else:
            def persist(changes):
                if cancelled.is_set():
                    raise LeaseLost('Run ownership was lost')
                lease.update(changes)
            completed = compute_run(run, cancelled, persist)
            stopped.set()
            lease.update(completed, finish=True)
    except (StorageError, LeaseLost):
        logging.getLogger(__name__).warning("Run %s paused; last durable checkpoint will be recovered", run_id)
    except Exception as exc:
        # Log the exception type, never uploaded input or credential-bearing responses.
        logging.getLogger(__name__).error("Run %s failed: %s", run_id, type(exc).__name__)
        if lease:
            try:
                stopped.set()
                failed = {"status": "failed", "error": "The planner failed. Retry the run or inspect the demand book.", "finished_at": now()}
                saved = lease.snapshot()
                if saved.get('kind') == 'batch':
                    failed['children'] = [{**c, 'status': 'failed', 'error': failed['error']} if c['status'] in ('queued', 'running') else c for c in saved['children']]
                lease.update(failed, finish=True)
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
    run = prepare_run(request)
    submit_job(run)
    return public_run(run)


def prepare_run(request, run_id=None):
    from .workflows import plan_control
    instance = instance_for(request.instance_id)
    control = plan_control(instance.id)
    inherited = list(control.get('commitments', {}).values())
    overrides = request.overrides
    if request.baseline_id:
        baseline = run_for(request.baseline_id)
        if baseline['instance_id'] != instance.id or baseline['status'] != 'completed' or not baseline.get('schedule'):
            raise HTTPException(422, 'Warm start must be a completed schedule for this demand book.')
        overrides = [Override(**o) for o in baseline.get('overrides', [])] + overrides
        inherited += baseline.get('bookings', [])
    if request.philosophy and not request.baseline_id:
        raise HTTPException(422, 'Recovery strategies require a baseline.')
    required = {'deadlines': 'B', 'passengers': 'A', 'p1': 'C', 'custom': 'C'}
    if request.philosophy in required and request.scenario != required[request.philosophy]:
        raise HTTPException(422, 'This recovery strategy requires scenario ' + required[request.philosophy] + '.')
    if request.resume_from_id:
        source = run_for(request.resume_from_id)
        if source['instance_id'] != instance.id:
            raise HTTPException(422, 'Improvement source belongs to another demand book.')
    overrides = list({(o.location_id, o.week): o for o in overrides}.values())
    for override in overrides:
        if override.location_id not in instance.supply or override.week > instance.weeks:
            raise HTTPException(422, 'Capacity change references an unknown location or week.')
    bookings = [Booking(**b) for b in inherited] + request.bookings
    for b in bookings:
        if b.activity_id not in instance.activities or b.week_to > instance.weeks:
            raise HTTPException(422, 'A booking references an unknown activity or week.')
    bookings = list({(b.request_id, b.activity_id, b.week_from, b.week_to): b for b in bookings}.values())
    return {**request.model_dump(), 'bookings': [b.model_dump() for b in bookings],
            'overrides': [o.model_dump() for o in overrides], 'id': run_id or uuid4().hex,
            'status': 'queued', 'created_at': now(), 'label': request.label or f'Scenario {request.scenario}',
            'schedule': None, 'validation': None, 'model_bound': None}


def submit_job(run, *, recovered=False):
    with job_lock:
        if run['id'] in active_jobs:
            return
        if len(active_jobs) >= 4:
            raise HTTPException(429, 'Four jobs are already admitted. Wait for one to finish.')
        if not recovered:
            store._write('runs/' + run['id'], run, 0)
        from .library import register_run
        register_run(run)
        active_jobs.add(run['id'])
        pool.submit(execute_run, run['id'])


class ImproveRequest(BaseModel):
    seconds: int = Field(default=300, ge=1, le=300)


@app.post('/api/runs/{run_id}/improve', status_code=202)
def improve_run(run_id: str, request: ImproveRequest):
    original = run_for(run_id)
    if original.get('kind') == 'batch' or original['status'] in ('queued', 'running'):
        raise HTTPException(409, 'Select a finished option to improve.')
    fields = {k: original[k] for k in RunRequest.model_fields if k in original}
    fields.update(seconds=request.seconds, resume_from_id=run_id, label='Improve · ' + original['label'])
    return start_run(RunRequest(**fields))


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = run_for(run_id)
    job = run_for(run['parent_id']) if run.get('parent_id') else run
    if job['status'] in ('queued', 'running') and job.get('_lease', {}).get('expires_at', 0) <= store.clock():
        try:
            submit_job(job, recovered=True)
        except HTTPException as exc:
            if exc.status_code != 429:
                raise
    if job['status'] == 'failed' and run['status'] in ('queued', 'running'):
        run = {**run, 'status': 'failed', 'error': job.get('error')}
    return public_run(run)


@app.get("/api/runs/{run_id}/export")
def download(run_id: str):
    run = run_for(run_id)
    if run["status"] != "completed" or not run.get("schedule"):
        raise HTTPException(409, "A complete schedule is not available yet.")
    instance = instance_for(run["instance_id"])
    schedule = Schedule(**run["schedule"])
    report = checked_run(run)
    if not report["feasible"]:
        raise HTTPException(409, "Export requires a complete schedule with checked safety.")
    return Response(export_zip(schedule), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="nightshift-{instance.id}-{schedule.scenario}-{run_id[-8:]}.zip"'})


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


@app.exception_handler(Conflict)
async def conflict_handler(request, exc):
    return JSONResponse(status_code=409, content={'detail': str(exc)})


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request, exc):
    details = ['.'.join(str(x) for x in error['loc'][1:]) + ': ' + error['msg'] for error in exc.errors()]
    return JSONResponse(status_code=422, content={'detail': '; '.join(details)})


from .report_routes import router as report_router
app.include_router(report_router)
from .workflows import router as workflow_router
app.include_router(workflow_router)
from .library import router as library_router
app.include_router(library_router)


# The portable container serves the built UI and API from the same origin.
# Keep this last so static routing cannot shadow API routes.
if (BASE / "dist/index.html").exists():
    app.mount("/", StaticFiles(directory=BASE / "dist", html=True), name="frontend")
