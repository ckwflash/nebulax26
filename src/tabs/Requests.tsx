import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Assessment, ContractorRequest, Run } from "../api/types";
import { RunCard } from "../components/RunCard";
import { pending, usePlanState } from "../state/plan";
import type { TabId } from "../shell/tabs";

export function Requests({ go: _go }: { go: (t: TabId) => void }) {
  const { instance, approved, refreshApproval, viewRun, signal } =
    usePlanState();
  const [rows, setRows] = useState<ContractorRequest[]>([]);
  const [selected, setSelected] = useState("");
  const [improved, setImproved] = useState<Record<string, Run>>({});
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [baseline, setBaseline] = useState<Run | null>(null);
  const [contract, setContract] = useState(
    instance?.projects[0]?.contract_number ?? "",
  );
  const [activity, setActivity] = useState("");
  const [location, setLocation] = useState("");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [reason, setReason] = useState("");
  const [contractor, setContractor] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const refresh = async () => {
    if (instance) {
      const result = await api.requests(instance.id);
      signal.throwIfAborted();
      setRows(result);
    }
  };
  useEffect(() => {
    void refresh().catch((e) => {
      if (!signal.aborted) setError(e.message);
    });
  }, [instance?.id, retry]);
  const request = rows.find((r) => r.id === selected);
  useEffect(() => {
    setAssessment(null);
    setBaseline(null);
    setImproved({});
    if (!request?.assessment_id) return;
    let alive = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const poll = async () => {
      do {
        const result = await api.assessment(request.id, controller.signal);
        if (!alive) return;
        setAssessment(result);
        const base = await api.run(result.baseline_id, controller.signal);
        if (!alive) return;
        setBaseline(base);
        if (!pending(result)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (alive && !controller.signal.aborted);
    };
    void poll().catch((e) => {
      if (alive && !controller.signal.aborted) setError(e.message);
    });
    return () => {
      alive = false;
      controller.abort();
      signal.removeEventListener("abort", abort);
    };
  }, [selected, request?.assessment_id, retry, signal]);
  if (!instance) return null;
  const activities = instance.activities.filter(
    (a) => a.contract_number === contract,
  );
  const a = activities.find((a) => a.activity_id === activity) ?? activities[0];
  const loc = a?.route.includes(location) ? location : (a?.route[0] ?? "");
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (!signal.aborted)
        setError(
          e instanceof Error ? e.message : "The request could not be saved.",
        );
    } finally {
      setBusy(false);
    }
  };
  const decide = async (
    decision: "accepted" | "countered" | "rejected",
    runId: string | null,
  ) => {
    if (!request || !approved) return;
    const result = await api.decide(request.id, decision, runId, approved);
    await refresh();
    await refreshApproval();
    if (decision === "accepted" && result.plan.run) viewRun(result.plan.run);
  };
  const stale =
    assessment?.stale ||
    (assessment && assessment.plan_revision !== approved?.revision);
  const open = request && !["accepted", "rejected"].includes(request.status);
  return (
    <>
      <div>
        <h1 className="h1">Contractor Requests</h1>
        <p className="small muted">
          Reserve at least one access for an activity in a chosen window.
          Assessment preserves all workload and standing capacity.
        </p>
      </div>
      {error && (
        <div role="alert" className="callout c-red">
          {error}{" "}
          <button
            className="btn btn-sm"
            onClick={() => {
              setRetry((n) => n + 1);
              void act(refreshApproval);
            }}
          >
            Refresh
          </button>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 1fr) minmax(0, 2fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div
          className="card"
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <h2 className="h2">New booking request</h2>
          <label className="field">
            Contract
            <select
              className="input"
              value={contract}
              onChange={(e) => {
                setContract(e.target.value);
                setActivity("");
                setLocation("");
              }}
            >
              {instance.projects.map((p) => (
                <option key={p.contract_number}>{p.contract_number}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Activity
            <select
              className="input"
              value={a?.activity_id ?? ""}
              onChange={(e) => {
                setActivity(e.target.value);
                setLocation("");
              }}
            >
              {activities.map((a) => (
                <option key={a.activity_id} value={a.activity_id}>
                  {a.activity_id} · {a.activity_type}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Route location
            <select
              className="input"
              value={loc}
              onChange={(e) => setLocation(e.target.value)}
            >
              {a?.route.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            {(["From week", "To week"] as const).map((label, i) => (
              <label className="field" key={label} style={{ flex: 1 }}>
                {label}
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={instance.horizon_weeks}
                  value={i ? to : from}
                  onChange={(e) =>
                    (i ? setTo : setFrom)(Number(e.target.value))
                  }
                />
              </label>
            ))}
          </div>
          <label className="field">
            Contractor (optional)
            <input
              className="input"
              value={contractor}
              maxLength={120}
              onChange={(e) => setContractor(e.target.value)}
            />
          </label>
          <label className="field">
            Reason
            <textarea
              className="input"
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !a ||
              !reason.trim() ||
              from < 1 ||
              to < from ||
              to > instance.horizon_weeks
            }
            onClick={() =>
              void act(async () => {
                const created = await api.createRequest({
                  instance_id: instance.id,
                  contract_number: contract,
                  activity_id: a.activity_id,
                  location_id: loc,
                  week_from: from,
                  week_to: to,
                  reason: reason.trim(),
                  contractor,
                });
                await refresh();
                setSelected(created.id);
                setReason("");
              })
            }
          >
            Create request
          </button>
          {!approved?.run && (
            <div className="callout c-amber">
              Adopt a baseline plan before assessing requests.
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 18 }}>
            <h2 className="h2">Saved requests</h2>
            {!rows.length && (
              <p className="small muted">
                No requests for this demand book yet.
              </p>
            )}
            {rows.map((r) => (
              <button
                key={r.id}
                className="row-btn"
                style={{
                  padding: 12,
                  width: "100%",
                  borderBottom: "1px solid #e6e9ef",
                  background: selected === r.id ? "#eff4ff" : "transparent",
                }}
                onClick={() => {
                  setSelected(r.id);
                  setError("");
                }}
              >
                {r.activity_id} · W{r.week_from}–{r.week_to}{" "}
                <span className="pill p-grey">{r.status}</span>
              </button>
            ))}
          </div>
          {request && (
            <div
              className="card"
              style={{
                padding: 18,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <h2 className="h2">
                {request.activity_id} · W{request.week_from}–{request.week_to}
              </h2>
              <p className="small">{request.reason}</p>
              <span className="small muted">
                {request.contractor || request.contract_number} ·{" "}
                {request.location_id}
              </span>
              {request.counteroffer_run_id && (
                <span className="pill p-info">
                  Counteroffer recorded; approved plan unchanged until
                  acceptance
                </span>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    !open ||
                    !approved?.run ||
                    (!!assessment && pending(assessment))
                  }
                  onClick={() =>
                    void act(async () => {
                      await api.assess(request.id);
                      await refresh();
                      setRetry((n) => n + 1);
                    })
                  }
                >
                  {assessment && pending(assessment)
                    ? "Assessing…"
                    : "Assess against approved plan · 90s"}
                </button>
                <button
                  className="btn"
                  disabled={busy || !open}
                  onClick={() => void act(() => decide("rejected", null))}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
          {assessment && (
            <>
              {stale && open && (
                <div className="callout c-amber">
                  The approved baseline changed. Reassess before deciding.
                </div>
              )}
              <span className="small muted">
                Assessment {assessment.status} · capacity usage at requested
                location: {assessment.capacity_before ?? "—"}% →{" "}
                {assessment.capacity_after ?? "—"}%
              </span>
              {assessment.error && (
                <div className="callout c-red">{assessment.error}</div>
              )}
              {assessment.options.map((original) => {
                const next = improved[original.run_id];
                const option = next
                  ? {
                      ...original,
                      run: next,
                      run_id: next.id,
                      feasible:
                        next.status === "completed" &&
                        !!next.validation?.feasible,
                    }
                  : original;
                return (
                  <div
                    key={original.run_id}
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <h3 className="h2">
                      {option.kind === "REQUESTED"
                        ? "Requested window"
                        : "Checked alternative"}{" "}
                      · W{option.week_from}–{option.week_to}
                    </h3>
                    <RunCard
                      candidate={option.run}
                      baseline={baseline}
                      adoption={false}
                      onChange={(run) => {
                        if (run.id !== original.run_id)
                          setImproved((current) => ({
                            ...current,
                            [original.run_id]: run,
                          }));
                      }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="btn btn-primary"
                        disabled={busy || !open || !!stale || !option.feasible}
                        onClick={() =>
                          void act(() => decide("accepted", option.run_id))
                        }
                      >
                        Accept window and adopt
                      </button>
                      {option.kind === "ALTERNATIVE" && (
                        <button
                          className="btn"
                          disabled={
                            busy || !open || !!stale || !option.feasible
                          }
                          onClick={() =>
                            void act(() => decide("countered", option.run_id))
                          }
                        >
                          Record counteroffer
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="card" style={{ padding: 18 }}>
                <h3 className="h2">Displaced work · requested window</h3>
                {assessment.displaced.length ? (
                  assessment.displaced.map((d) => (
                    <p className="small" key={d.activity_id}>
                      {d.activity_id} · P{d.priority} · {d.effect}
                    </p>
                  ))
                ) : (
                  <p className="small muted">
                    No changed activities in the checked requested option.
                  </p>
                )}
                <h3 className="h2">Response draft</h3>
                <p className="small">{assessment.draft_response}</p>
                <span className="small muted">
                  Draft only. No message is sent.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
