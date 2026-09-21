"""Printable reports using the same current-rule checks as schedule exports."""
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import Field

from .domain import Record
from .reports import CATALOG, REPORT_IDS, render

router = APIRouter()


def report_inputs(report_id, run_id):
    from . import api

    if report_id not in REPORT_IDS:
        raise HTTPException(404, "Unknown report.")
    run = api.run_for(run_id)
    if run.get('kind') == 'batch' or run['status'] != 'completed' or not run.get('schedule'):
        raise HTTPException(409, "Reports need a completed schedule. Wait for the run to finish.")
    # Recheck commitments and corrected rules even when the stored report looks current.
    # Infeasible diagnostics remain viewable with a prominent non-issuable banner.
    run = {**run, 'validation': api.checked_run(run)}
    return api.instance_for(run['instance_id']), run


@router.get('/api/reports')
def list_reports():
    return [{**entry, 'format': 'HTML', 'generated_at': None} for entry in CATALOG]


class ReportRequest(Record):
    run_id: str = Field(min_length=1, max_length=64)


@router.post('/api/reports/{report_id}/generate')
def generate_report(report_id: str, request: ReportRequest):
    from .api import now

    render(report_id, *report_inputs(report_id, request.run_id))
    return {'download_url': f'/api/reports/{report_id}/download?' + urlencode({'run': request.run_id}),
            'generated_at': now()}


@router.get('/api/reports/{report_id}/download')
def download_report(report_id: str, run: str):
    return HTMLResponse(render(report_id, *report_inputs(report_id, run)))
