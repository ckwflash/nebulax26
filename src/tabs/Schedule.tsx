// Spec section 6 — Schedule: the operational Gantt, plus why each activity sits where
// it does. Weeks, placements, co-sharing and alternatives all come from the run.

import { useMemo, useState } from "react";
import { shortDate, weekEnding, weekStarting, type ActivityView, type PlanModel } from "../data/adapt";
import { PPILL, RISKLBL, RISKPILL } from "../data/style";
import { usePlan } from "../state/plan";
import type { TabId } from "../shell/tabs";

const W = 930;

const CHIP_DEFS: [string, string][] = [
  ["EB", "Eastbound"],
  ["WB", "Westbound"],
  ["P1", "Priority 1"],
  ["P2", "Priority 2"],
  ["P3", "Priority 3"],
  ["live", "Live"],
  ["nonlive", "Non-live"],
  ["eclo", "ECLO"],
  ["risk", "At-risk"],
  ["delayed", "Delayed"],
  ["co", "Co-sharing"],
];

const GROUP_LABELS: Record<string, string> = {
  loc: "Railway location",
  contract: "Contract",
  id: "Activity",
  line: "Line",
  priority: "Priority",
};

const NIGHTS = ["Slot 1", "Slot 2", "Slot 3", "Slot 4", "Slot 5", "Slot 6", "Slot 7"];

/** Who is affected if this activity moves — derived, not authored. */
function chainFor(a: ActivityView, plan: PlanModel) {
  const contract = plan.contracts.find((c) => c.id === a.contract)!;
  const steps: { title: string; detail: string; tone: "act" | "con" | "ok"; id: string }[] = [
    {
      title: `${a.id} releases its possession`,
      detail: `Weeks ${a.weeks.join(", ")} at ${a.loc} become free.`,
      tone: "act",
      id: a.id,
    },
  ];
  for (const partner of a.co.slice(0, 2)) {
    steps.push({
      title: `${partner} loses its co-share`,
      detail: `Shares the ${a.loc} possession with ${a.id}; it would need its own access night.`,
      tone: "act",
      id: partner,
    });
  }
  for (const s of a.successors.slice(0, 2)) {
    const succ = plan.activities.find((x) => x.id === s);
    steps.push({
      title: `${s} cannot start earlier`,
      detail: succ ? `Follows ${a.id} by precedence; currently Week ${succ.ws}.` : `Follows ${a.id} by precedence.`,
      tone: "act",
      id: s,
    });
  }
  steps.push({
    title:
      contract.slack <= 0
        ? `${contract.id} has no slack to absorb it`
        : `${contract.id} can absorb a ${contract.slack}-week move`,
    detail: `Projected Week ${contract.projectedWeek} against a Week ${contract.deadlineWeek} deadline.`,
    tone: contract.slack <= 0 ? "con" : "ok",
    id: "",
  });
  return steps;
}

