"""Package the current source tree without dependencies, runtime state or history."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    ".dockerignore", ".env.example", ".gcloudignore", ".gitignore", ".gitlab-ci.yml",
    "Dockerfile", "README.md", "EDA.md", "LTA_DataMall_API_User_Guide.pdf", "PS1.zip",
    "index.html", "package.json", "package-lock.json", "pyproject.toml",
    "requirements.lock", "uv.lock", "tsconfig.json", "vite.config.ts",
    "testdata/README.md", "testdata/TEST_RESULTS.md", "testdata/manifest.json",
    "testdata/nightshift-test-datasets.zip",
)
SOURCE_TREES = (
    "trackaccess", "src", "scripts", "tests", "docs", "PS1", "outputs", "submissions",
    "testdata/datasets", "testdata/zips", "testdata/results/scoring-fix",
)
SKIP_PARTS = {"__pycache__", "node_modules", "dist", "build", "release"}


def source_files():
    paths = {ROOT / name for name in ROOT_FILES}
    for name in SOURCE_TREES:
        folder = ROOT / name
        if not folder.is_dir():
            raise FileNotFoundError(f"Missing source directory: {folder}")
        for path in folder.rglob("*"):
            parts = path.relative_to(ROOT).parts
            if any(p.startswith(".") or p in SKIP_PARTS or p.endswith(".egg-info") for p in parts):
                continue
            if path.suffix in {".pyc", ".pyo", ".tsbuildinfo"}:
                continue
            if path.is_file():
                paths.add(path)
    for path in sorted(paths):
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Expected a regular source file: {path}")
        yield path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "release", help="Output directory")
    args = parser.parse_args()
    # Read the snapshot before writing any generated artifacts.
    snapshot = [(p.relative_to(ROOT).as_posix(), p.read_bytes(), p.stat().st_mode & 0o777)
                for p in source_files()]
    required_csvs = {"SCHEDULE_ACCESS.csv", "SCHEDULE_OCCUPANCY.csv", "RESULTS.csv"}
    with zipfile.ZipFile(ROOT / "submissions/public-results.zip") as public:
        expected = {f"{s}/{n}" for s in "ABC" for n in required_csvs}
        if set(public.namelist()) != expected or len(public.namelist()) != len(expected):
            raise ValueError("Public results ZIP must contain exactly three CSVs per scenario")
        for name in expected:
            if public.read(name) != (ROOT / "outputs" / name).read_bytes():
                raise ValueError(f"Public results differ from outputs/{name}")
    args.out.mkdir(parents=True, exist_ok=True)
    archive = args.out / "nightshift-source.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name, content, mode in snapshot:
            info = zipfile.ZipInfo(f"nightshift/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            out.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    manifest = {
        "archive": archive.name,
        "snapshot": "current working files, including uncommitted source",
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "archive_bytes": archive.stat().st_size,
        "source_bytes": sum(len(content) for _, content, _ in snapshot),
        "file_count": len(snapshot),
        "files": [{"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                  for name, content, _ in snapshot],
    }
    (args.out / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2))
    print(f"Written to {args.out.resolve()}")


if __name__ == "__main__":
    main()
