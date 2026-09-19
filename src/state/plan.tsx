// Loads the demand book and its solved run from the API, and exposes the derived
// plan model to every tab. Scenario switching and what-if runs go through here so
// there is one place that talks to /api/runs.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, api, waitForRun } from "../api/client";
import type { InstanceSummary, Override, Run, ScenarioId } from "../api/types";
import { buildPlan, type PlanModel } from "../data/adapt";

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  A: "Strict supply, flexible schedule",
  B: "Strict schedule, flexible supply",
  C: "Balanced",
};

interface PlanState {
  status: "loading" | "ready" | "error";
  error: string | null;
  instance: InstanceSummary | null;
  run: Run | null;
  plan: PlanModel | null;
  /** True while a scenario switch or what-if run is solving. */
  solving: boolean;
  solvingLabel: string;
  reload: () => void;
  switchScenario: (scenario: ScenarioId, seconds?: number) => Promise<void>;
  /** Solve a what-if on a copy of the plan. Does not replace the displayed plan. */
  runWhatIf: (input: {
    scenario?: ScenarioId;
    overrides: Override[];
    seconds?: number;
    label?: string;
    baselineId?: string | null;
  }) => Promise<Run>;
}

const Ctx = createContext<PlanState | null>(null);

/**
 * `initial` seeds the provider with an already-fetched payload and skips the request.
 * Used by the offline render check; the app itself always loads from the API.
 */
export function PlanProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: { instance: InstanceSummary; run: Run };
}) {
  const [status, setStatus] = useState<PlanState["status"]>(initial ? "ready" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [instance, setInstance] = useState<InstanceSummary | null>(initial?.instance ?? null);
  const [run, setRun] = useState<Run | null>(initial?.run ?? null);
  const [solving, setSolving] = useState(false);
  const [solvingLabel, setSolvingLabel] = useState("");
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (initial) return;
    setStatus("loading");
    setError(null);
    api
      .demo()
      .then((payload) => {
        setInstance(payload.instance);
        setRun(payload.run);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        setError(
          e instanceof ApiError && e.status === 0
            ? "The planning service is not reachable. Start it with scripts/dev.sh, then reload."
            : e instanceof Error
              ? e.message
              : "Could not load the plan.",
        );
        setStatus("error");
      });
  }, [initial]);

  useEffect(() => {
    load();
    return () => abort.current?.abort();
  }, [load]);

  const switchScenario = useCallback(
    async (scenario: ScenarioId, seconds = 90) => {
      if (!instance) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setSolving(true);
      setSolvingLabel(`Solving scenario ${scenario}…`);
      try {
        const started = await api.startRun({ instance_id: instance.id, scenario, seconds, label: `Scenario ${scenario}` });
        const done = await waitForRun(started.id, { signal: controller.signal });
        if (!controller.signal.aborted && done.schedule) setRun(done);
        else if (!controller.signal.aborted && done.status === "failed") {
          setError(done.error ?? done.message ?? `Scenario ${scenario} did not solve.`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "The scenario run failed.");
      } finally {
        setSolving(false);
        setSolvingLabel("");
      }
    },
    [instance],
  );

  const runWhatIf = useCallback<PlanState["runWhatIf"]>(
    async ({ scenario, overrides, seconds = 90, label = "What-if", baselineId = null }) => {
      if (!instance || !run) throw new Error("No plan is loaded.");
      const started = await api.startRun({
        instance_id: instance.id,
        scenario: scenario ?? run.scenario,
        seconds,
        overrides,
        label,
        baseline_id: baselineId ?? run.id,
      });
      return waitForRun(started.id);
    },
    [instance, run],
  );

  const plan = useMemo(() => (instance && run ? buildPlan(instance, run) : null), [instance, run]);

  const value: PlanState = {
    status,
    error,
    instance,
    run,
    plan,
    solving,
    solvingLabel,
    reload: load,
    switchScenario,
    runWhatIf,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlanState(): PlanState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlanState must be used inside PlanProvider");
  return ctx;
}

/** For tabs that only render once a plan exists. */
export function usePlan(): PlanModel {
  const { plan } = usePlanState();
  if (!plan) throw new Error("usePlan used outside a ready plan");
  return plan;
}
