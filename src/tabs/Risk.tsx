// Spec section 8 — Risk & Resilience. Fragility, its drivers and the heatmap are all
// computed from the run; see data/adapt.ts for the formula.

import { useMemo, useState } from "react";
import type { ActivityView } from "../data/adapt";
import { LVL_PILL, PPILL, RISKCOL, RISKLBL, RISKPILL } from "../data/style";
import { usePlan } from "../state/plan";
import type { TabId } from "../shell/tabs";

const HEAT_LEGEND: [string, string][] = [
  ["#cfe6d8", "Fine — a lost night can be absorbed"],
  ["#edc97f", "Watch — limited room"],
  ["#e2836a", "Fragile — one option at most"],
  ["#c1352c", "Critical — nowhere to move"],
  ["#f2f4f7", "No work scheduled"],
];

function heatColour(v: number) {
  if (v === 0) return "#f2f4f7";
  if (v >= 85) return "#c1352c";
  if (v >= 65) return "#e2836a";
  if (v >= 45) return "#edc97f";
  return "#cfe6d8";
}

export function Risk({ go }: { go: (t: TabId) => void }) {
  const plan = usePlan();
  const [more, setMore] = useState(false);

  const sorted = useMemo(() => [...plan.activities].sort((x, y) => y.frag - x.frag), [plan]);
  const [sel, setSel] = useState<string>(sorted[0]?.id ?? "");
  const a = plan.activities.find((x) => x.id === sel) ?? sorted[0];

  const model = useMemo(() => {
    // Rows: locations that actually carry work, busiest first, capped so the grid fits.
    const carrying = new Map<string, ActivityView[]>();
    for (const act of plan.activities)
      for (const loc of act.route) {
        const list = carrying.get(loc) ?? [];
        if (!list.includes(act)) list.push(act);
        carrying.set(loc, list);
      }
    const rows = plan.locations
      .filter((l) => carrying.has(l.id))
      .sort((x, y) => y.peak - x.peak)
      .slice(0, 12);

    const meanFrag = plan.activities.reduce((n, x) => n + x.frag, 0) / Math.max(1, plan.activities.length);
    const exposed = plan.activities.filter((x) => x.alternatives === 0 || x.slack <= 0);
    const zeroSlack = plan.activities.filter((x) => x.slack <= 0);
    const fewAlts = plan.activities.filter((x) => x.alternatives <= 1);

    const fragileLocs = [...new Set(sorted.filter((x) => x.frag >= 65).map((x) => x.loc))].slice(0, 3);
    const fragileWeeks = [...new Set(sorted.filter((x) => x.frag >= 65).flatMap((x) => x.weeks))].sort(
      (p, q) => p - q,
    );
    const ecloLocs = [...new Set(plan.activities.filter((x) => x.eclo).map((x) => x.loc))];

    return {
      carrying,
      rows,
      resilience: Math.round(100 - meanFrag),
      exposedPct: Math.round((100 * exposed.length) / Math.max(1, plan.activities.length)),
      zeroSlack,
      fewAlts,
      fragileLocs,
      fragileWeeks,
      ecloLocs,
    };
  }, [plan, sorted]);

  const cellW = Math.max(16, Math.min(42, Math.floor(900 / plan.weeks.length)));
  const list = sorted.slice(0, more ? 12 : 4);

  const cell = (locId: string, w: number) => {
    const acts = (model.carrying.get(locId) ?? []).filter((x) => x.weeks.includes(w));
    if (!acts.length) return { v: 0, label: "no work scheduled", ids: [] as string[] };
    const mx = Math.max(...acts.map((x) => x.frag));
    const lbl =
      mx >= 85
        ? "critical — no way to move it"
        : mx >= 65
          ? "fragile — one option at most"
          : mx >= 45
            ? "watch — limited room"
            : "fine — can absorb a lost night";
    return { v: mx, label: `${lbl} (${acts.map((x) => x.id).join(", ")})`, ids: acts.map((x) => x.id) };
  };

  const concentration = [
    {
      head: "Fragile locations",
      value: model.fragileLocs.join(" · ") || "none",
      note: "carry the highest-fragility activities",
    },
    {
      head: "Fragile weeks",
      value: model.fragileWeeks.length
        ? `Weeks ${model.fragileWeeks[0]}–${model.fragileWeeks[model.fragileWeeks.length - 1]}`
        : "none",
      note: "where the fragile work falls",
    },
    {
      head: "Zero-slack contracts",
      value: [...new Set(model.zeroSlack.map((x) => x.contract))].join(" · ") || "none",
      note: `${model.zeroSlack.length} activities with no contract slack`,
    },
    {
      head: "ECLO-dependent area",
      value: model.ecloLocs.join(" · ") || "none booked",
      note: `${plan.validation.soft_scores.eclo_nights_total} nights in this scenario`,
    },
  ];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Risk &amp; Resilience</h1>
          <span className="muted small">
            Fragility intelligence · how much of scenario {plan.scenario} survives losing a single access night · every
            score shows its drivers
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => go("scenarios")}>
          Stress test the schedule
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12 }}>
        <div className="kpi" style={{ gridColumn: "1 / span 2", flexDirection: "row", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: "50%",
              background: `conic-gradient(#d9962b 0 ${model.resilience}%,#e6e9ef ${model.resilience}% 100%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 19,
                fontWeight: 600,
              }}
            >
              {model.resilience}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="l">Overall resilience score</span>
            <span style={{ fontWeight: 600 }}>
              {model.resilience >= 70 ? "Strong" : model.resilience >= 50 ? "Moderate" : "Weak"}
            </span>
            <span className="small muted">
              {model.exposedPct}% of activities have no slack or no alternative week
            </span>
          </div>
        </div>
        <div className="kpi">
          <span className="l">High-risk activities</span>
          <span className="v" style={{ color: "#c1352c" }}>
            {plan.activities.filter((x) => x.frag >= 65).length}
          </span>
          <span className="small muted">fragility ≥ 65</span>
        </div>
        <div className="kpi">
          <span className="l">Medium-risk</span>
          <span className="v" style={{ color: "#8a5a0c" }}>
            {plan.activities.filter((x) => x.frag >= 40 && x.frag < 65).length}
          </span>
          <span className="small muted">fragility 40–64</span>
        </div>
        <div className="kpi">
          <span className="l">Low-risk</span>
          <span className="v" style={{ color: "#176842" }}>
            {plan.activities.filter((x) => x.frag < 40).length}
          </span>
          <span className="small muted">fragility &lt; 40</span>
        </div>
        <div className="kpi">
          <span className="l">Zero-slack activities</span>
          <span className="v">{model.zeroSlack.length}</span>
          <span className="small muted" title={model.zeroSlack.map((x) => x.id).join(" ")}>
            {model.zeroSlack.slice(0, 3).map((x) => x.id).join(" · ") || "none"}
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="h2">Where the schedule is most vulnerable</span>
          <span className="small muted">
            One square per location, per week — the {model.rows.length} busiest locations of {plan.locations.length}.
            Darker means harder to move if a night is lost. Click a square to see the activity behind it.
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 3, overflowX: "auto" }}>
          <div style={{ display: "flex", gap: 3, paddingLeft: 150 }}>
            {plan.weeks.map((w) => (
              <span
                key={w}
                style={{
                  width: cellW,
                  textAlign: "center",
                  fontSize: 10,
                  color: plan.nowWeek === w ? "#a12a22" : "#5b6578",
                  fontWeight: plan.nowWeek === w ? 700 : 500,
                }}
              >
                {w}
              </span>
            ))}
            <span style={{ width: 56, textAlign: "center", fontSize: 10, color: "#5b6578", fontWeight: 600 }}>
              worst
            </span>
          </div>

          {model.rows.map((loc) => {
            let worst = 0;
            const cells = plan.weeks.map((w) => {
              const m = cell(loc.id, w);
              worst = Math.max(worst, m.v);
              return { w, ...m };
            });
            return (
              <div key={loc.id} style={{ display: "flex", gap: 3, alignItems: "center" }}>
                <div style={{ width: 150, display: "flex", alignItems: "center", gap: 6, paddingRight: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: loc.peak >= 100 ? "#c1352c" : loc.peak >= 90 ? "#d9962b" : "#1e8a5a",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={`${loc.label} · peak ${Math.round(loc.peak)}% · capacity ${loc.capacity}`}
                  >
                    {loc.label}
                  </span>
                </div>
                {cells.map((cl) => (
                  <button
                    key={cl.w}
                    title={`${loc.label} · Week ${cl.w} — ${cl.label}`}
                    aria-label={`${loc.label} · Week ${cl.w} — ${cl.label}`}
                    onClick={() => cl.ids.length && setSel(cl.ids[0])}
                    style={{
                      width: cellW,
                      height: 24,
                      borderRadius: 4,
                      border: 0,
                      padding: 0,
                      cursor: cl.ids.length ? "pointer" : "default",
                      background: heatColour(cl.v),
                    }}
                  />
                ))}
                <span
                  className={
                    worst >= 85 ? "pill p-crit" : worst >= 65 ? "pill p-warn" : worst >= 45 ? "pill p-info" : "pill p-ok"
                  }
                  style={{ width: 56, justifyContent: "center" }}
                >
                  {worst === 0 ? "—" : String(worst)}
                </span>
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 11.5,
            color: "#5b6578",
            flexWrap: "wrap",
            borderTop: "1px solid #e6e9ef",
            paddingTop: 10,
          }}
        >
          {HEAT_LEGEND.map(([col, label]) => (
            <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 14, borderRadius: 3, background: col, flexShrink: 0 }} />
              {label}
            </span>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
          {concentration.map((x) => (
            <div
              key={x.head}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "11px 12px",
                border: "1px solid #e6e9ef",
                borderRadius: 7,
                background: "#fbfcfd",
              }}
            >
              <span className="card-h">{x.head}</span>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{x.value}</span>
              <span className="small muted">{x.note}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 4fr) minmax(0, 7fr)", gap: 16, alignItems: "start" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid #e6e9ef",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span className="h2">Activities by fragility</span>
              <span className="small muted">click to explain</span>
            </div>
            {list.map((x) => (
              <button key={x.id} className={"row-btn" + (sel === x.id ? " sel" : "")} onClick={() => setSel(x.id)}>
                <span className="mono" style={{ fontWeight: 600, width: 48 }}>
                  {x.id}
                </span>
                <span className={PPILL[x.priority]}>P{x.priority}</span>
                <span
                  style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {x.contract} · {x.loc}
                </span>
                <div className="bar" style={{ width: 76 }}>
                  <div style={{ width: `${x.frag}%`, background: RISKCOL[x.risk] }} />
                </div>
                <span style={{ width: 30, textAlign: "right", fontWeight: 600 }}>{x.frag}</span>
              </button>
            ))}
            <button
              className="disc"
              style={{ border: 0, borderRadius: 0, background: "#fff", justifyContent: "center" }}
              onClick={() => setMore(!more)}
            >
              <span style={{ fontWeight: 600, fontSize: 12.5, color: "#1d5fd1" }}>
                {more ? "Show fewer" : "Show 8 more activities"}
              </span>
              <span
                style={{
                  fontSize: 16,
                  color: "#1d5fd1",
                  display: "inline-block",
                  transform: `rotate(${more ? -90 : 90}deg)`,
                }}
              >
                ›
              </span>
            </button>
          </div>

          <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
            <span className="card-h">Few alternative weeks (≤1)</span>
            <span style={{ fontSize: 13 }}>
              {model.fewAlts.slice(0, 8).map((x) => x.id).join(" · ") || "none"}
            </span>
            <span className="small muted">any lost night on these is likely to delay the contract</span>
          </div>
        </div>

        {a && (
          <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
                {a.id}
              </span>
              <span className={PPILL[a.priority]}>Priority {a.priority}</span>
              <span className={RISKPILL[a.risk]}>{RISKLBL[a.risk]}</span>
              <span className={a.confidence.cls}>Confidence {a.confidence.level}</span>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span style={{ fontSize: 24, fontWeight: 600, lineHeight: 1 }}>
                  {a.frag}{" "}
                  <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                    / 100
                  </span>
                </span>
                <span className="small muted">Fragility score</span>
              </div>
            </div>
            <span className="small muted">
              {a.type} · Contract {a.contract} · {a.loc} · Weeks {a.weeks.join(", ")}
            </span>

            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="card-h">What drives this score</span>
                <div style={{ flex: 1, height: 1, background: "#e6e9ef" }} />
                <span className="small muted">five drivers, each read from the run</span>
              </div>
              {a.fragParts.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "186px 1fr 104px 68px",
                    gap: 12,
                    alignItems: "center",
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="bar" style={{ flex: 1 }}>
                      <div style={{ width: `${p.bar}%`, background: RISKCOL[p.level] }} />
                    </div>
                    <span style={{ width: 74, fontWeight: 600 }}>{p.value}</span>
                  </div>
                  <span className={LVL_PILL[p.level][0]}>{LVL_PILL[p.level][1]}</span>
                  <span className="small muted" style={{ textAlign: "right" }}>
                    +{p.points} pts
                  </span>
                </div>
              ))}
            </div>

            <div className="divider" />
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: "9px 14px", alignItems: "start" }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", color: "#1a4fb0", paddingTop: 2 }}>
                WHAT
              </span>
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                {a.id} runs in {a.weeks.length === 1 ? `Week ${a.ws}` : `Weeks ${a.ws}–${a.we}`} at {a.loc} for
                contract {a.contract}, using {a.scheduledNights} of its {a.nights} required nights
                {a.ecloNights ? ` including ${a.ecloNights} ECLO` : ""}.
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", color: "#a12a22", paddingTop: 2 }}>
                WHY
              </span>
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                {a.slack <= 0
                  ? `${a.contract} has no slack left`
                  : `${a.contract} holds ${a.slack} week(s) of slack`}
                , its route peaks at {Math.round(a.congestion)}% utilisation, and{" "}
                {a.alternatives === 0
                  ? "no other week in the horizon has capacity free on every location it occupies"
                  : `${a.alternatives} other week(s) have capacity free on its whole route`}
                .
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
