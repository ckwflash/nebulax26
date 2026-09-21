// Exercise the shared upload, solve and explicit-adoption boundaries.
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { api } from "../api/client";
import type { InstanceSummary, Run } from "../api/types";
import fixture from "../fixtures/demo.json";
import { PlanProvider, usePlanState } from "./plan";

const f = fixture as unknown as {
  instance: InstanceSummary;
  runs: Record<string, Run>;
};
const old = { ...api };
const globals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
globals.IS_REACT_ACT_ENVIRONMENT = true;
const previousStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { setItem: () => {}, getItem: () => null },
});
let state: ReturnType<typeof usePlanState>;
function Probe() {
  state = usePlanState();
  return <span>{state.plan ? state.plan.runId : "unsolved"}</span>;
}
let view: ReactTestRenderer;
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
try {
  await act(async () => {
    view = create(
      <PlanProvider initial={{ instance: f.instance, run: f.runs.A }}>
        <Probe />
      </PlanProvider>,
    );
  });
  const before = state!.signal;
  const uploaded = {
    ...f.instance,
    id: "1111111111111111",
    name: "Uploaded test book",
  };
  api.history = async id => ({ instance_id: id, versions: [], latest: {} });
  api.instance = async () => uploaded;
  api.plan = async () => ({
    instance_id: uploaded.id,
    approved_run_id: null,
    revision: 0,
    commitments: [],
    run: null,
  });
  await act(async () => {
    await state!.selectInstance(uploaded.id);
  });
  assert(before.aborted, "Switching instances must stop obsolete polling");
  assert(
    state!.instance?.id === uploaded.id && state!.status === "ready",
    "Uploaded instance was not selected",
  );
  assert(
    state!.run === null &&
      state!.plan === null &&
      state!.approved?.run === null,
    "Previous schedule leaked into an unsolved upload",
  );
  api.instance = async () => f.instance;
  api.plan = async () => ({
    instance_id: f.instance.id,
    approved_run_id: f.runs.B.id,
    revision: 2,
    commitments: [],
    run: f.runs.B,
  });
  await act(async () => {
    await state!.selectInstance(f.instance.id);
  });
  assert(state!.run?.id === f.runs.B.id, "Saved approval was not restored");
  api.instance = async () => {
    throw new Error("Durable storage is unavailable. Please retry.");
  };
  await act(async () => {
    await state!.selectInstance(uploaded.id).catch(() => {});
  });
  assert(
    state!.status === "error" && state!.error?.includes("Durable storage"),
    "Upload handoff must surface API failure",
  );
  assert(state!.plan === null, "Failed selection retained an obsolete plan");
  api.instance = async () => uploaded;
  api.plan = async () => ({ instance_id: uploaded.id, approved_run_id: null, revision: 0, commitments: [], run: null });
  api.uploadInstance = async () => uploaded;
  const solved = { ...f.runs.C, id: "uploaded-solve", instance_id: uploaded.id };
  let submittedInstance = "";
  const queued = (["A", "B", "C"] as const).map(scenario => ({ ...solved, id: `upload-${scenario}`, scenario, status: "queued" as const, schedule: null, validation: null }));
  api.solveAll = async id => { submittedInstance = id; return { id: "batch-upload", instance_id: id, status: "queued", children: queued }; };
  api.run = async () => solved;
  let adopted = false;
  api.adopt = async () => { adopted = true; throw new Error("Unexpected auto-adoption"); };
  await act(async () => { await state!.loadDemandBook([new File(["demo"], "demo.zip")], "New dataset"); });
  assert(submittedInstance === uploaded.id && state!.history?.latest.A?.status === "queued" && state!.history?.latest.B?.status === "queued" && state!.history?.latest.C?.status === "queued", "Upload must queue all three scenarios for the new dataset");
  assert(!adopted && state!.approved?.approved_run_id === null, "Upload must not approve its new schedules");
  assert(state!.solving && state!.status === "ready", "The UI must return while background solves continue");
  const completed = { ...solved, id: "upload-C" };
  api.history = async id => ({ instance_id: id, versions: [], latest: { C: completed, A: { ...queued[0], status: "no_solution", message: "No feasible schedule" }, B: { ...queued[1], status: "failed", error: "Solver failed" } } });
  await act(async () => { await state!.refreshHistory(); });
  assert(state!.run?.id === completed.id && !state!.solving, "Progressive completion did not load an available result");
  assert(!adopted, "Progressive results must never auto-adopt");
  let extraSolve = false;
  api.startRun = async () => { extraSolve = true; return completed; };
  await act(async () => { await state!.switchScenario("C"); });
  assert(!extraSolve, "Selecting a saved scenario should not re-solve it");
  const priorSignal = state!.signal;
  await act(async () => { await state!.selectInstance(uploaded.id); });
  assert(priorSignal.aborted && state!.run?.id === completed.id && state!.approved?.run === null, "Historical results must restore without adoption");
  api.history = async id => ({ instance_id: id, versions: [], latest: {} });
  await act(async () => { await state!.selectInstance("2222222222222222"); });
  assert(state!.run === null && !state!.solving, "Saved results leaked into another dataset");
  console.log("ok   upload handoff: abort, unsolved state, restored approval, three-scenario queue, progressive results, saved scenario reuse, history, explicit adoption, visible errors");
} finally {
  await act(async () => view?.unmount());
  Object.assign(api, old);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousStorage,
  });
  globals.IS_REACT_ACT_ENVIRONMENT = false;
}