export function Schedule({ go }: { go: (t: TabId) => void }) {
  const plan = usePlan();
  const [zoom, setZoom] = useState<1 | 2 | 3>(1);
  const [groupBy, setGroupBy] = useState("loc");
  const [sel, setSel] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [fc, setFc] = useState("");
  const [ft, setFt] = useState("");
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [ghost, setGhost] = useState(true);
  const [chain, setChain] = useState(false);
  const [conf, setConf] = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [showCo, setShowCo] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showLoc, setShowLoc] = useState(false);

  const F = flags;
  const focusWeek = anchor ?? plan.nowWeek ?? plan.busiestWeek;

  const filtered = plan.activities.filter((a) => {
    if (F.EB && !F.WB && a.dir !== "EB") return false;
    if (F.WB && !F.EB && a.dir !== "WB") return false;
    const ps = [1, 2, 3].filter((i) => F["P" + i]);
    if (ps.length && !ps.includes(a.priority)) return false;
    if (F.live && !F.nonlive && !a.live) return false;
    if (F.nonlive && !F.live && a.live) return false;
    if (F.eclo && !a.eclo) return false;
    if (F.risk && a.risk !== "high") return false;
    if (F.delayed && !a.delayed) return false;
    if (F.co && !a.co.length) return false;
    if (fc && a.contract !== fc) return false;
    if (ft && a.type !== ft) return false;
    if (F[a.lineCode] === false) return false;
    return true;
  });

  const lineCodes = [...new Set(plan.activities.map((a) => a.lineCode))];
  const lineFilterOn = lineCodes.filter((c) => F["line:" + c]);
  const byLine = lineFilterOn.length
    ? filtered.filter((a) => lineFilterOn.includes(a.lineCode))
    : filtered;

  const [w0, w1] =
    zoom === 1
      ? [plan.firstWeek, plan.lastWeek]
      : zoom === 2
        ? [Math.max(plan.firstWeek, focusWeek - 2), Math.min(plan.lastWeek, focusWeek + 3)]
        : [1, 7];
  const n = Math.max(1, w1 - w0 + 1);
  const colW = Math.floor(W / n);

  const acts =
    zoom === 3
      ? byLine.filter((a) => a.weeks.includes(focusWeek))
      : byLine.filter((a) => a.we >= w0 && a.ws <= w1);

  const groups: Record<string, ActivityView[]> = {};
  acts.forEach((a) => {
    const k =
      groupBy === "priority"
        ? `Priority ${a.priority}`
        : groupBy === "loc"
          ? a.loc
          : groupBy === "contract"
            ? a.contract
            : groupBy === "line"
              ? a.line
              : a.id;
    (groups[k] = groups[k] || []).push(a);
  });
  const order = Object.keys(groups).sort();

  const selA = sel ? plan.activities.find((a) => a.id === sel) : undefined;
  const chainOn = chain && !!selA;
  const chainSteps = useMemo(() => (selA ? chainFor(selA, plan) : []), [selA, plan]);
  const chainIds = chainSteps.map((s) => s.id).filter(Boolean);

  const colOf = (a: ActivityView) => {
    if (conf) return a.confidence.color;
    return a.risk === "high"
      ? "#c1352c"
      : a.delayed
        ? "#b7791f"
        : a.eclo
          ? "#6b46c1"
          : a.priority === 1
            ? "#1d5fd1"
            : a.priority === 2
              ? "#3f6fc9"
              : "#7f9ad6";
  };

  const pick = (id: string) => {
    setSel(id);
    setShowConf(false);
    setShowCo(false);
    setShowInfo(false);
    setShowLoc(false);
  };

  const hotLabels = new Set(
    plan.locations.filter((l) => l.peak >= 90).map((l) => l.label),
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Schedule</h1>
          <span className="muted small">
            Scenario {plan.scenario} · {plan.solverStatus} · {acts.length} of {plan.activities.length} activities in
            view
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg" role="group" aria-label="Zoom">
          <button className={zoom === 1 ? "on" : ""} onClick={() => setZoom(1)}>
            Multi-week
          </button>
          <button className={zoom === 2 ? "on" : ""} onClick={() => setZoom(2)}>
            Weekly
          </button>
          <button className={zoom === 3 ? "on" : ""} onClick={() => setZoom(3)}>
            Night detail · W{focusWeek}
          </button>
        </div>
        {zoom !== 1 && (
          <select
            className="input"
            style={{ width: 120, height: 32 }}
            value={String(focusWeek)}
            onChange={(e) => setAnchor(Number(e.target.value))}
            aria-label="Focus week"
          >
            {plan.weeks.map((w) => (
              <option key={w} value={String(w)}>
                Week {w}
              </option>
            ))}
          </select>
        )}
        <label className="small muted" htmlFor="grp">
          Group by
        </label>
        <select
          id="grp"
          className="input"
          style={{ width: 160, height: 32 }}
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
        >
          <option value="loc">Railway location</option>
          <option value="contract">Contract</option>
          <option value="id">Activity</option>
          <option value="line">Line</option>
          <option value="priority">Priority</option>
        </select>
      </div>

      <div
        className="card"
        style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <span className="small muted" style={{ fontWeight: 600, marginRight: 4 }}>
          Filters
        </span>
        {[...new Set(plan.activities.map((a) => a.line))].map((line) => {
          const code = plan.activities.find((a) => a.line === line)!.lineCode;
          return (
            <button
              key={code}
              className={F["line:" + code] ? "chip on" : "chip"}
              onClick={() => setFlags({ ...F, ["line:" + code]: !F["line:" + code] })}
            >
              {line}
            </button>
          );
        })}
        {CHIP_DEFS.map(([key, label]) => (
          <button
            key={key}
            className={F[key] ? "chip on" : "chip"}
            onClick={() => setFlags({ ...F, [key]: !F[key] })}
          >
            {label}
          </button>
        ))}
        <select
          className="input"
          style={{ width: 140, height: 28, fontSize: 12.5 }}
          value={fc}
          onChange={(e) => setFc(e.target.value)}
          aria-label="Contract filter"
        >
          <option value="">All contracts</option>
          {plan.contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 140, height: 28, fontSize: 12.5 }}
          value={ft}
          onChange={(e) => setFt(e.target.value)}
          aria-label="Activity type filter"
        >
          <option value="">All activity types</option>
          {plan.activityTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <button className={ghost ? "chip on" : "chip"} onClick={() => setGhost(!ghost)}>
          Ghost alternatives
        </button>
        <button className={chain ? "chip on" : "chip"} onClick={() => setChain(!chain)}>
          Show downstream impact
        </button>
        <button className={conf ? "chip on" : "chip"} onClick={() => setConf(!conf)}>
          Confidence colouring
        </button>
        <button
          className="link-btn"
          onClick={() => {
            setFlags({});
            setFc("");
            setFt("");
          }}
        >
          Clear
        </button>
      </div>

      <div
        className="card"
        style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minHeight: 0 }}
      >
        <div style={{ display: "flex", borderBottom: "1px solid #dfe3ea", background: "#f8f9fb" }}>
          <div
            style={{
              width: 210,
              flexShrink: 0,
              padding: "8px 14px",
              fontSize: 11.5,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              color: "#5b6578",
              fontWeight: 600,
              borderRight: "1px solid #dfe3ea",
            }}
          >
            {GROUP_LABELS[groupBy]}
          </div>
          <div style={{ flex: 1, position: "relative", height: 40 }}>
            {Array.from({ length: n }, (_, i) => {
              const w = w0 + i;
              const isNow = zoom !== 3 && plan.nowWeek === w;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: i * colW,
                    width: colW,
                    top: 0,
                    height: 40,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRight: "1px solid #e6e9ef",
                    ...(isNow ? { background: "#fdecea" } : {}),
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{zoom === 3 ? NIGHTS[i] : "W" + w}</span>
                  <span className="small muted" style={{ fontSize: 10.5 }}>
                    {zoom === 3 ? "" : isNow ? "current" : shortDate(weekStarting(plan.horizonStart, w))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
          {order.map((k) => {
            const list = groups[k];
            const touched = chainOn && list.some((a) => chainIds.includes(a.id));
            const hot = groupBy === "loc" && hotLabels.has(k);
            const sub = groupBy === "id" ? list[0].loc : `${list.length} act.`;
            return (
              <div
                key={k}
                style={{
                  display: "flex",
                  borderBottom: "1px solid #eceff4",
                  height: 44,
                  ...(touched ? { background: "#fffaf9" } : {}),
                }}
              >
                <div
                  style={{
                    width: 210,
                    flexShrink: 0,
                    padding: "0 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    borderRight: "1px solid #e6e9ef",
                    fontSize: 13,
                    fontWeight: 600,
                    background: "#fff",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: hot ? "#c1352c" : "#1e8a5a",
                    }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={k}>
                    {k}
                  </span>
                  <span className="small muted" style={{ fontWeight: 400 }}>
                    {sub}
                  </span>
                </div>
                <div
                  style={{
                    flex: 1,
                    position: "relative",
                    backgroundImage: "linear-gradient(90deg,#eceff4 1px,transparent 1px)",
                    backgroundSize: `${colW}px 100%`,
                  }}
                >
                  {zoom !== 3 && plan.nowWeek !== null && plan.nowWeek >= w0 && plan.nowWeek <= w1 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: (plan.nowWeek - w0) * colW,
                        width: 2,
                        background: "#c1352c",
                        opacity: 0.6,
                        zIndex: 1,
                      }}
                    />
                  )}

                  {ghost &&
                    zoom !== 3 &&
                    selA &&
                    list.some((a) => a.id === selA.id) &&
                    [
                      ...selA.altWeeks.slice(0, 6).map((w) => ({ w, blocked: false })),
                      ...selA.blockedWeeks.slice(0, 6).map((w) => ({ w, blocked: true })),
                    ]
                      .filter((g) => g.w >= w0 && g.w <= w1)
                      .map((g) => {
                        const span = selA.we - selA.ws + 1;
                        return (
                          <button
                            key={(g.blocked ? "b" : "a") + g.w}
                            className={"ghost " + (g.blocked ? "g-block" : "g-feas")}
                            style={{ left: (g.w - w0) * colW + 2, width: span * colW - 4 }}
                            title={
                              g.blocked
                                ? `Week ${g.w} — blocked: a location on ${selA.id}'s route is already at capacity.`
                                : `Week ${g.w} — capacity is free on every location ${selA.id} occupies.`
                            }
                            onClick={() => setSel(selA.id)}
                          >
                            <span>{g.blocked ? `✕ W${g.w} full` : `○ W${g.w} free`}</span>
                          </button>
                        );
                      })}

                  {list.flatMap((a) => {
                    const inChain = chainOn && chainIds.includes(a.id) && a.id !== selA!.id;
                    const segs: [number, number][] = [];
                    if (zoom === 3) {
                      const slot = a.slots[focusWeek];
                      if (slot) segs.push([slot - 1, slot - 1]);
                    } else {
                      segs.push([Math.max(a.ws, w0) - w0, Math.min(a.we, w1) - w0]);
                    }
                    return segs.map((sg, si) => (
                      <button
                        key={a.id + ":" + si}
                        className={
                          "gblock" + (sel === a.id ? " sel" : "") + (inChain ? " chain-pulse" : "")
                        }
                        style={{
                          left: sg[0] * colW + 2,
                          width: (sg[1] - sg[0] + 1) * colW - 4,
                          background: colOf(a),
                          ...(inChain ? { outline: "2px dashed #c1352c", outlineOffset: 1 } : {}),
                        }}
                        title={`${a.id} · ${a.type} · ${a.loc} · fragility ${a.frag} · confidence ${a.confidence.level}`}
                        onClick={() => pick(a.id)}
                      >
                        <span className="mono">{a.id}</span>
                        <span className="tag">P{a.priority}</span>
                        <span style={{ opacity: 0.85, fontWeight: 500 }}>{a.contract}</span>
                        {a.eclo && (
                          <span className="tag" style={{ background: "#fff", color: "#5b35a8" }}>
                            ECLO
                          </span>
                        )}
                        {a.co.length > 0 && <span className="tag">CO-SHARE</span>}
                        {a.risk === "high" && (
                          <span className="tag" style={{ background: "#fff", color: "#a12a22" }}>
                            RISK
                          </span>
                        )}
                        {a.delayed && (
                          <span className="tag" style={{ background: "#fff", color: "#8a5a0c" }}>
                            LATE
                          </span>
                        )}
                        {inChain && (
                          <span className="tag" style={{ background: "#fff", color: "#a12a22" }}>
                            AFFECTED
                          </span>
                        )}
                      </button>
                    ));
                  })}
                </div>
              </div>
            );
          })}
          {!order.length && (
            <div style={{ padding: 40, textAlign: "center", color: "#5b6578" }}>
              No activities match the current filters.
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: 14,
            padding: "8px 14px",
            borderTop: "1px solid #e6e9ef",
            fontSize: 11.5,
            color: "#5b6578",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {(conf
            ? ([
                ["#1e8a5a", "Confidence HIGH"],
                ["#b7791f", "Confidence MEDIUM"],
                ["#c1352c", "Confidence LOW"],
              ] as [string, string][])
            : ([
                ["#1d5fd1", "Priority 1"],
                ["#3f6fc9", "Priority 2"],
                ["#7f9ad6", "Priority 3"],
                ["#6b46c1", "ECLO access"],
                ["#c1352c", "High risk"],
                ["#b7791f", "Delayed"],
              ] as [string, string][])
          ).map(([c, l]) => (
            <span key={l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: c }} />
              {l}
            </span>
          ))}
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, border: "1.5px dashed #3f8f66" }} />
            Capacity free
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, border: "1.5px dashed #c98b86" }} />
            Location full
          </span>
          <span style={{ flex: 1 }} />
          <span>
            {selA
              ? `Ghost blocks show where ${selA.id} has capacity-based suggestions; solver validation is required`
              : "Click an activity for its drivers, conflicts and alternatives"}
          </span>
        </div>
      </div>

      {chainOn && selA && (
        <div
          className="card"
          style={{
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            border: "1px solid #f2c4c0",
            background: "#fffaf9",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="h2">
              Downstream impact — if <span className="mono">{selA.id}</span> moves
            </span>
            <span className="pill p-grey">Derived from co-sharing, precedence and contract slack</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm btn-primary" onClick={() => go("scenarios")}>
              Simulate this move
            </button>
            <button className="btn btn-sm" onClick={() => setChain(false)}>
              Hide
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
            {chainSteps.map((st, i) => (
              <div key={i} style={{ display: "flex", alignItems: "stretch", flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    padding: "10px 11px",
                    borderRadius: 7,
                    border: `1px solid ${st.tone === "ok" ? "#bfe3cf" : st.tone === "con" ? "#f2c4c0" : "#f1dcae"}`,
                    background: st.tone === "ok" ? "#f4fbf7" : st.tone === "con" ? "#fdf4f3" : "#fffaf0",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: st.tone === "ok" ? "#1e8a5a" : st.tone === "con" ? "#c1352c" : "#b7791f",
                      }}
                    />
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{st.title}</span>
                  </div>
                  <span className="small muted" style={{ lineHeight: 1.4 }}>
                    {st.detail}
                  </span>
                </div>
                {i < chainSteps.length - 1 && (
                  <div
                    style={{ display: "flex", alignItems: "center", padding: "0 6px", color: "#a12a22", flexShrink: 0 }}
                  >
                    <svg width="20" height="14" viewBox="0 0 20 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1 7h16M13 3l4 4-4 4" />
                    </svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {selA && (
        <DetailPanel
          a={selA}
          plan={plan}
          showInfo={showInfo}
          showLoc={showLoc}
          showConf={showConf}
          showCo={showCo}
          onToggleInfo={() => setShowInfo(!showInfo)}
          onToggleLoc={() => setShowLoc(!showLoc)}
          onToggleConf={() => setShowConf(!showConf)}
          onToggleCo={() => setShowCo(!showCo)}
          onClose={() => {
            setSel(null);
            setChain(false);
          }}
        />
      )}
    </>
  );
}

function DetailPanel({
  a,
  plan,
  showInfo,
  showLoc,
  showConf,
  showCo,
  onToggleInfo,
  onToggleLoc,
  onToggleConf,
  onToggleCo,
  onClose,
}: {
  a: ActivityView;
  plan: PlanModel;
  showInfo: boolean;
  showLoc: boolean;
  showConf: boolean;
  showCo: boolean;
  onToggleInfo: () => void;
  onToggleLoc: () => void;
  onToggleConf: () => void;
  onToggleCo: () => void;
  onClose: () => void;
}) {
  const c = plan.contracts.find((x) => x.id === a.contract)!;
  const cf = a.confidence;
  const conflicts = plan.activities.filter(
    (x) =>
      x.id !== a.id &&
      !a.co.includes(x.id) &&
      x.route.some((loc) => a.route.includes(loc)) &&
      x.we >= a.ws - 1 &&
      x.ws <= a.we + 1,
  );
  const coList = a.co.map((id) => plan.activities.find((x) => x.id === id)).filter(Boolean) as ActivityView[];
  const accessLbl =
    a.access === "PM" ? "Sole possession" : a.access === "PC" ? "Possession master, co-shareable" : "Co-worker";
  const bg = cf.level === "HIGH" ? "#f4fbf7" : cf.level === "MEDIUM" ? "#fffaf0" : "#fdf4f3";
  const border = cf.level === "HIGH" ? "#bfe3cf" : cf.level === "MEDIUM" ? "#f1dcae" : "#f2c4c0";

  // Utilisation on this activity's own route weeks — the evidence behind its placement.
  const hotRows = a.route
    .flatMap((loc) => a.weeks.map((w) => plan.usage.get(`${loc}|${w}`)))
    .filter(Boolean)
    .sort((x, y) => y!.used / y!.capacity - x!.used / x!.capacity)
    .slice(0, 4) as NonNullable<ReturnType<PlanModel["usage"]["get"]>>[];

  return (
    <div className="panel">
      <div className="panel-h">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
              {a.id}
            </span>
            <span className={PPILL[a.priority]}>Priority {a.priority}</span>
            <span className={RISKPILL[a.risk]}>{RISKLBL[a.risk]}</span>
            {a.eclo && <span className="pill p-eclo">ECLO ×{a.ecloNights}</span>}
          </div>
          <span className="small muted">
            {a.type} · {a.contract} {c.name}
          </span>
        </div>
        <button className="x-btn" onClick={onClose} aria-label="Close details">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="panel-b">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "12px 14px",
            borderRadius: 8,
            background: bg,
            border: `1px solid ${border}`,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, flexShrink: 0 }}>
            <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1, color: cf.color }}>{cf.level}</span>
            <span className="small muted">{cf.score} / 100</span>
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: border }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <span className="card-h">Operational confidence · heuristic</span>
            {cf.reasons.map((r) => (
              <span key={r} style={{ fontSize: 12.5, display: "flex", gap: 6 }}>
                <span className="muted">·</span>
                <span>{r}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="divider" />
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <span className="card-h">Why it sits here</span>
          <div className="kv">
            <div>
              <span>Earliest permitted week</span>
              <span>
                Week {a.startWeek} (planned start {a.plannedStart})
              </span>
            </div>
            <div>
              <span>Scheduled</span>
              <span>
                Weeks {a.weeks.join(", ")} · {a.scheduledNights} of {a.nights} nights
              </span>
            </div>
            <div>
              <span>Predecessor</span>
              <span>{a.predecessor || "none"}</span>
            </div>
            <div>
              <span>Successors</span>
              <span>{a.successors.join(", ") || "none"}</span>
            </div>
            <div>
              <span>Weeks with capacity free</span>
              <span>{a.altWeeks.length ? a.altWeeks.slice(0, 8).join(", ") : "none"}</span>
            </div>
            <div>
              <span>Weeks blocked by capacity</span>
              <span>{a.blockedWeeks.length ? a.blockedWeeks.slice(0, 8).join(", ") : "none"}</span>
            </div>
          </div>
          {hotRows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="card-h">Tightest locations it occupies</span>
              {hotRows.map((r) => (
                <div key={r.evidence_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{ flex: 1 }}>
                    {plan.locations.find((l) => l.id === r.location_id)?.label ?? r.location_id} · W{r.week}
                  </span>
                  <div className="bar" style={{ width: 90 }}>
                    <div
                      style={{
                        width: `${Math.min(100, (r.used / r.capacity) * 100)}%`,
                        background: r.used >= r.capacity ? "#c1352c" : "#b7791f",
                      }}
                    />
                  </div>
                  <span style={{ width: 52, textAlign: "right", fontWeight: 600 }}>
                    {r.used}/{r.capacity}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="divider" />
        <button className="disc" onClick={onToggleInfo} aria-label="Activity information">
          <span className="card-h">Activity information</span>
          <span style={{ flex: 1 }} />
          <span
            style={{ fontSize: 17, color: "#5b6578", display: "inline-block", transform: `rotate(${showInfo ? 90 : 0}deg)` }}
          >
            ›
          </span>
        </button>
        {showInfo && (
          <div className="kv">
            <div>
              <span>Work type</span>
              <span>{a.type}</span>
            </div>
            <div>
              <span>Nature of work</span>
              <span>{a.nature}</span>
            </div>
            <div>
              <span>Access type</span>
              <span>
                {a.access} — {accessLbl}
              </span>
            </div>
            <div>
              <span>Required access nights</span>
              <span>{a.nights}</span>
            </div>
            <div>
              <span>Line / bound</span>
              <span>
                {a.line} · {a.dir}
              </span>
            </div>
            <div>
              <span>Live / non-live</span>
              <span>{a.live ? "Live (750V, mirrors opposite bound)" : "Non-live"}</span>
            </div>
            <div>
              <span>First night</span>
              <span>{shortDate(weekStarting(plan.horizonStart, a.ws))} · 23:30</span>
            </div>
            <div>
              <span>Last night</span>
              <span>{shortDate(weekEnding(plan.horizonStart, a.we))} · 04:30</span>
            </div>
            <div>
              <span>Contract status</span>
              <span className={c.overrunDays ? "pill p-warn" : a.risk === "high" ? "pill p-crit" : "pill p-ok"}>
                {c.overrunDays ? `Projected late (+${c.overrunDays} days)` : a.risk === "high" ? "Scheduled · at risk" : "Scheduled"}
              </span>
            </div>
          </div>
        )}

        <div className="divider" />
        <button className="disc" onClick={onToggleLoc} aria-label="Location and constraints">
          <span className="card-h">Location &amp; constraints</span>
          <span style={{ flex: 1 }} />
          <span
            style={{ fontSize: 17, color: "#5b6578", display: "inline-block", transform: `rotate(${showLoc ? 90 : 0}deg)` }}
          >
            ›
          </span>
        </button>
        {showLoc && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span className="card-h">Route ({a.route.length} locations)</span>
              {a.route.slice(0, 8).map((loc) => (
                <div key={loc} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: loc.startsWith("SEC") ? "#1d5fd1" : "#8a93a6",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>{plan.locations.find((l) => l.id === loc)?.label ?? loc}</span>
                  <span className="small muted">{loc.startsWith("SEC") ? "possession" : "access point"}</span>
                </div>
              ))}
              {a.route.length > 8 && <span className="small muted">+{a.route.length - 8} more</span>}
            </div>
            <div className="kv" style={{ marginTop: 6 }}>
              <div>
                <span>Protected footprint</span>
                <span>{a.protectedFootprint.length} locations (buffers included)</span>
              </div>
              <div>
                <span>Contract weekly access limit</span>
                <span>{c.weeklyCap} nights / week</span>
              </div>
              <div>
                <span>Workfront limit</span>
                <span>{c.workfronts} concurrent</span>
              </div>
              <div>
                <span>Peak utilisation on route</span>
                <span>{Math.round(a.congestion)}%</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              <button className="btn btn-sm" onClick={onToggleConf}>
                Show conflicts
              </button>
              <button className="btn btn-sm" onClick={onToggleCo}>
                Show co-sharing activities
              </button>
            </div>
            {showConf && (
              <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Shares route locations in nearby weeks</span>
                {conflicts.slice(0, 8).map((x) => (
                  <div key={x.id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>
                      <span className="mono">{x.id}</span> · {x.contract} · {x.loc}
                    </span>
                    <span className="muted">W{x.ws === x.we ? x.ws : `${x.ws}–${x.we}`}</span>
                  </div>
                ))}
                {!conflicts.length && <span className="muted">No other activity shares its route nearby.</span>}
              </div>
            )}
            {showCo && (
              <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Co-sharing group</span>
                {coList.map((x) => (
                  <div key={x.id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>
                      <span className="mono">{x.id}</span> · {x.contract} · {x.type}
                    </span>
                    <span className="muted">W{x.ws === x.we ? x.ws : `${x.ws}–${x.we}`}</span>
                  </div>
                ))}
                {!coList.length && <span className="muted">This activity does not share a possession.</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
