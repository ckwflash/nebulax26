// Spec sections 2.2–2.3 — top bar and main area. The crumb and the feasibility pill
// come from the loaded run rather than being fixed text.

import { useState, type ReactNode } from "react";
import type { ScenarioId } from "../api/types";
import { SCENARIO_LABEL, usePlanState } from "../state/plan";
import { Nav } from "./Nav";
import { UploadDialog } from "./UploadDialog";
import { TAB_TITLE, type TabId } from "./tabs";

const SCENARIOS: ScenarioId[] = ["A", "B", "C"];

function TopBar({
  current,
  go,
  onUpload,
}: {
  current: TabId;
  go: (t: TabId) => void;
  onUpload: () => void;
}) {
  const { plan, status, error, solving, solvingLabel, switchScenario } = usePlanState();
  const feasible = plan?.validation.feasible;
  const crumb = plan
    ? `${plan.name} · Scenario ${plan.scenario} (${SCENARIO_LABEL[plan.scenario]}) · ${feasible ? "Feasible" : "Check violations"}`
    : status === "loading"
      ? "Loading the demand book…"
      : "No plan loaded";

  return (
    <header
      style={{
        height: 56,
        borderBottom: "1px solid #dfe3ea",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        gap: 16,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>{TAB_TITLE[current]}</span>
        <span
          style={{ fontSize: 11.5, color: "#5b6578", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {crumb}
        </span>
      </div>
      <div style={{ flex: 1 }} />

      {plan && (
        <div className="seg" role="group" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <button
              key={s}
              className={plan.scenario === s ? "on" : ""}
              disabled={solving}
              title={`Scenario ${s} — ${SCENARIO_LABEL[s]}`}
              onClick={() => plan.scenario !== s && switchScenario(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <button className="btn btn-sm" onClick={onUpload} disabled={solving} title="Load your own instance CSVs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4M7 9l5-5 5 5" />
          <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </svg>
        Load demand book
      </button>

      <button className="btn btn-sm" onClick={() => go("ask")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M12 8v3M12 13v.5" />
        </svg>
        Ask RailPlan
      </button>

      {solving ? (
        <span className="pill p-info">{solvingLabel || "Solving…"}</span>
      ) : status === "error" ? (
        <span className="pill p-crit">Service offline</span>
      ) : error ? (
        <span className="pill p-crit" title={error}>
          Last run did not solve
        </span>
      ) : feasible === false ? (
        <span className="pill p-warn">{plan?.validation.hard_violations.length} violations</span>
      ) : (
        <span className="pill p-ok">System OK</span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, borderLeft: "1px solid #e6e9ef" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "#14213a",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          JT
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Jerry Tan</span>
          <span style={{ fontSize: 11, color: "#5b6578" }}>Works Controller · Night desk</span>
        </div>
      </div>
    </header>
  );
}

export function Shell({
  current,
  go,
  children,
}: {
  current: TabId;
  go: (t: TabId) => void;
  children: ReactNode;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        display: "flex",
        overflow: "hidden",
        position: "relative",
        background: "#f4f6f9",
        color: "#14213a",
      }}
    >
      <Nav current={current} go={go} />
      <div style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        <TopBar current={current} go={go} onUpload={() => setUploading(true)} />
        {/* position:relative — the Schedule panel and the Scenarios popups sit inside this. */}
        <main
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            position: "relative",
          }}
        >
          {children}
          {uploading && <UploadDialog onClose={() => setUploading(false)} />}
        </main>
      </div>
    </div>
  );
}
