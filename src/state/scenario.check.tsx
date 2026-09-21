import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { api } from "../api/client";
import type { ApprovedPlan, DatasetHistory, InstanceSummary, Run } from "../api/types";
import fixture from "../fixtures/demo.json";
import { PlanProvider, usePlanState } from "./plan";

const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
const original = { ...api };
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
let state: ReturnType<typeof usePlanState>;
let view: ReactTestRenderer;
function Probe() { state = usePlanState(); return null; }
function check(ok: unknown, message: string) { if (!ok) throw new Error(message); }
let approval: ApprovedPlan = { instance_id: f.instance.id, approved_run_id: f.runs.A.id,
  run: f.runs.A, revision: 1, commitments: [] };
let saved: DatasetHistory = { instance_id: f.instance.id, versions: [], latest: { ...f.runs } };
let adoptions = 0, solves = 0;
const adopt: typeof api.adopt = async (iid, id, before) => {
  check(iid === f.instance.id && before.revision === approval.revision, "Scenario used stale approval state");
  adoptions++;
  approval = { ...approval, approved_run_id: id, run: Object.values(f.runs).find(r => r.id === id)!, revision: approval.revision + 1 };
  return approval;
};
try {
  api.history = async () => saved;
  api.plan = async () => approval;
  api.adopt = adopt;
  api.startRun = async () => { solves++; return f.runs.B; };
  api.run = async () => f.runs.B;
  await act(async () => { view = create(<PlanProvider initial={{ instance: f.instance, run: f.runs.A }}><Probe /></PlanProvider>); });
  await act(async () => { await state!.refreshHistory(); });
  await act(async () => { await state!.switchScenario("B"); });
  check(state!.approved?.approved_run_id === f.runs.B.id && state!.run?.id === f.runs.B.id, "Scenario B was not adopted");
  check(adoptions === 1 && solves === 0, "Saved scenarios must adopt without recomputing");
  await act(async () => { await state!.switchScenario("B"); });
  check(adoptions === 1, "Selecting the active scenario must not write another approval");

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  api.adopt = async (...args) => { await gate; return adopt(...args); };
  let switching!: Promise<void>;
  await act(async () => { switching = state!.switchScenario("C"); });
  check(state!.switchingScenario === "C" && state!.run?.id === f.runs.B.id, "Pending adoption changed the active plan too early");
  await act(async () => { await state!.switchScenario("A"); });
  await act(async () => { release(); await switching; });
  check(adoptions === 2 && state!.approved?.approved_run_id === f.runs.C.id, "Rapid scenario clicks created competing approvals");

  api.adopt = async () => { throw new Error("The approved plan changed. Reload."); };
  await act(async () => { await state!.switchScenario("A"); });
  check(state!.run?.id === f.runs.C.id && state!.approved?.approved_run_id === f.runs.C.id && state!.error?.includes("approved plan changed"), "Failed adoption must retain the active plan and show the error");
  api.adopt = adopt;
  saved = { ...saved, latest: { A: { ...f.runs.A, validation: { ...f.runs.A.validation!, feasible: false } }, C: f.runs.C } };
  await act(async () => { await state!.refreshHistory(); });
  await act(async () => { await state!.switchScenario("A"); });
  check(state!.run?.id === f.runs.C.id && adoptions === 2, "An infeasible scenario must not be adopted");
  await act(async () => { await state!.switchScenario("B"); });
  check(solves === 1 && state!.approved?.approved_run_id === f.runs.B.id, "A newly solved scenario must be adopted automatically");
  console.log("ok   scenario switching: automatic adoption, saved-result reuse, rapid clicks, rejected adoption, infeasible result, newly solved plan");
} finally {
  await act(async () => view?.unmount());
  Object.assign(api, original);
  globals.IS_REACT_ACT_ENVIRONMENT = false;
}
