import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api, ApiError } from "../api/client";
import type { DemoPayload, InstanceSummary, Run } from "../api/types";
import fixture from "../fixtures/demo.json";
import { PlanProvider, usePlanState } from "./plan";

const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
const demo = { instance: f.instance, run: f.runs.A };
const original = { ...api };
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
let remembered: string | null = null;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => remembered, setItem: (_key: string, id: string) => { remembered = id; } },
});
let state: ReturnType<typeof usePlanState>;
let view: ReactTestRenderer | undefined;
function Probe() { state = usePlanState(); return null; }
function check(ok: unknown, message: string) { if (!ok) throw new Error(message); }
async function mount() {
  await act(async () => { view = create(<StrictMode><PlanProvider><Probe /></PlanProvider></StrictMode>); });
}
async function unmount() {
  await act(async () => { view?.unmount(); view = undefined; });
  remembered = null;
}
function pendingDemo() {
  const requests: { signal?: AbortSignal; resolve: (value: DemoPayload) => void; reject: (reason: Error) => void }[] = [];
  api.demo = signal => new Promise((resolve, reject) => { requests.push({ signal, resolve, reject }); });
  return requests;
}
try {
  api.instance = async id => {
    if (id === "missing") throw new ApiError("Demand book not found", 404);
    return { ...f.instance, id };
  };
  api.plan = async id => ({ instance_id: id, approved_run_id: f.runs.B.id, revision: 2, commitments: [], run: { ...f.runs.B, instance_id: id } });
  api.history = async id => ({ instance_id: id, versions: [], latest: { ...f.runs } });
  let demos = 0;
  api.demo = async () => { demos++; return demo; };

  remembered = "missing";
  await mount();
  check(state!.status === "ready" && state!.instance?.id === f.instance.id && remembered === f.instance.id,
    "A deleted local dataset must recover to the public sample");
  check(state!.approved?.run?.id === f.runs.B.id, "Demo loading must preserve the saved approval");
  await unmount();

  demos = 0;
  remembered = f.instance.id;
  await mount();
  check(demos === 0 && state!.status === "ready" && !state!.error, "Saved datasets must load without waiting for demo, including Strict Mode");
  await unmount();

  api.demo = async () => { throw new ApiError("The planning service did not respond within 30 seconds.", 408); };
  await mount();
  check(state!.status === "error" && state!.error?.includes("30 seconds"), "A stalled demo must leave the loading state");
  const retry = pendingDemo();
  await act(async () => { state!.reload(); });
  check(state!.status === "loading" && !state!.error, "Retry must reset the error and display loading");
  await act(async () => { retry[0].resolve(demo); });
  check(state!.status === "ready", "Retry must recover when the API comes back");
  await unmount();

  const strict = pendingDemo();
  await mount();
  check(strict.length === 2 && strict[0].signal?.aborted, "Strict Mode cleanup must cancel the first demo request");
  await act(async () => { strict[1].resolve(demo); });
  await act(async () => { strict[0].reject(new Error("Obsolete request failed")); });
  check(state!.status === "ready" && !state!.error, "An obsolete failure must not overwrite a loaded plan");
  await unmount();

  const stale = pendingDemo();
  await mount();
  await act(async () => { await state!.selectInstance("uploaded"); });
  check(stale.every(request => request.signal?.aborted), "Dataset selection must cancel pending demo loads");
  await act(async () => { stale.forEach(request => request.resolve(demo)); });
  check(state!.status === "ready" && state!.instance?.id === "uploaded", "Late demo responses must not replace a selected dataset");
  await unmount();
  console.log("ok   startup: missing dataset, saved approval, timeout/retry, Strict Mode cancellation, stale demo response");
} finally {
  await unmount();
  Object.assign(api, original);
  if (storage) Object.defineProperty(globalThis, "localStorage", storage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  globals.IS_REACT_ACT_ENVIRONMENT = false;
}
