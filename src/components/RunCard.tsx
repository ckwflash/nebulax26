import { useEffect, useState } from "react";
import { api, waitForRun } from "../api/client";
import type { Run } from "../api/types";
import { available, pending, usePlanState } from "../state/plan";

/** Shared comparison and explicit adoption controls for every preview source. */
export function RunCard({
  candidate,
  baseline,
  adoption = true,
  onChange,
}: {
  candidate: Run;
  baseline?: Run | null;
  adoption?: boolean;
  onChange?: (run: Run) => void;
}) {
  const { approved, adoptRun, refreshApproval, viewRun, signal } =
    usePlanState();
  const [run, setRun] = useState(candidate);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setRun(candidate);
  }, [candidate]);
  useEffect(() => {
    if (!pending(run)) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    waitForRun(run.id, { signal: controller.signal })
      .then((done) => {
        setRun(done);
        onChange?.(done);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      signal.removeEventListener("abort", abort);
    };
  }, [run.id, run.status, signal, retry]);
  const before = baseline?.validation;
  const report = run.validation;
  const cross = !!baseline && baseline.scenario !== run.scenario;
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };
  const committed = run.id === approved?.approved_run_id;
  return (
    <div
      className="card"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>
          {run.label || "Preview"} · Scenario {run.scenario}
        </strong>
        <span
          className={
            available(run)
              ? "pill p-ok"
              : pending(run)
                ? "pill p-info"
                : "pill p-warn"
          }
        >
          {committed
            ? "Approved"
            : pending(run)
              ? run.status
              : available(run)
                ? "Checked preview"
                : "Unavailable"}
        </span>
      </div>
      <span className="small muted">
        {run.solver_status ?? "Waiting for the solver"}
        {run.elapsed_seconds !== undefined ? ` · ${run.elapsed_seconds}s` : ""}
        {run.message ? ` · ${run.message}` : ""}
      </span>
      {report && (
        <div className="kv">
          <div>
            <span>
              Local scenario score {cross ? "(different formulas)" : ""}
            </span>
            <span>
              {before ? `${baseline?.scenario}: ${before.score} → ` : ""}
              {run.scenario}: {report.score}
              {!cross && run.diff?.score_delta != null
                ? ` (${run.diff.score_delta >= 0 ? "+" : ""}${run.diff.score_delta})`
                : ""}
            </span>
          </div>
          <div>
            <span>Coverage / changed activities</span>
            <span>
              {report.coverage_percent}% /{" "}
              {run.diff?.changed_activities.length ?? "—"}
            </span>
          </div>
          <div>
            <span>Overrun days</span>
            <span>
              {before ? `${before.soft_scores.overrun_days_total} → ` : ""}
              {report.soft_scores.overrun_days_total}
            </span>
          </div>
          <div>
            <span>ECLO / excess location nights</span>
            <span>
              {before
                ? `${before.soft_scores.eclo_nights_total} / ${before.soft_scores.excess_access_nights_total} → `
                : ""}
              {report.soft_scores.eclo_nights_total} /{" "}
              {report.soft_scores.excess_access_nights_total}
            </span>
          </div>
          <div>
            <span>Safety / violations</span>
            <span>
              {report.safety_verified ? "Verified" : "Unverified"} /{" "}
              {report.hard_violations.length}
            </span>
          </div>
        </div>
      )}
      {cross && (
        <span className="small muted">
          Compare operational changes across scenarios; their scores cannot be
          ranked against each other.
        </span>
      )}
      {run.optimization && (
        <details>
          <summary className="small">
            Preference objective and search bounds
          </summary>
          {run.optimization.stages.map((s) => (
            <p className="small" key={s.name}>
              {s.name}: {s.value ?? "—"} · lower bound {s.bound ?? "—"} ·{" "}
              {s.status}
            </p>
          ))}
          <span className="small muted">
            Separate from the independently checked scenario score.{" "}
            {run.optimization.proven_optimal
              ? "All objective stages proven optimal in the local model."
              : "Optimality is not proven for every stage."}
          </span>
        </details>
      )}
      {(error || run.error) && (
        <div role="alert" className="callout c-red">
          {error || run.error}
          {error && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setError("");
                setRetry((x) => x + 1);
                void act(refreshApproval);
              }}
            >
              Refresh and retry
            </button>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {run.schedule && run.validation && (
          <button className="btn btn-sm" onClick={() => viewRun(run)}>
            View schedule
          </button>
        )}
        {adoption && (
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !available(run) || committed}
            onClick={() => void act(() => adoptRun(run))}
          >
            {committed ? "Approved plan" : "Adopt this plan"}
          </button>
        )}
        <button
          className="btn btn-sm"
          disabled={busy || pending(run)}
          onClick={() =>
            void act(async () => {
              const next = await api.improve(run.id);
              signal.throwIfAborted();
              setRun(next);
              onChange?.(next);
            })
          }
        >
          Improve · 300s
        </button>
        {available(run) && (
          <a className="btn btn-sm" href={`/api/runs/${run.id}/export`}>
            Download three CSVs
          </a>
        )}
      </div>
    </div>
  );
}
