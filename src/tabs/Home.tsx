// Spec section 5 — Home ("Operations overview"). Every tile and queue row is derived
// from the loaded run; nothing on this screen is hard-coded.

import { useMemo, useState } from "react";
import { shortDate, weekEnding, weekStarting } from "../data/adapt";
import { usePlan } from "../state/plan";
import { SCENARIO_LABEL } from "../state/plan";
import type { TabId } from "../shell/tabs";

type Sev = "URGENT" | "HIGH" | "MEDIUM" | "ACTIVE";

const SEVSTYLE: Record<Sev, [string, string]> = {
  URGENT: ["#c1352c", "#a12a22"],
  HIGH: ["#d9962b", "#8a5a0c"],
  MEDIUM: ["#1d5fd1", "#1a4fb0"],
  ACTIVE: ["#6b46c1", "#5b35a8"],
};

const FILTERS: ("ALL" | Sev)[] = ["ALL", "URGENT", "HIGH", "MEDIUM", "ACTIVE"];

export function Home({ go }: { go: (t: TabId) => void }) {
  const plan = usePlan();
  const [filter, setFilter] = useState<"ALL" | Sev>("ALL");

  const model = useMemo(() => {
    const soft = plan.validation.soft_scores;
    const late = plan.contracts.filter((c) => c.overrunDays > 0).sort((a, b) => b.overrunDays - a.overrunDays);
    const atRisk = plan.contracts.filter((c) => c.status === "At risk" || c.status === "Projected late");
    const fragile = plan.activities.filter((a) => a.frag >= 65).sort((x, y) => y.frag - x.frag);
    const ecloActs = plan.activities.filter((a) => a.eclo);
    const ecloWeeks = [...new Set(ecloActs.flatMap((a) => a.ecloWeeks))].sort((a, b) => a - b);
    const hotspots = [...plan.usage.values()].filter((r) => r.capacity > 0 && r.used >= r.capacity);
    const hotLocations = [...new Set(hotspots.map((r) => r.location_id))];
    const stuck = plan.activities.filter((a) => a.alternatives === 0);
    const overCapacity = [...plan.usage.values()].filter((r) => r.excess > 0);

    const labelFor = (id: string) => plan.locations.find((l) => l.id === id)?.label ?? id;

    const queue: {
      sev: Sev;
      title: string;
      detail: string;
      to: TabId;
      tag: string;
      tagCls: string;
      age: string;
      cta: string;
    }[] = [];

    for (const c of late.slice(0, 2)) {
      const drivers = plan.activities
        .filter((a) => a.contract === c.id)
        .sort((x, y) => y.we - x.we)
        .slice(0, 1);
      queue.push({
        sev: c.priority === 1 ? "URGENT" : "HIGH",
        title: `Priority-${c.priority} contract ${c.id} overruns by ${c.overrunDays} days`,
        detail: `${c.name} · projected Week ${c.projectedWeek} against a Week ${c.deadlineWeek} deadline${
          drivers.length ? `. ${drivers[0].id} finishes last, in Week ${drivers[0].we}.` : "."
        }`,
        to: "contracts",
        tag: `${c.id} · P${c.priority}`,
        tagCls: c.priority === 1 ? "pill p-p1" : "pill p-p2",
        age: `scenario ${plan.scenario}`,
        cta: "Open contract",
      });
    }

    const worst = [...hotspots].sort(
      (a, b) => b.used / b.capacity - a.used / a.capacity || b.used - a.used,
    )[0];
    if (worst)
      queue.push({
        sev: "HIGH",
        title: `${labelFor(worst.location_id)} runs at ${Math.round((worst.used / worst.capacity) * 100)}% in Week ${worst.week}`,
        detail: `${worst.used} of ${worst.capacity} possessions used. Additional demand needs a solver-checked capacity or timing change.`,
        to: "schedule",
        tag: `${worst.used}/${worst.capacity}`,
        tagCls: worst.excess > 0 ? "pill p-crit" : "pill p-warn",
        age: `Week ${worst.week}`,
        cta: "Open schedule",
      });

    if (stuck.length)
      queue.push({
        sev: "MEDIUM",
        title: `${stuck.length} activities have no alternative week`,
        detail: `${stuck
          .slice(0, 4)
          .map((a) => a.id)
          .join(", ")}${stuck.length > 4 ? "…" : ""} — every other week in the horizon is already full on their route, so a lost night cannot be absorbed.`,
        to: "risk",
        tag: `${stuck.length} pinned`,
        tagCls: "pill p-info",
        age: "from capacity",
        cta: "Open risk register",
      });

    if (ecloActs.length)
      queue.push({
        sev: "ACTIVE",
        title: `${soft.eclo_nights_total} ECLO nights booked across ${ecloActs.length} activities`,
        detail: `${ecloActs.map((a) => a.id).join(", ")} — weeks ${ecloWeeks.join(", ")}. Each one curtails passenger service and needs notice.`,
        to: "schedule",
        tag: `${soft.eclo_nights_total} nights`,
        tagCls: "pill p-eclo",
        age: `scenario ${plan.scenario}`,
        cta: "Open schedule",
      });

    if (overCapacity.length)
      queue.push({
        sev: "URGENT",
        title: `${overCapacity.length} location-weeks exceed nominal supply`,
        detail: overCapacity
          .slice(0, 3)
          .map((r) => `${labelFor(r.location_id)} W${r.week} (+${r.excess})`)
          .join(" · "),
        to: "risk",
        tag: `+${overCapacity.reduce((n, r) => n + r.excess, 0)}`,
        tagCls: "pill p-crit",
        age: "excess access",
        cta: "Open risk register",
      });

    // The soonest week that still has work, for the "next shift" card.
    const upcoming = Math.min(...plan.activities.filter((a) => a.scheduled).map((a) => a.ws));
    const tonight = plan.activities.filter((a) => a.weeks.includes(upcoming));

    return { soft, late, atRisk, fragile, ecloActs, ecloWeeks, hotLocations, queue, upcoming, tonight };
  }, [plan]);

  const queue = model.queue.filter((q) => filter === "ALL" || q.sev === filter);
  const counts = model.queue.reduce<Record<string, number>>((acc, q) => {
    acc[q.sev] = (acc[q.sev] ?? 0) + 1;
    return acc;
  }, {});

  const kpis = [
    {
      label: "Contracts at risk",
      value: String(model.atRisk.length),
      color: model.atRisk.length ? "#c1352c" : "#176842",
      sub: model.atRisk.map((c) => c.id).join(" · ") || "none",
    },
    {
      label: "High-fragility activities",
      value: String(model.fragile.length),
      color: model.fragile.length ? "#8a5a0c" : "#176842",
      sub: model.fragile.slice(0, 5).map((a) => a.id).join(" ") || "none",
    },
    {
      label: "ECLO nights",
      value: String(model.soft.eclo_nights_total),
      color: "#5b35a8",
      sub: model.ecloWeeks.length ? `Weeks ${model.ecloWeeks[0]}–${model.ecloWeeks[model.ecloWeeks.length - 1]}` : "none booked",
    },
    {
      label: "Locations at capacity",
      value: String(model.hotLocations.length),
      color: model.hotLocations.length ? "#c1352c" : "#176842",
      sub:
        model.hotLocations
          .slice(0, 3)
          .map((id) => plan.locations.find((l) => l.id === id)?.label ?? id)
          .join(" · ") || "none",
    },
  ];

  const brief = [
    {
      head: "This plan",
      color: "#1d5fd1",
      text: `Scenario ${plan.scenario} (${SCENARIO_LABEL[plan.scenario]}) solved ${plan.solverStatus}. Objective score ${plan.validation.score}, ${plan.validation.completed_activities} of ${plan.validation.total_activities} activities scheduled at ${plan.validation.coverage_percent}% coverage.`,
    },
    {
      head: "What it costs",
      color: "#c1352c",
      text: `${model.soft.overrun_days_total} overrun days across ${model.soft.contracts_overrunning} contracts, ${model.soft.excess_access_nights_total} excess access nights and ${model.soft.eclo_nights_total} ECLO nights. Priority-weighted overrun ${model.soft.priority_weighted_score}.`,
    },
    {
      head: "Where it is tight",
      color: "#d9962b",
      text: model.hotLocations.length
        ? `${model.hotLocations.length} locations reach full capacity; ${model.fragile.length} activities score 65 or above on fragility.`
        : "No location reaches full capacity in this scenario.",
    },
    {
      head: "Checks",
      color: plan.validation.feasible ? "#1e8a5a" : "#c1352c",
      text: plan.validation.feasible
        ? `Independently re-checked: 0 hard violations, safety ${plan.validation.safety_verified ? "verified" : "unverified"}, rules ${plan.validation.rule_version}.`
        : `${plan.validation.hard_violations.length} hard violations reported by the checker — see the run report.`,
    },
  ];

  const first = weekStarting(plan.horizonStart, model.upcoming);
  const last = weekEnding(plan.horizonStart, model.upcoming);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Operations overview</h1>
          <span className="muted small">
            {plan.name} · horizon {plan.firstWeek}–{plan.lastWeek} from {plan.horizonStart}
            {plan.nowWeek ? ` · planning week ${plan.nowWeek}` : " · horizon has not started"}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <span className={plan.validation.feasible ? "pill p-ok" : "pill p-crit"} style={{ height: 24 }}>
          {plan.validation.feasible ? "Feasible" : `${plan.validation.hard_violations.length} violations`}
        </span>
        <button className="btn" onClick={() => go("schedule")}>
          Open current plan
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 7fr) minmax(0, 5fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            {kpis.map((k) => (
              <div className="kpi" key={k.label} style={{ padding: "13px 15px", gap: 3 }}>
                <span className="l">{k.label}</span>
                <span className="v" style={{ fontSize: 26, color: k.color }}>
                  {k.value}
                </span>
                <span
                  className="small muted"
                  style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={k.sub}
                >
                  {k.sub}
                </span>
              </div>
            ))}
          </div>

          <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 16px",
                borderBottom: "1px solid #e6e9ef",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span className="h2">Attention queue</span>
                <span className="small muted">What needs a decision now · ordered by operational urgency</span>
              </div>
              <div style={{ flex: 1 }} />
              <div className="seg" role="group" aria-label="Filter by urgency">
                {FILTERS.map((f) => (
                  <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                    {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            {queue.map((q, i) => (
              <a
                key={q.title + i}
                className="aq"
                href="#"
                style={{ padding: "13px 16px" }}
                onClick={(e) => {
                  e.preventDefault();
                  go(q.to);
                }}
              >
                <span className="sev" style={{ color: SEVSTYLE[q.sev][1] }}>
                  <span
                    style={{ width: 8, height: 8, borderRadius: "50%", background: SEVSTYLE[q.sev][0], flexShrink: 0 }}
                  />
                  {q.sev}
                </span>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{q.title}</span>
                  <span className="small muted">{q.detail}</span>
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}
                >
                  <span className={q.tagCls}>{q.tag}</span>
                  <span className="small muted" style={{ fontSize: 11 }}>
                    {q.age}
                  </span>
                </div>
                <span
                  style={{ color: "#1d5fd1", fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  {q.cta} ›
                </span>
              </a>
            ))}
            {!queue.length && (
              <div style={{ padding: 26, textAlign: "center" }} className="muted">
                Nothing at this urgency level.
              </div>
            )}

            <div
              style={{
                padding: "9px 16px",
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontSize: 11.5,
                color: "#5b6578",
                borderTop: "1px solid #e6e9ef",
              }}
            >
              <span>
                {FILTERS.filter((f) => f !== "ALL")
                  .map((f) => `${counts[f] ?? 0} ${f.toLowerCase()}`)
                  .join(" · ")}
              </span>
              <span style={{ flex: 1 }} />
              <a
                href="#"
                style={{ fontWeight: 500 }}
                onClick={(e) => {
                  e.preventDefault();
                  go("risk");
                }}
              >
                Full risk register
              </a>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              style={{
                padding: "13px 16px",
                borderBottom: "1px solid #e6e9ef",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span className="h2">Run summary</span>
                <span className="small muted">
                  {plan.solverStatus} · run {plan.runId.slice(0, 18)}
                </span>
              </div>
              <div style={{ flex: 1 }} />
              <span className="pill p-grey">Auto</span>
            </div>
            <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {brief.map((b) => (
                <div key={b.head} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color }} />
                    <span className="card-h">{b.head}</span>
                  </div>
                  <span style={{ fontSize: 12.5, lineHeight: 1.5, paddingLeft: 15 }}>{b.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="h2">First week of work</span>
              <div style={{ flex: 1 }} />
              <span className="small muted">
                Week {model.upcoming} · {shortDate(first)}–{shortDate(last)}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 13 }}>
              {model.tonight.slice(0, 6).map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontWeight: 600, width: 42 }}>
                    {a.id}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.loc} · {a.contract}
                  </span>
                  <span className={a.eclo ? "pill p-eclo" : a.delayed ? "pill p-warn" : "pill p-ok"}>
                    {a.eclo ? "ECLO" : a.delayed ? "Late" : "On plan"}
                  </span>
                </div>
              ))}
              {model.tonight.length > 6 && (
                <span className="small muted">+{model.tonight.length - 6} more in this week</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
