// RailPlan root. One tab is visible at a time, but every tab stays mounted so its
// in-memory state survives switching away and back (spec section 1).

import { useState, type ReactNode } from "react";
import { Shell } from "./shell/Shell";
import type { TabId } from "./shell/tabs";
import { PlanProvider, usePlanState } from "./state/plan";
import { Home } from "./tabs/Home";
import { Schedule } from "./tabs/Schedule";
import { Contracts } from "./tabs/Contracts";
import { Risk } from "./tabs/Risk";
import { Ask } from "./tabs/Ask";
import { Scenarios } from "./tabs/Scenarios";
import { Disruption } from "./tabs/Disruption";
import { Requests } from "./tabs/Requests";
import { Reports } from "./tabs/Reports";

function Gate({ children }: { children: ReactNode }) {
  const { status, error, reload, instance, plan, solving, switchScenario } =
    usePlanState();

  if (status === "loading")
    return (
      <div
        className="card"
        style={{
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <span className="h2">Loading the demand book…</span>
        <span className="small muted">
          Reading the instance and its solved schedule from the planning
          service.
        </span>
      </div>
    );

  if (status === "error")
    return (
      <div
        className="callout c-red"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <span style={{ fontWeight: 600 }}>The plan could not be loaded.</span>
        <span>{error}</span>
        <span className="small muted">
          The frontend reads everything from the planning service — no figures
          are bundled into the page.
        </span>
        <div>
          <button className="btn btn-sm btn-primary" onClick={reload}>
            Try again
          </button>
        </div>
      </div>
    );

  if (!plan)
    return (
      <div
        className="card"
        style={{
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h1 className="h1">{instance?.name} · {solving ? "Solving scenarios" : "Unsolved"}</h1>
        <p>
          No completed schedule is available yet. Results appear above as each scenario finishes.
          Review a result, then adopt it explicitly.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          {(["A", "B", "C"] as const).map((s) => (
            <button
              key={s}
              className="btn btn-primary"
              disabled={solving}
              onClick={() => void switchScenario(s)}
            >
              Solve {s} · 90s
            </button>
          ))}
        </div>
        {error && (
          <div role="alert" className="callout c-red">
            {error}
          </div>
        )}
      </div>
    );
  return (
    <>
      {error && (
        <div role="alert" className="callout c-red">
          {error}
        </div>
      )}
      {children}
    </>
  );
}

export function Tabs() {
  const { instance } = usePlanState();
  const [tab, setTab] = useState<TabId>("home");

  const go = (t: TabId) => {
    setTab(t);
    const main = document.querySelector("main");
    if (main) main.scrollTop = 0;
  };

  // The wrapper repeats <main>'s flex layout so each tab's children lay out
  // exactly as they would as direct children of <main>.
  const pane = (id: TabId, node: ReactNode) => (
    <div
      key={`${instance?.id}:${id}`}
      style={
        tab === id
          ? {
              display: "flex",
              flexDirection: "column",
              gap: 16,
              flex: 1,
              minHeight: 0,
            }
          : { display: "none" }
      }
    >
      {node}
    </div>
  );

  return (
    <Shell current={tab} go={go}>
      <Gate>
        {pane("home", <Home go={go} />)}
        {pane("schedule", <Schedule go={go} />)}
        {pane("contracts", <Contracts go={go} />)}
        {pane("risk", <Risk go={go} />)}
        {pane("scenarios", <Scenarios />)}
        {pane("disruption", <Disruption go={go} />)}
        {pane("requests", <Requests go={go} />)}
        {pane("reports", <Reports />)}
        {pane("ask", <Ask />)}
      </Gate>
    </Shell>
  );
}

export default function RailPlan() {
  return (
    <PlanProvider>
      <Tabs />
    </PlanProvider>
  );
}
