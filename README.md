# Nightshift

A working railway access planner for NebulaX PS1: CP-SAT scheduling, independent local validation, timeline and capacity views, conversational explanations, immutable what-if previews, and CSV exports.

For the required deliverables and a clean source archive, see [the submission checklist](docs/SUBMISSION.md). Run `python3 scripts/package_submission.py` to create `release/nightshift-source.zip` from the current files, including uncommitted source changes.

## Run locally

Requirements: Python 3.11+, Node 22+, and `uv`.

```sh
uv sync --extra test
npm ci
npm run dev
```

Open http://127.0.0.1:5173. `npm run dev` starts the Python API, waits for it to be ready, then starts Vite. The API runs at http://127.0.0.1:8000; API documentation is at `/docs`. Ctrl+C stops both services. `bash scripts/dev.sh` runs the same launcher. Alternatively run `uv run uvicorn trackaccess.api:app --port 8000` and `npm run dev:ui` in separate terminals (add `--env-file .env` to the API command if needed).

Local development uses the included public schedule and local storage by default; it does not need the hosted demo or cloud credentials. `/api/demo` is served by the local Python API. Keep `NIGHTSHIFT_GCS_BUCKET` empty for local storage. If the page reports a service error, check the API logs and retry; requests time out after 30 seconds instead of leaving the loading screen stuck.

The app opens with the locally checked public A schedule. Choose Use A/B/C in Scenario results to use that scenario immediately, expand a contract, ask the control room about it, or upload eight CSV files/a ZIP. Uploads solve all three scenarios concurrently; saved feasible results are reused when switching. Previews do not automatically replace the selected schedule. Export is enabled only for complete, locally checked schedules.

## Conversation

No API key is required for deterministic evidence mode. It recognises contract/activity explanations, schedule summaries, bottleneck requests, scenario previews and fully specified capacity changes. It does not pretend to be an unrestricted language model.

The Google Cloud deployment uses **Vertex AI / Gemini 3.8 Flash** to select scheduling tools from natural-language requests. It authenticates with the attached Cloud Run service account; no API key or downloadable service-account key is needed. Explanations and scores come from checked schedule evidence. Model output never sets scores, supplies unconfirmed change parameters or adopts a schedule. Provider errors and quota limits fall back to computed evidence with a visible notice.

To use Vertex locally, copy `.env.example` to `.env`, set `NIGHTSHIFT_CHAT_PROVIDER=vertex`, `VERTEX_PROJECT` to your Google Cloud project, and configure Application Default Credentials (`gcloud auth application-default login`). The identity needs `aiplatform.endpoints.predict` and the project needs the Vertex AI API enabled. `VERTEX_LOCATION` defaults to `global`; `VERTEX_MODEL` defaults to `gemini-3.8-flash`. Restart the dev script after configuration changes. Alternatively, set `GEMINI_API_KEY` with provider `auto` or `gemini` to use the Gemini Developer API. Set provider `evidence` to disable model calls.

Examples:

- `Why is C006 late?`
- `Explain A036`
- `Preview an on-time plan`
- `Compare scenario C`
- `Where are the bottlenecks?`
- `Close SEC:BET:H01_H02:EB in week 22`
- `Set capacity 2 at SEC:ALP:S01_S02:WB in week 8`

Hard closures forbid work/protection at a location for the whole selected week in every scenario. Supply reductions change nominal capacity and may be offset by B/C's permitted excess access. These are different controls.

## Solver and public results

Standard solves and previews use a 90-second budget. Improve allows up to five minutes. The solver stops early when it proves optimality; at the time limit, it retains the best complete, checked schedule found.

```sh
uv run python -m trackaccess inspect --instance PS1/01_data
uv run python -m trackaccess solve --scenario all --seconds 90 --out outputs
uv run python -m trackaccess validate --submission outputs/A
```

| Scenario | Local penalty | Contract-overrun days | ECLO accesses | Extra location-nights |
|---|---:|---:|---:|---:|
| A | 137.9 | 28 | 0 | 0 |
| B | 30.0 | 0 | 6 | 0 |
| C | 62.7 | 7 | 4 | 0 |

All three reach proven optima in the implemented local model. A matches the reference sample's corrected 137.9 penalty. Contract delay is charged using the sum of all member activity weights, including activities that finished early. The public instance solves in a few seconds on the development machine; performance on other hardware/instances varies. The solver's status/bound and analytical bounds are separately reported.

`outputs/{A,B,C}` contains the required three CSVs plus a local `report.json` and `timing_witness.json`. The download ZIP contains **only the three required CSVs**. `submissions/public-results.zip` packages all three scenario folders for submission. Keep the local sidecars for reproducibility, but do not add them to a three-file submission.

**No official validator is supplied.** The checker now reproduces all 49 closure errors reported for the rejected A export on September 19. It checks weekly closure groups directly from the three CSVs, and the supplied reference passes those checks. Nightshift-generated schedules also retain an auxiliary timing witness. The earlier 25.2 A/C results used an incorrect closure model. The subsequent A=32.2/C=26.1 results also used incorrect per-activity delay scoring. Both are superseded by the table above; the unchanged closure-corrected A ZIP scores 137.9 under the corrected contract-based formula. See [the rule ledger](docs/RULES.md) for interpretations and limitations; local checks are not official acceptance.

## Verification

```sh
uv run pytest -q
npm run build
```

Tests include public optima, 100 seeded known-feasible instances (different IDs, ordering, routes, priorities and possession types), malformed uploads, independent mutation checks, asynchronous jobs, exports, 30 deterministic conversation intents, model outage fallback, and the updated cross-contract FS+0 rule. Synthetic cases establish regression coverage, not a claim to match hidden-instance performance.

## Google Cloud deployment

The demo is live at [Nightshift on Google Cloud Run](https://nightshift-717753975344.us-central1.run.app). See [the deployment and operations guide](docs/CLOUD_RUN.md) for the temporary project, durable storage, verification results and manual shutdown commands. The container serves the UI and API together and accepts the hosting platform's `PORT` value.

## Handoff

- Python implementation: `trackaccess/`
- React controller: `src/`
- Local rules and source update: `docs/RULES.md`
- Three-minute demonstration outline: `docs/DEMO.md`
- CI: `.gitlab-ci.yml`

The original data-pack README and participant brief remain intact. The configured origin is on GitHub; the brief asks for a GitLab repository URL. A GitLab submission URL and published YouTube video still need to be supplied.


## Additional testing datasets

`testdata/nightshift-test-datasets.zip` contains ten individual upload ZIPs covering deadlines, ECLO, sharing, exclusive possessions, cross-contract predecessors, Live interchange protection, continuity windows, priority pressure, scaling and expected infeasibility. Extract the collection, then upload one individual ZIP in the app. See [the dataset guide](testdata/README.md) for independent expected outcomes and [the test report](testdata/TEST_RESULTS.md) for local and Cloud Run results. The collection is generated by `scripts/generate_test_datasets.py`; `scripts/test_datasets.py` runs the solver/API matrix.
