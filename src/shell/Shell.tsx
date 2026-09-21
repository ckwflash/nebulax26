// Spec sections 2.2–2.3 — top bar and main area. The crumb and the feasibility pill
// come from the loaded run rather than being fixed text.

import { useState, type ReactNode } from "react";
import { available, usePlanState } from "../state/plan";
import { DatasetLibrary } from "./DatasetLibrary";
import { ScenarioResults } from "../components/ScenarioResults";
import { UploadDialog } from "./UploadDialog";
import { Nav } from "./Nav";
import { TAB_TITLE, type TabId } from "./tabs";

function TopBar({ current, go, onUpload, onLibrary }: { current: TabId; go: (t: TabId) => void; onUpload: () => void; onLibrary: () => void }) {
  const { instance, plan, run, approved, adoptRun, refreshApproval, viewRun, status,
    switchingScenario } = usePlanState();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const preview = run && approved?.approved_run_id !== run.id;
  const crumb = plan
    ? `${plan.name} · ${plan.validation.feasible ? "Feasible" : "Check violations"}`
    : status === "loading" ? "Loading the demand book…" : instance?.name ?? "No plan loaded";

  return <header className="plan-header">
    <div className="plan-header-main">
      <div className="plan-header-title">
        <strong>{TAB_TITLE[current]}</strong>
        <span title={crumb}>{crumb}</span>
      </div>
      <div className="plan-header-actions">
        <button className="btn btn-sm" onClick={onLibrary}>Dataset library</button>
        <button className="btn btn-sm" onClick={onUpload} title="Load your own instance CSVs">Load demand book</button>
        <button className="btn btn-sm" onClick={() => go("ask")}>Ask RailPlan</button>
      </div>
    </div>
    {preview && !switchingScenario && <div className="plan-preview-actions">
      <span className="small">{approved?.run ? `Preview: ${run.label}` : "Choose A, B or C in Scenario results to activate a plan."}</span>
      {approved?.run && <>
        <button className="btn btn-sm" disabled={saving || !available(run)} onClick={async () => {
          setSaving(true); setError("");
          try { await adoptRun(run); }
          catch (e) { setError((e as Error).message); await refreshApproval().catch(() => {}); }
          finally { setSaving(false); }
        }}>{saving ? "Applying…" : "Adopt preview"}</button>
        <button className="btn btn-sm" disabled={saving} onClick={() => viewRun(approved.run!)}>Return to active plan</button>
      </>}
      {error && <span role="alert" className="small" style={{ color: "#a12a22" }}>{error}</span>}
    </div>}
  </header>;
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
  const [libraryOpen, setLibraryOpen] = useState(false);
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
      <div
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TopBar current={current} go={go} onUpload={() => setUploading(true)} onLibrary={() => setLibraryOpen(true)} />
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
          <ScenarioResults />
          {children}
          {libraryOpen && <DatasetLibrary onClose={() => setLibraryOpen(false)} />}
          {uploading && <UploadDialog onClose={() => setUploading(false)} />}
        </main>
      </div>
    </div>
  );
}
