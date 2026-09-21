import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { api } from "../api/client";
import type { InstanceSummary, Override, Run } from "../api/types";
import fixture from "../fixtures/demo.json";
import { PlanProvider } from "./plan";
import { Scenarios } from "../tabs/Scenarios";
const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
const original = { ...api };
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
let view!: ReactTestRenderer;
let calls = 0;
let request: { overrides?: Override[]; baseline_id?: string | null } | undefined;
const failed: Run = { ...f.runs.A, id: "stress-infeasible", status: "no_solution", solver_status: "INFEASIBLE", schedule: null, validation: null };
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
try {
  api.startRun = async body => { calls++; request = body; return failed; };
  api.run = async () => failed;
  api.adopt = async () => { throw new Error("Stress tests must not adopt automatically"); };
  await act(async () => { view = create(<PlanProvider initial={{ instance: f.instance, run: f.runs.A }}><Scenarios /></PlanProvider>); });
  const buttons = () => view.root.findAllByType("button").filter(b => b.props.className === "row-btn");
  await act(async () => { await buttons()[0].props.onClick(); });
  check(calls === 1 && request?.baseline_id === f.runs.A.id, "Selecting a stress test must immediately run against the displayed baseline");
  check(request?.overrides?.length && request.overrides.every(o => o.closed && o.capacity === 0), "The selected closures did not reach the API");
  check(JSON.stringify(view.toJSON()).includes("Delivery blocked"), "Infeasibility must appear as a comparison result");
  const unchanged: Run = { ...f.runs.A, id: "stress-absorbed", label: "Absorbed test" };
  api.startRun = async () => unchanged;
  api.run = async () => unchanged;
  await act(async () => { await buttons()[1].props.onClick(); });
  const output = JSON.stringify(view.toJSON());
  check(output.includes("Score unchanged") && !output.includes("Score improves by 0"), "An absorbed stress must not claim improvement");
  console.log("ok   stress UI: one-click execution, selected closures, fixed baseline, visible infeasibility, honest unchanged scores");
} finally {
  await act(async () => view?.unmount());
  Object.assign(api, original);
  globals.IS_REACT_ACT_ENVIRONMENT = false;
}
