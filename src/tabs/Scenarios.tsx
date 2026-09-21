// Spec section 10 — Scenarios. Changes become Override rows and are solved by the
// planning service on a copy of the plan; the approved plan is never modified.

import { RunCard } from "../components/RunCard";
import { useState } from "react";
import type { Run } from "../api/types";
import { buildPlan, type PlanModel } from "../data/adapt";
import { usePlanState } from "../state/plan";
import { scenarioOverrides, stressPresets, type Assumption, type TplKey } from "../data/stress";

/** Only changes the solver can actually take as an Override are offered. */
const TPLS = [
  {
    key: "reduce",
    label: "Capacity reduction",
    hint: "supply falls by 2 nights",
  },
  { key: "close", label: "Track closure", hint: "no work at all" },
  {
    key: "extra",
    label: "Extra access night",
    hint: "supply rises by 1 night",
  },
] as const;

const METRICS = [
  "Feasibility",
  "Objective score (lower is better)",
  "Contracts delayed",
  "Overrun days",
  "ECLO nights",
  "Excess access nights",
  "High-risk activities",
  "Activities moved",
] as const;

function metricsOf(plan: PlanModel, moved: number | null) {
  const s = plan.validation.soft_scores;
  return [
    plan.validation.feasible
      ? "Feasible"
      : `${plan.validation.hard_violations.length} violations`,
    String(plan.validation.score),
    String(s.contracts_overrunning),
    String(s.overrun_days_total),
    String(s.eclo_nights_total),
    String(s.excess_access_nights_total),
    String(plan.activities.filter((a) => a.frag >= 65).length),
    moved === null ? "—" : String(moved),
  ];
}

