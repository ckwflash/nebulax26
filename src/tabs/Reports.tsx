import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ReportEntry } from "../api/types";
import { available, usePlanState, usePlan } from "../state/plan";

const FORMAT_PILL: Record<ReportEntry["format"], string> = {
  PDF: "pill p-crit",
  XLSX: "pill p-ok",
  CSV: "pill p-ok",
  HTML: "pill p-info",
};

type Made = { url: string; at: string } | { error: string } | "working";

/** The document pack: catalogue from GET /api/reports, one generate call per report. */
function DocumentPack({ runId }: { runId: string }) {
  const [catalog, setCatalog] = useState<ReportEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Keyed by report and run, so switching scenario never offers a link to the old run's report.
  const [made, setMade] = useState<Record<string, Made>>({});

  useEffect(() => {
    let alive = true;
    api
      .reports()
      .then((list) => alive && setCatalog(list))
      .catch(
        (e: unknown) =>
          alive &&
          setFailed(
            e instanceof Error
              ? e.message
              : "The report list could not be loaded.",
          ),
      );
    return () => {
      alive = false;
    };
  }, []);

  const generate = async (id: string) => {
    const key = `${id}:${runId}`;
    setMade((m) => ({ ...m, [key]: "working" }));
    try {
      const done = await api.generateReport(id, runId);
      setMade((m) => ({
        ...m,
        [key]: { url: done.download_url, at: done.generated_at },
      }));
    } catch (e) {
      setMade((m) => ({
        ...m,
        [key]: { error: e instanceof Error ? e.message : "Generation failed." },
      }));
    }
  };

  return (
    <div
      className="card"
      style={{
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="h2">Document pack</span>
          <span className="small muted">
            Formatted reports for people who do not read CSVs
          </span>
        </div>
      </div>

      {failed && <div className="callout c-red">{failed}</div>}
      {!catalog && !failed && (
        <span className="small muted">Loading the report list…</span>
      )}
      {catalog && (
        <span className="small muted">
          Each report opens as a printable page for run{" "}
          <span className="mono">{runId}</span>. Use the browser's Print → Save
          as PDF for a paper copy.
        </span>
      )}

      {catalog?.map((r) => {
        const state = made[`${r.id}:${runId}`];
        return (
          <div
            key={r.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "11px 12px",
              border: "1px solid #e6e9ef",
              borderRadius: 7,
              background: "#fbfcfd",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.name}</span>
              <span className={FORMAT_PILL[r.format] ?? "pill p-grey"}>
                {r.format}
              </span>
              <div style={{ flex: 1 }} />
              {state && typeof state === "object" && "url" in state ? (
                <a
                  className="btn btn-sm btn-primary"
                  href={state.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open report
                </a>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => generate(r.id)}
                  disabled={state === "working"}
                >
                  {state === "working" ? "Generating…" : "Generate"}
                </button>
              )}
            </div>
            <span className="small muted">
              {r.audience} · {r.size_hint}
            </span>
            <span className="small muted" style={{ lineHeight: 1.5 }}>
              {r.description}
            </span>
            {state && typeof state === "object" && "error" in state && (
              <span className="small" style={{ color: "#a12a22" }}>
                {state.error}
              </span>
            )}
            {state && typeof state === "object" && "at" in state && (
              <span className="small muted">
                Generated {new Date(state.at).toLocaleTimeString()}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Reports() {
  const plan = usePlan();
  const { run } = usePlanState();
  const v = plan.validation;
  const s = v.soft_scores;

  const bundle = [
    {
      name: "SCHEDULE_ACCESS.csv",
      detail: `${v.detail?.nights_scheduled ?? "—"} access nights across ${v.total_activities} activities`,
    },
    {
      name: "SCHEDULE_OCCUPANCY.csv",
      detail: `every location and co-share group the plan books`,
    },
    {
      name: "RESULTS.csv",
      detail: `${plan.contracts.length} contracts with simulated completion and overrun`,
    },
  ];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Reports</h1>
          <span className="muted small">
            Generated from the current run · scenario {plan.scenario} ·{" "}
            {plan.solverStatus}
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div
          className="card"
          style={{
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="h2">Submission bundle</span>
              <span className="small muted">
                The three official CSVs for this scenario, straight from the run
              </span>
            </div>
            <div style={{ flex: 1 }} />
            <span className={v.feasible ? "pill p-ok" : "pill p-crit"}>
              {v.feasible
                ? "0 violations"
                : `${v.hard_violations.length} violations`}
            </span>
          </div>

          {bundle.map((b) => (
            <div
              key={b.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
              }}
            >
              <span className="mono" style={{ fontWeight: 600, width: 210 }}>
                {b.name}
              </span>
              <span className="muted" style={{ flex: 1 }}>
                {b.detail}
              </span>
            </div>
          ))}

          <div className="divider" />
          <div className="kv">
            <div>
              <span>Objective score</span>
              <span style={{ fontWeight: 600 }}>{v.score}</span>
            </div>
            <div>
              <span>Coverage</span>
              <span>
                {v.coverage_percent}% · {v.completed_activities}/
                {v.total_activities} activities
              </span>
            </div>
            <div>
              <span>Overrun</span>
              <span>
                {s.overrun_days_total} days across {s.contracts_overrunning}{" "}
                contracts
              </span>
            </div>
            <div>
              <span>ECLO / excess nights</span>
              <span>
                {s.eclo_nights_total} / {s.excess_access_nights_total}
              </span>
            </div>
            <div>
              <span>Rule version</span>
              <span>{v.rule_version}</span>
            </div>
            <div>
              <span>Safety</span>
              <span>
                {v.safety_verified ? "Checks completed" : "Unverified"}
              </span>
            </div>
          </div>

          {available(run) ? (
            <a
              className="btn btn-primary"
              href={`/api/runs/${plan.runId}/export`}
            >
              Download submission bundle (.zip)
            </a>
          ) : (
            <div className="callout c-red">
              A completed feasible schedule is required for export.
            </div>
          )}
          <span className="small muted">
            Served by the planning service for run {plan.runId}. Contains the
            three CSVs exactly as the validator reads them.
          </span>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {run?.status === "completed" && (
            <DocumentPack key={run.id} runId={run.id} />
          )}
          <div className="card" style={{ padding: 18 }}>
            <h2 className="h2">Run summary</h2>
            <p>
              Scenario {plan.scenario} · {plan.solverStatus}
            </p>
            <p className="small muted">
              Local independent validation: {v.validation_authority}. Official
              judging acceptance is separate.
            </p>
            <p className="small muted">
              Risk and confidence indicators elsewhere in RailPlan are frontend
              heuristics, not solver guarantees.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
