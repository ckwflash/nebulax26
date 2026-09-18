import csv
import io
import json
import zipfile
from pathlib import Path

from .domain import Access, Completion, Occupancy, Schedule

SCHEMAS = {
    "SCHEDULE_ACCESS.csv": ("access", Access),
    "SCHEDULE_OCCUPANCY.csv": ("occupancy", Occupancy),
    "RESULTS.csv": ("results", Completion),
}


def csv_files(schedule: Schedule):
    files = {}
    for filename, (attribute, schema) in SCHEMAS.items():
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=list(schema.model_fields), lineterminator="\n")
        writer.writeheader()
        for row in sorted(getattr(schedule, attribute), key=lambda r: tuple(str(v) for v in r.model_dump().values())):
            writer.writerow(row.model_dump(mode="json"))
        files[filename] = output.getvalue()
    return files


def export_zip(schedule: Schedule):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in csv_files(schedule).items():
            archive.writestr(name, content)
    return buffer.getvalue()


def save_schedule(schedule: Schedule, folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for filename, content in csv_files(schedule).items():
        (folder / filename).write_text(content)
    (folder / "timing_witness.json").write_text(json.dumps(schedule.witness, indent=2))


def read_schedule(folder):
    folder = Path(folder)
    parts = {}
    for filename, (attribute, schema) in SCHEMAS.items():
        with (folder / filename).open(encoding="utf-8-sig", newline="") as f:
            parts[attribute] = [schema(**row) for row in csv.DictReader(f)]
    scenarios = {r.scenario for r in parts["results"]}
    if len(scenarios) != 1:
        raise ValueError("RESULTS.csv must contain exactly one scenario.")
    witness_file = folder / "timing_witness.json"
    return Schedule(scenario=scenarios.pop(), **parts, witness=json.loads(witness_file.read_text()) if witness_file.exists() else {})
