import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, waitForRun } from "../api/client";
import type {
  ApprovedPlan,
  DatasetHistory,
  InstanceSummary,
  Override,
  Run,
  ScenarioId,
} from "../api/types";
import { buildPlan, type PlanModel } from "../data/adapt";

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  A: "Strict supply, flexible schedule",
  B: "Strict schedule, flexible supply",
  C: "Balanced",
};
export const available = (r: Run | null) =>
  r?.status === "completed" && !!r.schedule && !!r.validation?.feasible;
export const pending = (r: { status: string }) =>
  r.status === "queued" || r.status === "running";
interface PlanState {
  status: "loading" | "ready" | "error";
  error: string | null;
  instance: InstanceSummary | null;
  run: Run | null;
  plan: PlanModel | null;
  approved: ApprovedPlan | null;
  solving: boolean;
  solvingLabel: string;
  signal: AbortSignal;
  reload: () => void;
  loadDemandBook: (files: File[], name?: string) => Promise<void>;
  history: DatasetHistory | null;
  refreshHistory: () => Promise<void>;
  solveAll: () => Promise<void>;
  loadSavedRun: (id: string) => Promise<void>;
  isSample: boolean;
  backToSample: () => void;
  selectInstance: (instanceId: string) => Promise<void>;
  viewRun: (run: Run) => void;
  refreshApproval: () => Promise<void>;
  adoptRun: (run: Run) => Promise<void>;
  switchScenario: (scenario: ScenarioId, seconds?: number) => Promise<void>;
  runWhatIf: (input: {
    scenario?: ScenarioId;
    overrides: Override[];
    seconds?: number;
    label?: string;
    baselineId?: string | null;
  }) => Promise<Run>;
}
function rememberInstance(id: string) { try { localStorage.setItem("railplan.instance", id); } catch { /* optional browser preference */ } }
function rememberedInstance() { try { return localStorage.getItem("railplan.instance"); } catch { return null; } }
const Ctx = createContext<PlanState | null>(null);
export function PlanProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: { instance: InstanceSummary; run: Run };
}) {
  const [status, setStatus] = useState<PlanState["status"]>(
    initial ? "ready" : "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [instance, setInstance] = useState<InstanceSummary | null>(
    initial?.instance ?? null,
  );
  const [run, setRun] = useState<Run | null>(initial?.run ?? null);
  const [approved, setApproved] = useState<ApprovedPlan | null>(
    initial
      ? {
          instance_id: initial.instance.id,
          approved_run_id: initial.run.id,
          revision: 1,
          commitments: [],
          run: initial.run,
        }
      : null,
  );
  const [history, setHistory] = useState<DatasetHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [solvingLabel, setSolvingLabel] = useState("");
  const scope = useRef(new AbortController());
  const [signal, setSignal] = useState(scope.current.signal);
  const currentId = useRef(initial?.instance.id);
  const [sampleId, setSampleId] = useState(initial?.instance.id ?? "");
  const selectInstance = useCallback(async (id: string) => {
    scope.current.abort();
    const controller = new AbortController();
    scope.current = controller;
    setSignal(controller.signal);
    currentId.current = id;
    setStatus("loading");
    setError(null);
    setRun(null);
    setHistory(null);
    setHistoryError(null);
    setApproved(null);
    setInstance(null);
    setSolving(false);
    try {
      const [book, approval, saved] = await Promise.all([
        api.instance(id),
        api.plan(id),
        api.history(id, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      setInstance(book);
      setApproved(approval);
      setHistory(saved);
      setRun(approval.run ?? Object.values(saved.latest).find(r => r.schedule && r.validation) ?? null);
      setStatus("ready");
      rememberInstance(id);
    } catch (e) {
      if (controller.signal.aborted) throw e;
      setError(
        e instanceof Error ? e.message : "Could not load this demand book.",
      );
      setStatus("error");
      throw e;
    }
  }, []);
  const refreshHistory = useCallback(async () => {
    const id = currentId.current;
    const signal = scope.current.signal;
    if (!id) return;
    const saved = await api.history(id, signal);
    signal.throwIfAborted();
    setHistory(saved);
    setHistoryError(null);
    setRun(current => {
      const fresh = Object.values(saved.latest).find(r => r.id === current?.id);
      if (fresh?.schedule && fresh.validation) return fresh;
      return current ?? Object.values(saved.latest).find(r => r.schedule && r.validation) ?? null;
    });
  }, []);
  const batchPending = Object.values(history?.latest ?? {}).some(pending);
  useEffect(() => {
    if (!batchPending || !instance) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refreshHistory(); }
      catch (e) { if (!stopped) setHistoryError(e instanceof Error ? e.message : "Could not refresh saved scenarios. Retrying…"); }
      if (!stopped) timer = setTimeout(poll, 1800);
    };
    timer = setTimeout(poll, 900);
    return () => { stopped = true; clearTimeout(timer); };
  }, [batchPending, instance?.id, refreshHistory]);
  const loadSavedRun = useCallback(async (id: string) => {
    const signal = scope.current.signal;
    const saved = await api.run(id, signal);
    signal.throwIfAborted();
    if (saved.instance_id !== currentId.current || !saved.schedule || !saved.validation)
      throw new Error("This version has no complete schedule to view.");
    setRun(saved);
  }, []);
  const launchAll = useCallback(async (id: string) => {
    const signal = scope.current.signal;
    setSolving(true); setSolvingLabel("Queuing scenarios A, B and C…"); setError(null);
    try {
      const batch = await api.solveAll(id, crypto.randomUUID());
      signal.throwIfAborted();
      setHistory(previous => ({ instance_id: id, versions: previous?.versions ?? [],
        latest: Object.fromEntries(batch.children.map(child => [child.scenario, child])) }));
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "Could not queue all scenarios. Retry from Scenario results.");
      throw e;
    } finally { if (!signal.aborted) { setSolving(false); setSolvingLabel(""); } }
  }, []);
  const solveAll = useCallback(async () => {
    if (instance && !solving && !batchPending) await launchAll(instance.id);
  }, [instance, solving, batchPending, launchAll]);
  const load = useCallback(async () => {
    if (initial) return;
    try {
      const id = currentId.current ?? rememberedInstance();
      if (id) await selectInstance(id);
      else {
        const demo = await api.demo();
        setSampleId(demo.instance.id);
        await selectInstance(demo.instance.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the plan.");
      setStatus("error");
    }
  }, [initial, selectInstance]);
  useEffect(() => {
    void load();
    return () => scope.current.abort();
  }, [load]);
  const viewRun = useCallback((candidate: Run) => {
    if (
      candidate.instance_id === currentId.current &&
      candidate.schedule &&
      candidate.validation
    )
      setRun(candidate);
  }, []);
  const refreshApproval = useCallback(async () => {
    if (!instance) return;
    const result = await api.plan(instance.id);
    if (instance.id === currentId.current) setApproved(result);
  }, [instance]);
  const adoptRun = useCallback(
    async (candidate: Run) => {
      if (!instance || !approved || !available(candidate))
        throw new Error("Select a completed feasible schedule.");
      const result = await api.adopt(instance.id, candidate.id, approved);
      if (instance.id === currentId.current) {
        setApproved(result);
        setRun(result.run);
        setError(null);
      }
    },
    [instance, approved],
  );
  const switchScenario = useCallback(
    async (scenario: ScenarioId, seconds = 90) => {
      if (!instance) return;
      const saved = history?.latest[scenario];
      if (saved?.schedule && saved.validation) { setRun(saved); return; }
      if (solving || batchPending) return;
      const signal = scope.current.signal;
      setSolving(true);
      setSolvingLabel(`Solving scenario ${scenario}…`);
      setError(null);
      try {
        const started = await api.startRun({
          instance_id: instance.id,
          scenario,
          seconds,
          baseline_id: approved?.approved_run_id,
          label: `Scenario ${scenario}`,
        });
        await refreshHistory();
        const done = await waitForRun(started.id, { signal });
        await refreshHistory();
        signal.throwIfAborted();
        if (done.schedule && done.validation) setRun(done);
        else
          setError(
            done.error ??
              done.message ??
              "No complete schedule found. Try another scenario or review the constraints.",
          );
      } catch (e) {
        if (!signal.aborted)
          setError(e instanceof Error ? e.message : "The scenario run failed.");
      } finally {
        if (!signal.aborted) {
          setSolving(false);
          setSolvingLabel("");
        }
      }
    },
    [instance, solving, approved, history, batchPending, refreshHistory],
  );
  const runWhatIf = useCallback<PlanState["runWhatIf"]>(
    async ({
      scenario,
      overrides,
      seconds = 90,
      label = "What-if",
      baselineId,
    }) => {
      if (!instance || !run) throw new Error("No plan is loaded.");
      const signal = scope.current.signal;
      const started = await api.startRun({
        instance_id: instance.id,
        scenario: scenario ?? run.scenario,
        seconds,
        overrides,
        label,
        baseline_id: baselineId ?? run.id,
      });
      return waitForRun(started.id, { signal });
    },
    [instance, run],
  );
  const loadDemandBook = useCallback(async (files: File[], name?: string) => {
    let operation = scope.current;
    setSolving(true); setError(null); setSolvingLabel("Saving the demand book…");
    try {
      const uploaded = await api.uploadInstance(files, name);
      operation.signal.throwIfAborted();
      await selectInstance(uploaded.id);
      operation = scope.current;
      await launchAll(uploaded.id);
    } catch (e) {
      if (!operation.signal.aborted) setError(e instanceof Error ? e.message : "The demand book could not be loaded.");
      throw e;
    } finally { if (!operation.signal.aborted) { setSolving(false); setSolvingLabel(""); } }
  }, [selectInstance, launchAll]);
  const backToSample = useCallback(async () => {
    try { const demo = await api.demo(); setSampleId(demo.instance.id); await selectInstance(demo.instance.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load the sample."); }
  }, [selectInstance]);
  const plan = useMemo(
    () =>
      instance && run?.schedule && run.validation
        ? buildPlan(instance, run)
        : null,
    [instance, run],
  );
  return (
    <Ctx.Provider
      value={{
        status,
        error: error ?? historyError,
        instance,
        run,
        plan,
        approved,
        solving: solving || batchPending,
        solvingLabel: solvingLabel || (batchPending ? "Solving uploaded scenarios…" : ""),
        history,
        refreshHistory,
        solveAll,
        loadSavedRun,
        signal,
        reload: () => {
          void load();
        },
        selectInstance,
        viewRun,
        refreshApproval,
        adoptRun,
        switchScenario,
        runWhatIf,
        loadDemandBook,
        isSample: !instance || instance.id === (sampleId || "4614ef3b6b98b084"),
        backToSample: () => { void backToSample(); },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
export function usePlanState(): PlanState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("PlanProvider is required");
  return ctx;
}
export function usePlan(): PlanModel {
  const { plan } = usePlanState();
  if (!plan) throw new Error("No solved plan");
  return plan;
}
