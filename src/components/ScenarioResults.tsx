import { useState } from "react";
import type { Run, ScenarioId } from "../api/types";
import { available, pending, SCENARIO_LABEL, usePlanState } from "../state/plan";

export function resultStatus(run: Run | undefined) {
  if (!run) return "Not solved yet";
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Solving…";
  if (available(run)) return "Ready to export";
  if (run.status === "failed") return "Solve failed";
  return "No feasible result";
}
export function ScenarioResults() {
  const { instance, history, run: viewed, viewRun, solveAll, solving, loadSavedRun, refreshHistory, error } = usePlanState();
  const [failure, setFailure] = useState("");
  const [opening, setOpening] = useState(false);
  if (!instance) return null;
  const versions = history?.versions ?? [];
  const act = async (action: () => Promise<void>) => {
    setFailure(""); setOpening(true);
    try { await action(); } catch (e) { setFailure(e instanceof Error ? e.message : "Could not load this result."); }
    finally { setOpening(false); }
  };
  return <section className="card" aria-label="Scenario results" style={{ padding: "14px 18px", flexShrink: 0 }}>
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
      <div style={{ flex: 1 }}><h2 className="h2">Scenario results</h2><span className="small muted">{instance.name} · Saved automatically · 90s maximum per scenario</span></div>
      <button className="btn btn-sm" disabled={solving || opening} onClick={() => void act(solveAll)}>{versions.length ? "Re-solve A / B / C" : "Solve A / B / C"}</button>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
      {(["A", "B", "C"] as ScenarioId[]).map(scenario => {
        const result = history?.latest[scenario];
        return <div key={scenario} style={{ border: `1px solid ${viewed?.id === result?.id && result ? "#447ad2" : "#dfe3ea"}`, borderRadius: 6, padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}><strong>Scenario {scenario}</strong><span className={`pill ${available(result ?? null) ? "p-ok" : result && pending(result) ? "p-info" : "p-warn"}`}>{resultStatus(result)}</span></div>
          <div className="small muted" style={{ margin: "5px 0 8px" }}>{SCENARIO_LABEL[scenario]}{result && result.label !== `Scenario ${scenario}` && <> · {result.label}</>}{result?.validation && <> · Local score {result.validation.score}</>}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm" disabled={!result?.schedule || !result.validation || pending(result)} onClick={() => result && viewRun(result)}>{viewed?.id === result?.id && result ? "Viewing" : `View ${scenario}`}</button>
            {available(result ?? null) ? <a className="btn btn-sm" href={`/api/runs/${result!.id}/export`} download>Download {scenario}.zip</a> : <button className="btn btn-sm" disabled>Download {scenario}.zip</button>}
          </div>
          {result && !pending(result) && !available(result) && <p className="small" style={{ color: "#a12a22", marginBottom: 0 }}>{result.error ?? result.message ?? "No complete, feasible schedule is available. Review constraints or try another solve."}</p>}
        </div>;
      })}
    </div>
    <div className="small muted" style={{ marginTop: 9 }}>Each ZIP contains SCHEDULE_ACCESS.csv, SCHEDULE_OCCUPANCY.csv and RESULTS.csv. Scores use different scenario objectives and cannot be ranked across scenarios.</div>
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }} onClick={() => { void act(refreshHistory); }}>Saved versions · {versions.length}</summary>
      <div style={{ maxHeight: 230, overflow: "auto", marginTop: 8 }}>
        {versions.map(version => <div key={version.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid #e6e9ef" }}>
          <div style={{ flex: 1 }}><strong className="small">{version.label} · {version.scenario}</strong><div className="small muted">{new Date(version.created_at).toLocaleString()} · {version.status}{version.score !== null ? ` · Local score ${version.score}` : ""} · {version.id.slice(-10)}</div></div>
          <button className="btn btn-sm" disabled={opening || !version.has_schedule || pending(version)} onClick={() => void act(() => loadSavedRun(version.id))}>View version</button>
          {version.status === "completed" && version.feasible && <a className="btn btn-sm" href={`/api/runs/${version.id}/export`} download>ZIP</a>}
        </div>)}
        {!versions.length && <p className="small muted">Completed and in-progress solves will appear here.</p>}
      </div>
    </details>
    {(failure || error) && <div role="alert" className="callout c-red" style={{ marginTop: 10 }}>{failure || error}</div>}
  </section>;
}