export function Scenarios() {
  const { plan, instance, run: baselineRun, runWhatIf } = usePlanState();
  const [comparisonBaseline, setComparisonBaseline] = useState<Run | null>(
    null,
  );
  const [tpl, setTpl] = useState<TplKey>("reduce");
  const [location, setLocation] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [assumps, setAssumps] = useState<Assumption[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ run: Run; plan: PlanModel } | null>(
    null,
  );
  const [terminalRun, setTerminalRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(90);
  const [pick, setPick] = useState<number | null>(null);

  if (!plan || !instance || !baselineRun) return null;

  const capacityOf = new Map(plan.locations.map(l => [l.id, l.capacity]));
  const loc = location || plan.locations[0]?.id || "";
  const f = from || plan.busiestWeek;
  const t = to || Math.min(instance.horizon_weeks, plan.busiestWeek + 1);
  const presets = stressPresets(instance, baselineRun);
  const overrides = scenarioOverrides(assumps, instance, baselineRun);
  const labelOf = (id: string) =>
    plan.locations.find((l) => l.id === id)?.label ?? id;

  const describe = (a: Assumption) => {
    const cap = capacityOf.get(a.location) ?? 0;
    const w = a.from === a.to ? `W${a.from}` : `W${a.from}–${a.to}`;
    const what =
      a.tpl === "close"
        ? "closed to all works"
        : a.tpl === "reduce"
          ? `capacity ${cap} → ${Math.max(0, cap - 2)} nights`
          : `capacity ${cap} → ${cap + 1} nights`;
    return `${labelOf(a.location)} ${what} · ${w}`;
  };

  const scope = plan.activities.filter((a) =>
    assumps.some(
      (x) => (x.tpl === "close"
        ? instance.activities.find(row => row.activity_id === a.id)?.protected.includes(x.location)
        : a.route.includes(x.location)) && a.weeks.some(w => w >= x.from && w <= x.to),
    ),
  );
  const scopeContracts = [...new Set(scope.map((a) => a.contract))];

  const run = async (changes = assumps, label = "What-if") => {
    setComparisonBaseline(baselineRun);
    setBusy(true);
    setError(null);
    setResult(null);
    setTerminalRun(null);
    setPick(null);
    try {
      const selected = scenarioOverrides(changes, instance, baselineRun);
      if (selected.length > 100) throw new Error("Choose at most 100 location-weeks per simulation.");
      const done = await runWhatIf({ overrides: selected, seconds, label, baselineId: baselineRun.id });
      setTerminalRun(done);
      if (!done.schedule || !done.validation) {
        setError(
          done.message ??
            done.error ??
            `The solver returned ${done.solver_status}.`,
        );
        setResult(null);
      } else {
        const built = buildPlan(instance, done);
        if (built) setResult({ run: done, plan: built });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The what-if run failed.");
    } finally {
      setBusy(false);
    }
  };

  const compared =
    (comparisonBaseline && buildPlan(instance, comparisonBaseline)) || plan;
  const columns: {
    name: string;
    sub: string;
    values: string[];
    tag: string;
    tagCls: string;
    pros: string[];
    cons: string[];
  }[] = [
    {
      name: "Comparison baseline",
      sub: `Scenario ${compared.scenario} · ${compared.solverStatus}`,
      values: metricsOf(compared, null),
      tag: "Viewed schedule",
      tagCls: "pill p-ok",
      pros: [
        "Nothing changes for any contractor",
        `${compared.validation.completed_activities} of ${compared.validation.total_activities} activities scheduled`,
      ],
      cons: [
        compared.validation.soft_scores.overrun_days_total
          ? `${compared.validation.soft_scores.overrun_days_total} overrun days already priced in`
          : "No overrun, but no spare capacity either",
        `${compared.activities.filter((a) => a.alternatives === 0).length} activities have nowhere else to go`,
      ],
    },
  ];

  if (result) {
    const moved = result.run.diff?.changed_activities.length ?? null;
    const cross = result.plan.scenario !== compared.scenario;
    const delta = cross
      ? null
      : result.plan.validation.score - compared.validation.score;
    columns.push({
      name: "Your scenario",
      sub: `${assumps.length} change${assumps.length === 1 ? "" : "s"} · ${result.run.solver_status}`,
      values: metricsOf(result.plan, moved),
      tag: "Simulated",
      tagCls: "pill p-info",
      pros: [
        delta === 0
          ? "Score unchanged — the disruption was absorbed within available slack"
          : delta !== null && delta < 0
            ? `Score improves by ${Math.abs(delta).toFixed(1)}`
            : "Shows the cost before anything is committed",
        moved !== null
          ? `${moved} activities move`
          : "Solved on a copy of the plan",
      ],
      cons: [
        delta !== null && delta > 0
          ? `Score worsens by ${delta.toFixed(1)}`
          : "Needs the capacity change to actually happen",
        result.plan.validation.feasible
          ? "Still feasible, but with less contingency"
          : "Not feasible as specified",
      ],
    });
  } else if (terminalRun) {
    const infeasible = terminalRun.solver_status === "INFEASIBLE";
    columns.push({
      name: "Stress result", sub: terminalRun.label || "What-if",
      values: [infeasible ? "Infeasible" : "No complete result", "—", "—", "—", "—", "—", "—", "—"],
      tag: infeasible ? "Delivery blocked" : "Search incomplete", tagCls: "pill p-crit",
      pros: ["The baseline remains unchanged"],
      cons: [infeasible ? "The selected closures prevent full delivery within the planning horizon" : "No complete schedule was found within this search budget"],
    });
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Scenarios</h1>
          <span className="muted small">
            Test a change on a copy of the plan, then compare side by side · the
            approved plan never changes here
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <span className="small muted">Solve budget</span>
        <select
          className="input"
          style={{ width: 110, height: 30 }}
          value={String(seconds)}
          onChange={(e) => setSeconds(Number(e.target.value))}
          aria-label="Solve budget"
          disabled={busy}
        >
          {[30, 60, 90, 150].map((s) => (
            <option key={s} value={String(s)}>
              {s} seconds
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "360px minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div
          className="card"
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 11,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="h2">What if…</span>
            <div style={{ flex: 1 }} />
            <span className="pill p-grey">
              {assumps.length} change{assumps.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="field">
            <label htmlFor="tpl">Change</label>
            <select
              id="tpl"
              className="input"
              style={{ height: 34 }}
              value={tpl}
              disabled={busy}
              onChange={(e) => setTpl(e.target.value as TplKey)}
            >
              {TPLS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="loc">Where</label>
            <select
              id="loc"
              className="input"
              style={{ height: 34 }}
              value={loc}
              disabled={busy}
              onChange={(e) => setLocation(e.target.value)}
            >
              {[...plan.locations]
                .sort((a, b) => b.peak - a.peak)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label} · cap {l.capacity} · peak {Math.round(l.peak)}%
                  </option>
                ))}
            </select>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 10,
            }}
          >
            <div className="field">
              <label htmlFor="wf">From</label>
              <select
                id="wf"
                className="input"
                style={{ height: 34 }}
                value={String(f)}
                disabled={busy}
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
              <label htmlFor="wt">To</label>
              <select
                id="wt"
                className="input"
                style={{ height: 34 }}
                value={String(t)}
                disabled={busy}
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

          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setAssumps([
                ...assumps,
                {
                  tpl,
                  location: loc,
                  from: Math.min(f, t),
                  to: Math.max(f, t),
                },
              ]);
              setResult(null);
              setTerminalRun(null);
            }}
          >
            Add this change
          </button>

          <div className="divider" />
          <span className="card-h">In this scenario</span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minHeight: 88,
            }}
          >
            {assumps.map((a, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid #e6e9ef",
                  borderRadius: 7,
                }}
              >
                <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.35 }}>
                  {describe(a)}
                </span>
                <button
                  className="x-btn"
                  style={{ width: 24, height: 24, flexShrink: 0 }}
                  aria-label="Remove change"
                  disabled={busy}
                  onClick={() => {
                    setAssumps(assumps.filter((_, k) => k !== i));
                    setResult(null);
                    setTerminalRun(null);
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
            {!assumps.length && (
              <div
                className="muted small"
                style={{
                  padding: 16,
                  textAlign: "center",
                  border: "1.5px dashed #cfd5df",
                  borderRadius: 7,
                }}
              >
                Nothing yet — add a change above, or load a stress test.
              </div>
            )}
          </div>

          <span className="small muted">
            {assumps.length
              ? `${overrides.length} capacity overrides · touches ${scope.length} activities across ${scopeContracts.length} contracts`
              : "Add a change to see what it touches"}
          </span>

          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={!assumps.length || busy}
          >
            {busy
              ? `Solving (${seconds}s budget)…`
              : result
                ? "Run again"
                : "Run scenario"}
          </button>

          <div className="divider" />
          <span className="card-h">Stress tests</span>
          <span className="small muted">Select a test to run it against the viewed schedule. Closures target critical work windows; full delivery may become infeasible.</span>
          {presets.map((p) => (
            <button
              key={p.name}
              className="row-btn"
              style={{
                flexDirection: "column",
                alignItems: "stretch",
                gap: 3,
                padding: "10px 12px",
                border: "1px solid #e6e9ef",
                borderRadius: 7,
              }}
              disabled={busy}
              onClick={() => {
                setAssumps(p.a);
                void run(p.a, p.name);
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                <div style={{ flex: 1 }} />
                <span
                  className={
                    p.sev === "Severe"
                      ? "pill p-crit"
                      : p.sev === "High"
                        ? "pill p-warn"
                        : "pill p-info"
                  }
                >
                  {p.sev}
                </span>
              </div>
              <span className="small muted">{p.desc}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {error && <div className="callout c-red">{error}</div>}

          <div className="card" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid #e6e9ef",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span className="h2">Side by side</span>
              <div style={{ flex: 1 }} />
              <span className="small muted">
                {result
                  ? `Solved in ${result.run.elapsed_seconds}s · ${result.run.solver_status}`
                  : "Run your scenario to fill the second column"}
              </span>
            </div>
            <table className="tbl" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr>
                  <th style={{ width: 260 }}>Metric</th>
                  {columns.map((c, i) => (
                    <th
                      key={c.name}
                      style={pick === i ? { background: "#e3ecfb" } : undefined}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            color: "#14213a",
                            textTransform: "none",
                            letterSpacing: 0,
                            fontWeight: 600,
                          }}
                        >
                          {c.name}
                        </span>
                        <span
                          style={{
                            fontWeight: 400,
                            textTransform: "none",
                            letterSpacing: 0,
                            color: "#5b6578",
                          }}
                        >
                          {c.sub}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m, mi) => (
                  <tr key={m}>
                    <td style={{ fontWeight: 500 }}>{m}</td>
                    {columns.map((c, i) => {
                      const v = c.values[mi];
                      let cls = "";
                      if (mi === 0)
                        cls = v === "Feasible" ? "pill p-ok" : "pill p-crit";
                      if (mi === 2 && Number(v) > 0) cls = "pill p-warn";
                      if (mi === 4 && Number(v) > 0) cls = "pill p-eclo";
                      if (mi === 5 && Number(v) > 0) cls = "pill p-warn";
                      return (
                        <td
                          key={i}
                          style={{
                            ...(pick === i ? { background: "#f2f6fd" } : {}),
                            ...(mi === 1 ? { fontWeight: 600 } : {}),
                          }}
                        >
                          <span className={cls}>{v}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result && (
            <RunCard
              candidate={result.run}
              baseline={comparisonBaseline}
              onChange={(next) => {
                if (next.schedule && next.validation)
                  setResult({ run: next, plan: buildPlan(instance, next)! });
              }}
            />
          )}
          {terminalRun && !result && <RunCard candidate={terminalRun} baseline={comparisonBaseline} />}
          {result?.run.diff && (
            <div
              className="card"
              style={{
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="h2">What moved</span>
                <span className="pill p-grey">
                  from the solver's own diff against the approved plan
                </span>
                <div style={{ flex: 1 }} />
                <span
                  className={
                    (result.run.diff.score_delta ?? 0) > 0
                      ? "pill p-crit"
                      : "pill p-ok"
                  }
                >
                  score {(result.run.diff.score_delta ?? 0) > 0 ? "+" : ""}
                  {result.run.diff.score_delta}
                </span>
              </div>
              <span style={{ fontSize: 13 }}>
                {result.run.diff.changed_activities.length
                  ? result.run.diff.changed_activities.join(", ")
                  : "No activity changed week."}
              </span>
              <span className="small muted">
                {result.run.diff.added_accesses} accesses added ·{" "}
                {result.run.diff.removed_accesses} removed
              </span>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gap: 12,
            }}
          >
            {columns.map((c, i) => (
              <div
                key={c.name}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 9,
                  padding: 14,
                  borderRadius: 8,
                  background: "#fff",
                  minHeight: 170,
                  border:
                    pick === i ? "2px solid #1d5fd1" : "1px solid #dfe3ea",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {c.name}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span className={c.tagCls}>{c.tag}</span>
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".05em",
                      color: "#176842",
                    }}
                  >
                    PROS
                  </span>
                  {c.pros.map((x) => (
                    <span
                      key={x}
                      style={{
                        fontSize: 12.5,
                        display: "flex",
                        gap: 7,
                        lineHeight: 1.4,
                      }}
                    >
                      <span style={{ color: "#176842", fontWeight: 700 }}>
                        +
                      </span>
                      <span>{x}</span>
                    </span>
                  ))}
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: ".05em",
                      color: "#a12a22",
                    }}
                  >
                    CONS
                  </span>
                  {c.cons.map((x) => (
                    <span
                      key={x}
                      style={{
                        fontSize: 12.5,
                        display: "flex",
                        gap: 7,
                        lineHeight: 1.4,
                      }}
                    >
                      <span style={{ color: "#a12a22", fontWeight: 700 }}>
                        −
                      </span>
                      <span>{x}</span>
                    </span>
                  ))}
                </div>
                <button
                  className={
                    pick === i ? "btn btn-sm btn-primary" : "btn btn-sm"
                  }
                  style={{ marginTop: "auto" }}
                  onClick={() => setPick(i)}
                >
                  {pick === i ? "Preferred" : "Prefer this"}
                </button>
              </div>
            ))}
          </div>

          {pick !== null && (
            <div className="callout c-blue">
              <strong>{columns[pick].name}</strong> marked as your preferred
              option. Nothing in the plan changes until it is signed off.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
