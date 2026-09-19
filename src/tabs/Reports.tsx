// Spec section 13 — Reports. The submission bundle is real (/api/runs/{id}/export);
// the document pack is waiting on backend support and says so rather than pretending.

import { usePlan } from "../state/plan";

const PENDING: [string, string, "PDF" | "XLSX", string][] = [
  [
    "Management summary",
    "For the executive team",
    "PDF",
    "Two pages: feasibility, delays, priority impacts, ECLO use and the main risks carried into the period.",
  ],
  [
    "Risk & resilience report",
    "For the planning team",
    "PDF",
    "Fragility scores with their drivers, the congested weeks and locations, and the options that would strengthen the plan.",
  ],
  [
    "Contractor access pack",
    "For each contractor",
    "PDF",
    "One section per contractor: booked possessions, dates, locations, weekly limits and anything awaiting confirmation.",
  ],
  [
    "Delay and ECLO register",
    "For commercial review",
    "PDF",
    "Contract-by-contract completion against deadline, with every ECLO night and the reason it was needed.",
  ],
];

export function Reports() {
  const plan = usePlan();
  const v = plan.validation;
  const s = v.soft_scores;

  const bundle = [
    { name: "SCHEDULE_ACCESS.csv", detail: `${v.detail?.nights_scheduled ?? "—"} access nights across ${v.total_activities} activities` },
    { name: "SCHEDULE_OCCUPANCY.csv", detail: `every location and co-share group the plan books` },
    { name: "RESULTS.csv", detail: `${plan.contracts.length} contracts with simulated completion and overrun` },
  ];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Reports</h1>
          <span className="muted small">
            Generated from the current run · scenario {plan.scenario} · {plan.solverStatus}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="h2">Submission bundle</span>
              <span className="small muted">The three official CSVs for this scenario, straight from the run</span>
            </div>
            <div style={{ flex: 1 }} />
            <span className={v.feasible ? "pill p-ok" : "pill p-crit"}>
              {v.feasible ? "0 violations" : `${v.hard_violations.length} violations`}
            </span>
          </div>

          {bundle.map((b) => (
            <div key={b.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
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
                {v.coverage_percent}% · {v.completed_activities}/{v.total_activities} activities
              </span>
            </div>
            <div>
              <span>Overrun</span>
              <span>
                {s.overrun_days_total} days across {s.contracts_overrunning} contracts
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
              <span>{v.safety_verified ? "Witness verified" : "Unverified"}</span>
            </div>
          </div>

          <a className="btn btn-primary" href={`/api/runs/${plan.runId}/export`}>
            Download submission bundle (.zip)
          </a>
          <span className="small muted">
            Served by the planning service for run {plan.runId}. Contains the three CSVs exactly as the validator
            reads them.
          </span>
        </div>

        <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="h2">Document pack</span>
              <span className="small muted">Formatted reports for people who do not read CSVs</span>
            </div>
            <div style={{ flex: 1 }} />
            <span className="pill p-grey">Awaiting backend</span>
          </div>

          <div className="callout c-amber">
            These need <span className="mono">GET /api/reports</span> and{" "}
            <span className="mono">POST /api/reports/&#123;id&#125;/generate</span>. The figures they would carry are
            already in this run — nothing else is missing.
          </div>

          {PENDING.map((r) => (
            <div
              key={r[0]}
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
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r[0]}</span>
                <div style={{ flex: 1 }} />
                <span className={r[2] === "PDF" ? "pill p-crit" : "pill p-ok"}>{r[2]}</span>
              </div>
              <span className="small muted">{r[1]}</span>
              <span className="small muted" style={{ lineHeight: 1.5 }}>
                {r[3]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
