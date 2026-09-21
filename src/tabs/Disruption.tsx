import { useEffect, useState } from "react";
import { api } from "../api/client";
import { RunCard } from "../components/RunCard";
import type { RecoveryBatch, Weights, Run } from "../api/types";
import { buildPlan, type PlanModel } from "../data/adapt";
import { PPILL } from "../data/style";
import { pending, usePlanState } from "../state/plan";
import type { TabId } from "../shell/tabs";

const PHILOSOPHIES: Record<string, [string, string]> = {
  churn: [
    "Minimum churn",
    "Current scenario. Minimize changed activities, then its scenario score.",
  ],
  deadlines: [
    "Protect deadlines",
    "Scenario B. Meet planned deadlines and finish no later than baseline; minimize supply cost, then churn.",
  ],
  passengers: [
    "Protect passengers",
    "Scenario A. No ECLO or excess capacity; minimize weighted delay, then churn.",
  ],
  p1: [
    "Protect P1",
    "Scenario C. Freeze Priority-1 weeks and ECLO assignments; minimize C score, then churn.",
  ],
  custom: [
    "Custom",
    "Scenario C. Optimize the four preference weights plus excess location nights.",
  ],
};

export function Disruption({ go }: { go: (t: TabId) => void }) {
  const { plan, instance, run, signal } = usePlanState();
  const [step, setStep] = useState(1);
  const [locId, setLocId] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [severity, setSeverity] = useState("Full closure");
  const [reason, setReason] = useState(
    "Drainage culvert collapse — reported by PICOP",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    run: Run;
    plan: PlanModel;
  } | null>(null);

  const [improved, setImproved] = useState<Record<string, Run>>({});
  const [batch, setBatch] = useState<RecoveryBatch | null>(null);
  const [baseline, setBaseline] = useState<Run | null>(null);
  const [weights, setWeights] = useState<Weights>({
    churn: 6,
    deadlines: 7,
    passengers: 5,
    priority1: 8,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!batch || !pending(batch)) return;
    let alive = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const poll = async () => {
      while (alive && !controller.signal.aborted) {
        const next = await api.recovery(batch.id, controller.signal);
        if (!alive) return;
        setBatch(next);
        if (!pending(next)) {
          setBusy(false);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void poll().catch((e) => {
      if (alive && !controller.signal.aborted) {
        setError(e.message);
        setBusy(false);
      }
    });
    return () => {
      alive = false;
      controller.abort();
      signal.removeEventListener("abort", abort);
    };
  }, [batch?.id, retry, signal]);
  if (!plan || !instance || !run) return null;

  const loc =
    locId || [...plan.locations].sort((a, b) => b.peak - a.peak)[0]?.id || "";
  const f = from || plan.busiestWeek;
  const t = to || Math.min(instance.horizon_weeks, plan.busiestWeek + 1);
  const location = plan.locations.find((l) => l.id === loc)!;
  const full = severity === "Full closure";

  const direct = plan.activities.filter(
    (a) =>
      (full
        ? instance.activities
            .find((row) => row.activity_id === a.id)
            ?.protected.includes(loc)
        : a.route.includes(loc)) && a.weeks.some((w) => w >= f && w <= t),
  );
  const directIds = new Set(direct.map((a) => a.id));
  const secondary = plan.activities.filter(
    (a) =>
      !directIds.has(a.id) &&
      (a.co.some((id) => directIds.has(id)) ||
        direct.some((d) => d.successors.includes(a.id))),
  );
  const exposedContracts = [...new Set(direct.map((a) => a.contract))];
  const p1 = [
    ...new Set(direct.filter((a) => a.priority === 1).map((a) => a.contract)),
  ];
  const nightsLost = direct.reduce(
    (n, a) => n + a.weeks.filter((w) => w >= f && w <= t).length,
    0,
  );

  const sc = (i: number) =>
    "step " + (step === i ? "on" : step > i ? "done" : "");

  const solveRecovery = async () => {
    setBusy(true);
    setError(null);
    try {
      const overrides = [];
      for (let w = f; w <= t; w++)
        overrides.push({
          location_id: loc,
          week: w,
          capacity: full
            ? 0
            : Math.max(0, location.capacity - Math.ceil(location.capacity / 2)),
          closed: full,
        });
      setBaseline(run);
      setRecovery(null);
      setImproved({});
      const next = await api.recover({
        instance_id: instance.id,
        scenario: run.scenario,
        baseline_id: run.id,
        overrides,
        weights,
      });
      signal.throwIfAborted();
      setBatch(next);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The recovery run failed.");
      setBusy(false);
    }
  };

  // Change map: compare the approved plan with the recovery, activity by activity.
  const baselinePlan =
    baseline?.schedule && baseline.validation
      ? (buildPlan(instance, baseline) ?? plan)
      : plan;
  const changes = recovery
    ? baselinePlan.activities
        .map((before) => {
          const after = recovery.plan.activities.find(
            (x) => x.id === before.id,
          )!;
          const movedWeeks =
            recovery.run.diff?.changed_activities.includes(before.id) ??
            before.weeks.join(",") !== after.weeks.join(",");
          const contractBefore = baselinePlan.contracts.find(
            (c) => c.id === before.contract,
          )!;
          const contractAfter = recovery.plan.contracts.find(
            (c) => c.id === before.contract,
          )!;
          const later = contractAfter.overrunDays > contractBefore.overrunDays;
          return { before, after, movedWeeks, later };
        })
        .filter((c) => c.movedWeeks)
    : [];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Disruption Response</h1>
          <span className="muted small">
            Dynamic replanning for changes that have actually happened ·
            emphasis on minimal schedule churn
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {busy && <span className="pill p-info">Re-solving…</span>}
      </div>

      <div
        className="card"
        style={{ padding: "12px 20px", display: "flex", alignItems: "center" }}
      >
        <div className={sc(1)}>
          <span className="n">1</span>Define disruption
        </div>
        <div
          style={{
            flex: 1,
            height: 2,
            background: "#e6e9ef",
            margin: "0 12px",
          }}
        />
        <div className={sc(2)}>
          <span className="n">2</span>Blast radius
        </div>
        <div
          style={{
            flex: 1,
            height: 2,
            background: "#e6e9ef",
            margin: "0 12px",
          }}
        />
        <div className={sc(3)}>
          <span className="n">3</span>Recovery
        </div>
        <div
          style={{
            flex: 1,
            height: 2,
            background: "#e6e9ef",
            margin: "0 12px",
          }}
        />
        <div className={sc(4)}>
          <span className="n">4</span>Change map
        </div>
      </div>

      {error && <div className="callout c-red">{error}</div>}

      {step === 1 && (
        <div
          className="card"
          style={{
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            maxWidth: 720,
          }}
        >
          <span className="h2">Step 1 — Define disruption</span>
          <div className="field">
            <label htmlFor="dl">Location</label>
            <select
              id="dl"
              className="input"
              value={loc}
              onChange={(e) => setLocId(e.target.value)}
            >
              {[...plan.locations]
                .sort((a, b) => b.peak - a.peak)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label} · capacity {l.capacity} · peak{" "}
                    {Math.round(l.peak)}%
                  </option>
                ))}
            </select>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            <div className="field">
              <label htmlFor="ds">Severity</label>
              <select
                id="ds"
                className="input"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                <option>Full closure</option>
                <option>Partial — half capacity</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="df">From week</label>
              <select
                id="df"
                className="input"
                value={String(f)}
                onChange={(e) => setFrom(Number(e.target.value))}
              >
                {plan.weeks.map((w) => (
                  <option key={w} value={String(w)}>
                    Week {w}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dt2">To week</label>
              <select
                id="dt2"
                className="input"
                value={String(t)}
                onChange={(e) => setTo(Number(e.target.value))}
              >
                {plan.weeks.map((w) => (
                  <option key={w} value={String(w)}>
                    Week {w}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="dr">Reason</label>
            <input
              id="dr"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <span className="small muted">
            This becomes {t - f + 1} capacity override{t - f === 0 ? "" : "s"}{" "}
            on a copy of the plan. Nothing changes until you approve a recovery.
          </span>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn btn-primary"
              disabled={t < f}
              onClick={() => setStep(2)}
            >
              Map the blast radius
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div
          className="card"
          style={{
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="h2">Blast radius — {location.label}</span>
              <span className="small muted">
                {severity} · Weeks {f}–{t} · {reason}
              </span>
            </div>
            <div style={{ flex: 1 }} />
            <span className={full ? "pill p-crit" : "pill p-warn"}>
              {full ? "Severe — location unusable" : "Moderate — half capacity"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "270px minmax(0, 1fr) minmax(0, 1fr)",
              gap: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 14,
                borderRadius: 8,
                border: "2px solid #c1352c",
                background: "#fdf4f3",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".06em",
                  color: "#a12a22",
                }}
              >
                ORIGIN
              </span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>
                {location.label}
              </span>
              <div className="divider" />
              <span className="small muted">Nominal capacity</span>
              <span style={{ fontWeight: 600 }}>
                {location.capacity} possessions / week
              </span>
              <span className="small muted">Peak utilisation</span>
              <span style={{ fontWeight: 600 }}>
                {Math.round(location.peak)}%
              </span>
              <span className="small muted">Booked nights lost</span>
              <span style={{ fontWeight: 600 }}>{nightsLost}</span>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 14,
                borderRadius: 8,
                border: "1px solid #f2c4c0",
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".06em",
                    color: "#a12a22",
                  }}
                >
                  DIRECT
                </span>
                <span className="pill p-grey">{direct.length}</span>
              </div>
              <span className="small muted">
                Work whose route or safety protection footprint intersects this
                closure in its actual scheduled weeks.
              </span>
              {direct.slice(0, 8).map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 12.5,
                  }}
                >
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {d.id}
                  </span>
                  <span className={PPILL[d.priority]}>P{d.priority}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.contract} · {d.type}
                  </span>
                  <span className="muted">
                    W{d.weeks.filter((w) => w >= f && w <= t).join(",")}
                  </span>
                </div>
              ))}
              {!direct.length && (
                <span className="muted small">
                  Nothing is booked here in those weeks.
                </span>
              )}
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 14,
                borderRadius: 8,
                border: "1px solid #f1dcae",
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".06em",
                    color: "#8a5a0c",
                  }}
                >
                  SECONDARY
                </span>
                <span className="pill p-grey">{secondary.length}</span>
              </div>
              <span className="small muted">
                Co-share partners and successors of the affected work.
              </span>
              {secondary.slice(0, 8).map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 12.5,
                  }}
                >
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {d.id}
                  </span>
                  <span className={PPILL[d.priority]}>P{d.priority}</span>
                  <span style={{ flex: 1 }}>{d.contract}</span>
                </div>
              ))}
              {!secondary.length && (
                <span className="muted small">
                  No co-sharing or precedence links.
                </span>
              )}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 10,
            }}
          >
            {[
              {
                head: "Contracts exposed",
                value: exposedContracts.join(", ") || "none",
                color: "#c1352c",
              },
              {
                head: "Priority-1 exposure",
                value: p1.length ? p1.join(", ") : "None",
                color: p1.length ? "#c1352c" : "#176842",
              },
              {
                head: "Activities to re-home",
                value: String(direct.length + secondary.length),
                color: "#b7791f",
              },
              {
                head: "Booked nights lost",
                value: String(nightsLost),
                color: "#5b35a8",
              },
            ].map((d) => (
              <div
                key={d.head}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  padding: "11px 12px",
                  borderRadius: 7,
                  background: "#fff",
                  border: "1px solid #e6e9ef",
                }}
              >
                <span className="card-h">{d.head}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: d.color }}>
                  {d.value}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>
              Generate recovery
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <>
          <div
            className="card"
            style={{
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <h2 className="h2">Step 3 — Compare five recovery strategies</h2>
            <p className="small muted">
              {location.label} · {severity} · W{f}–{t}. Five options share 90
              seconds, initially 18 each; unused time carries forward. Completed
              results appear immediately.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 16,
              }}
            >
              {(Object.keys(weights) as (keyof Weights)[]).map((key) => (
                <label className="field" key={key}>
                  {key === "priority1" ? "Priority 1" : key} · {weights[key]}
                  <input
                    aria-label={`${key} preference`}
                    type="range"
                    min={0}
                    max={10}
                    value={weights[key]}
                    disabled={busy}
                    onChange={(e) =>
                      setWeights((w) => ({
                        ...w,
                        [key]: Number(e.target.value),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <span className="small muted">
              Custom preferences: P1 weighting adds protection beyond general
              delay weighting. Presets optimize each next objective only after
              proving the previous one optimal.
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() => setStep(2)}
              >
                Back to blast radius
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || !run.validation?.feasible}
                onClick={() => void solveRecovery()}
              >
                {busy
                  ? "Comparing strategies…"
                  : "Compare five recoveries · 90s total"}
              </button>
              {error && batch && (
                <button
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setBusy(true);
                    setRetry((n) => n + 1);
                  }}
                >
                  Retry polling
                </button>
              )}
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            {Object.entries(PHILOSOPHIES).map(([key, [name, policy]]) => {
              const original = batch?.results.find(
                (r) => r.philosophy === key,
              )?.run;
              const option = improved[key] ?? original;
              return (
                <div
                  key={key}
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <h3 className="h2">{name}</h3>
                  <p className="small muted">{policy}</p>
                  {option ? (
                    <>
                      <RunCard
                        candidate={option}
                        baseline={baseline}
                        onChange={(next) => {
                          if (next.id !== original?.id)
                            setImproved((current) => ({
                              ...current,
                              [key]: next,
                            }));
                        }}
                      />
                      {option.schedule && option.validation && (
                        <button
                          className="btn"
                          onClick={() => {
                            setRecovery({
                              run: option,
                              plan: buildPlan(instance, option)!,
                            });
                            setStep(4);
                          }}
                        >
                          Inspect change map
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="card" style={{ padding: 16 }}>
                      Ready to compare
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {batch?.error && <div className="callout c-red">{batch.error}</div>}
        </>
      )}

      {step === 4 && recovery && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 330px",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
              className="card"
              style={{
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 13,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="h2">Change map</span>
                <span className="pill p-info">{changes.length} moved</span>
                <span
                  className={
                    recovery.plan.validation.feasible
                      ? "pill p-ok"
                      : "pill p-crit"
                  }
                >
                  {recovery.plan.validation.feasible
                    ? "Feasible"
                    : "Violations"}
                </span>
                <div style={{ flex: 1 }} />
                <span className="pill p-grey">
                  {baseline?.scenario}: {baselinePlan.validation.score} →{" "}
                  {recovery.run.scenario}: {recovery.plan.validation.score}
                </span>
              </div>

              {changes.slice(0, 14).map((c) => (
                <div
                  key={c.before.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "22px 70px 90px 1fr 26px 1fr 140px",
                    gap: 10,
                    alignItems: "center",
                    fontSize: 13,
                    padding: "8px 10px",
                    borderRadius: 7,
                    background: c.later ? "#fffafa" : "#fff",
                    border: `1px solid ${c.later ? "#f2c4c0" : "#e6e9ef"}`,
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      color: c.later ? "#a12a22" : "#1a4fb0",
                      background: c.later ? "#fbe3e1" : "#e3ecfb",
                    }}
                  >
                    {c.later ? "!" : "→"}
                  </span>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {c.before.id}
                  </span>
                  <span className={PPILL[c.before.priority]}>
                    P{c.before.priority} {c.before.contract}
                  </span>
                  <span className="muted">W{c.before.weeks.join(",")}</span>
                  <span
                    style={{
                      color: "#5b6578",
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                  >
                    →
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    W{c.after.weeks.join(",")}
                  </span>
                  <span className={c.later ? "pill p-crit" : "pill p-grey"}>
                    {c.later ? "contract slips" : "within slack"}
                  </span>
                </div>
              ))}
              {!changes.length && (
                <span className="muted">
                  Nothing moved — the disruption was absorbed without changing
                  any week.
                </span>
              )}
              {changes.length > 14 && (
                <span className="small muted">+{changes.length - 14} more</span>
              )}
            </div>

            <div
              className="card"
              style={{
                padding: "16px 20px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <button className="btn" onClick={() => setStep(3)}>
                Back
              </button>
              <button className="btn" onClick={() => go("scenarios")}>
                Compare in Scenarios
              </button>
              <div style={{ flex: 1 }} />
              <span
                className="small muted"
                style={{ maxWidth: 320, textAlign: "right" }}
              >
                Inspect the checked changes, then use explicit adoption below.
              </span>
            </div>
          </div>

          <div
            className="card"
            style={{
              padding: "16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 9,
            }}
          >
            <span className="h2">Recovery summary</span>
            <RunCard candidate={recovery.run} baseline={baseline} />
            <div className="kv" style={{ gridTemplateColumns: "1fr" }}>
              <div>
                <span>Solver</span>
                <span>
                  {recovery.run.solver_status} in {recovery.run.elapsed_seconds}
                  s
                </span>
              </div>
              <div>
                <span>Overrun</span>
                <span>
                  {baselinePlan.validation.soft_scores.overrun_days_total} →{" "}
                  {recovery.plan.validation.soft_scores.overrun_days_total} days
                </span>
              </div>
              <div>
                <span>ECLO nights</span>
                <span>
                  {baselinePlan.validation.soft_scores.eclo_nights_total} →{" "}
                  {recovery.plan.validation.soft_scores.eclo_nights_total}
                </span>
              </div>
              <div>
                <span>Excess access nights</span>
                <span>
                  {
                    baselinePlan.validation.soft_scores
                      .excess_access_nights_total
                  }{" "}
                  →{" "}
                  {
                    recovery.plan.validation.soft_scores
                      .excess_access_nights_total
                  }
                </span>
              </div>
              <div>
                <span>Re-validation</span>
                <span>
                  {recovery.plan.validation.hard_violations.length} hard
                  violations · safety{" "}
                  {recovery.plan.validation.safety_verified
                    ? "verified"
                    : "unverified"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
