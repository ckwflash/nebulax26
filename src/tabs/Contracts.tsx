// Spec section 7 — Contracts & Activities, sourced from the loaded plan.

import { useState } from "react";
import { PPILL, RISKPILL } from "../data/style";
import type { ActivityView } from "../data/adapt";
import { usePlan } from "../state/plan";
import type { TabId } from "../shell/tabs";

function statusCls(st: string) {
  if (st === "At risk" || st === "Projected late") return "pill p-crit";
  if (st === "ECLO dependent") return "pill p-eclo";
  if (st === "Request pending") return "pill p-info";
  return "pill p-ok";
}

const weeksLabel = (a: ActivityView) => (a.ws === a.we ? `W${a.ws}` : `W${a.ws}–${a.we}`);

/** Why this activity scores what it does — every clause from real output. */
function fragWhy(a: ActivityView): string {
  const bits = [
    a.slack <= 0
      ? a.slack === 0
        ? "no deadline slack"
        : `${Math.abs(a.slack)} week(s) past its deadline`
      : `${a.slack} week(s) of slack`,
    a.alternatives === 0
      ? "no other feasible week"
      : `${a.alternatives} alternative week${a.alternatives === 1 ? "" : "s"} on capacity`,
    `${a.loc} peaks at ${Math.round(a.congestion)}%`,
  ];
  if (a.ecloNights) bits.push(`depends on ${a.ecloNights} ECLO night${a.ecloNights === 1 ? "" : "s"}`);
  if (a.co.length) bits.push(`shares its possession with ${a.co.join(" and ")}`);
  return `${a.frag} / 100 — ${bits.join("; ")}.`;
}

export function Contracts({ go }: { go: (t: TabId) => void }) {
  const plan = usePlan();
  const [tab, setTab] = useState<"c" | "a">("c");
  const [fc, setFc] = useState("");
  const [q, setQ] = useState("");
  const query = q.toLowerCase();

  const cs = plan.contracts.filter(
    (c) => !query || (c.id + c.name + c.contractor).toLowerCase().includes(query),
  );
  const as = plan.activities.filter(
    (a) => (!fc || a.contract === fc) && (!query || (a.id + a.contract + a.type + a.loc).toLowerCase().includes(query)),
  );
  const totalNights = plan.contracts.reduce((n, c) => n + c.nights, 0);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Contracts &amp; Activities</h1>
          <span className="muted small">
            {plan.contracts.length} contracts · {plan.activities.length} activities · {totalNights} required access
            nights · {plan.name}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg" role="group" aria-label="View">
          <button className={tab === "c" ? "on" : ""} onClick={() => setTab("c")}>
            Contracts
          </button>
          <button className={tab === "a" ? "on" : ""} onClick={() => setTab("a")}>
            Activities
          </button>
        </div>
        <input
          className="input"
          style={{ width: 220, height: 32 }}
          placeholder="Search ID, name or contractor"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
      </div>

      {tab === "c" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Name</th>
                <th>Nature / access</th>
                <th>Priority</th>
                <th>Activities</th>
                <th>Access nights</th>
                <th>Deadline</th>
                <th>Projected</th>
                <th>Slack</th>
                <th>Overrun</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cs.map((c) => (
                <tr key={c.id} style={c.slack <= 0 ? { background: "#fff8f7" } : undefined}>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {c.id}
                  </td>
                  <td>{c.name}</td>
                  <td className="muted">
                    {c.nature} · {c.accessType}
                  </td>
                  <td>
                    <span className={PPILL[c.priority]}>P{c.priority}</span>
                  </td>
                  <td>{c.activityCount}</td>
                  <td>{c.nights}</td>
                  <td>Week {c.deadlineWeek}</td>
                  <td>Week {c.projectedWeek}</td>
                  <td>
                    <span className={c.slack < 0 ? "pill p-crit" : c.slack === 0 ? "pill p-warn" : "pill p-ok"}>
                      {c.slack < 0 ? `${c.slack} wk` : c.slack === 0 ? "0 wk" : `+${c.slack} wk`}
                    </span>
                  </td>
                  <td>{c.overrunDays ? `${c.overrunDays} d` : "—"}</td>
                  <td>
                    <span className={statusCls(c.status)}>{c.status}</span>
                  </td>
                  <td>
                    <button
                      className="link-btn"
                      onClick={() => {
                        setTab("a");
                        setFc(c.id);
                      }}
                    >
                      Activities
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "a" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="small muted">{as.length} activities</span>
            {fc && (
              <>
                <span className="pill p-info">Contract {fc}</span>
                <button className="link-btn" onClick={() => setFc("")}>
                  Show all
                </button>
              </>
            )}
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th>Contract</th>
                  <th>Work type</th>
                  <th>Line / dir</th>
                  <th>Location</th>
                  <th>Access</th>
                  <th>Live</th>
                  <th>Nights</th>
                  <th>Scheduled</th>
                  <th>Fragility</th>
                  <th>Flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {as.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {a.id}
                    </td>
                    <td>
                      <span className={PPILL[a.priority]}>P{a.priority}</span> {a.contract}
                    </td>
                    <td>{a.type}</td>
                    <td>
                      {a.line} · {a.dir}
                    </td>
                    <td>{a.loc}</td>
                    <td>{a.access}</td>
                    <td>{a.live ? "Live" : "Non-live"}</td>
                    <td>{a.nights}</td>
                    <td>{weeksLabel(a)}</td>
                    <td>
                      <span
                        className={RISKPILL[a.risk]}
                        style={{ cursor: "help", borderBottom: "1px dotted currentColor" }}
                        title={fragWhy(a)}
                      >
                        {a.frag}
                      </span>
                    </td>
                    <td style={{ display: "flex", gap: 4 }}>
                      {a.eclo && <span className="pill p-eclo">ECLO</span>}
                      {a.delayed && <span className="pill p-warn">Late</span>}
                      {a.co.length > 0 && <span className="pill p-info">Co-share</span>}
                    </td>
                    <td>
                      <a
                        href="#"
                        style={{ fontSize: 13, fontWeight: 500 }}
                        onClick={(e) => {
                          e.preventDefault();
                          go("schedule");
                        }}
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
