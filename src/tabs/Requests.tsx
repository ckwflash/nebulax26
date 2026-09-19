// Spec section 12 — Contractor Requests. A request takes one unit of a location's
// capacity in the weeks asked for; the planning service prices it (and the two nearest
// windows with room) as warm-started what-ifs against the approved plan.

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AccessRequest, RequestAssessment, RequestOption, RequestStatus } from "../api/types";
import { PPILL } from "../data/style";
import { usePlan, usePlanState } from "../state/plan";
import type { TabId } from "../shell/tabs";

const KINDS = ["Additional access night", "Extended possession", "Earlier start"];
const BUDGETS = [20, 30, 60];

const STATUS_PILL: Record<RequestStatus, string> = {
  pending: "pill p-grey",
  accepted: "pill p-ok",
  rejected: "pill p-crit",
  countered: "pill p-warn",
};

const IMPACT_PILL: Record<RequestOption["impact"], string> = {
  HIGH: "pill p-crit",
  MEDIUM: "pill p-warn",
  LOW: "pill p-info",
  NONE: "pill p-ok",
  BENEFICIAL: "pill p-ok",
};

const TONE_COLOR = { ok: "#176842", warn: "#8a5a00", crit: "#a12a22", bad: "#a12a22" } as const;

const weeksLabel = (from: number, to: number) => (from === to ? `W${from}` : `W${from}–${to}`);

function NewRequest({ onCreated }: { onCreated: (r: AccessRequest) => void }) {
  const plan = usePlan();
  const [contract, setContract] = useState(plan.contracts[0]?.id ?? "");
  const [kind, setKind] = useState(KINDS[0]);
  const [location, setLocation] = useState("");
  const [from, setFrom] = useState(plan.busiestWeek);
  const [to, setTo] = useState(plan.busiestWeek);
  const [reason, setReason] = useState("Programme acceleration");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const c = plan.contracts.find((x) => x.id === contract);
  // Offer the locations this contract's own work runs over, busiest first.
  const onRoute = new Set(plan.activities.filter((a) => a.contract === contract).flatMap((a) => a.route));
  const locations = plan.locations.filter((l) => onRoute.has(l.id)).sort((a, b) => b.peak - a.peak);
  const loc = locations.some((l) => l.id === location) ? location : (locations[0]?.id ?? "");

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const made = await api.createRequest({
        instance_id: plan.instanceId,
        contract_number: contract,
        contractor: c?.contractor ?? "",
        request: kind,
        location_id: loc,
        week_from: from,
        week_to: Math.max(from, to),
        reason,
      });
      onCreated(made);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The request could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <span className="h2">Log a request</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="rq-c">Contract</label>
          <select id="rq-c" className="input" value={contract} onChange={(e) => setContract(e.target.value)}>
            {plan.contracts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {x.contractor} · P{x.priority}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rq-k">Request</label>
          <select id="rq-k" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="rq-l">Location (on this contract's routes)</label>
        <select id="rq-l" className="input" value={loc} onChange={(e) => setLocation(e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label} · capacity {l.capacity} · peak {Math.round(l.peak)}%
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="rq-f">From week</label>
          <select id="rq-f" className="input" value={String(from)} onChange={(e) => setFrom(Number(e.target.value))}>
            {plan.weeks.map((w) => (
              <option key={w} value={String(w)}>
                Week {w}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rq-t">To week</label>
          <select id="rq-t" className="input" value={String(Math.max(from, to))} onChange={(e) => setTo(Number(e.target.value))}>
            {plan.weeks
              .filter((w) => w >= from)
              .map((w) => (
                <option key={w} value={String(w)}>
                  Week {w}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="rq-r">Reason given</label>
        <input id="rq-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {failure && <div className="callout c-red">{failure}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving || !loc || !contract}>
          {saving ? "Saving…" : "Log request"}
        </button>
      </div>
    </div>
  );
}

function Assessment({ request, onStatus }: { request: AccessRequest; onStatus: (r: AccessRequest) => void }) {
  const plan = usePlan();
  const [seconds, setSeconds] = useState(30);
  const [state, setState] = useState<RequestAssessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    // Reset on (re)mount: StrictMode unmounts and remounts once in development.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const poll = async () => {
    for (;;) {
      const a = await api.assessment(request.id);
      if (!alive.current) return;
      setState(a);
      if (a.status === "completed") {
        setDraft(a.draft_response);
        return;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  };

  // Show an earlier assessment straight away, if there is one.
  useEffect(() => {
    if (!request.assessment) return;
    setBusy(true);
    poll()
      .catch(() => undefined)
      .finally(() => alive.current && setBusy(false));
  }, [request.id]);

  const assess = async () => {
    setBusy(true);
    setFailure(null);
    setState(null);
    try {
      await api.assessRequest(request.id, plan.runId, seconds);
      await poll();
    } catch (e) {
      if (alive.current) setFailure(e instanceof Error ? e.message : "The assessment failed.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const decide = async (status: RequestStatus) => {
    try {
      onStatus(await api.setRequestStatus(request.id, status));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The status could not be saved.");
    }
  };

  const loc = plan.locations.find((l) => l.id === request.location_id);
  const done = state?.status === "completed" ? state : null;

  return (
    <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="h2">
            {request.id.split("-").slice(0, 2).join("-")} · {request.contract_number} · {request.contractor}
          </span>
          <span className="small muted">
            {request.request} · {loc?.label ?? request.location_id} ·{" "}
            {weeksLabel(request.week_from, request.week_to)} · “{request.reason}”
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <span className={STATUS_PILL[request.status]}>{request.status}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="field" style={{ width: 170 }}>
          <label htmlFor="rq-b">Budget per option</label>
          <select id="rq-b" className="input" value={String(seconds)} disabled={busy} onChange={(e) => setSeconds(Number(e.target.value))}>
            {BUDGETS.map((b) => (
              <option key={b} value={String(b)}>
                {b} seconds
              </option>
            ))}
          </select>
        </div>
        <span className="small muted" style={{ flex: 1 }}>
          Prices the request against scenario {plan.scenario} ({plan.runId}) and the two nearest windows where this
          location still has room.
        </span>
        <button className="btn btn-primary" onClick={assess} disabled={busy}>
          {busy
            ? state?.status === "running"
              ? `Assessing ${state.done}/${state.total}…`
              : "Assessing…"
            : done
              ? "Re-assess"
              : "Assess impact"}
        </button>
      </div>

      {failure && <div className="callout c-red">{failure}</div>}

      {done && (
        <>
          <div className="divider" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span className="muted">Worst-week utilisation at this location</span>
            <span style={{ fontWeight: 600 }}>{done.capacity_before}%</span>
            <span className="muted">→</span>
            <span style={{ fontWeight: 600, color: done.capacity_after > 100 ? "#a12a22" : "#176842" }}>
              {done.capacity_after}%
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            {done.tiles.map((t) => (
              <div key={t.label} style={{ padding: "10px 12px", borderRadius: 7, border: "1px solid #e6e9ef", display: "flex", flexDirection: "column", gap: 3 }}>
                <span className="card-h">{t.label}</span>
                <span style={{ fontSize: 16, fontWeight: 600, color: TONE_COLOR[t.tone] }}>{t.value}</span>
                <span className="small muted">{t.note}</span>
              </div>
            ))}
          </div>

          {!!done.displaced.length && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span className="card-h">Displaced if granted as asked</span>
              {done.displaced.slice(0, 8).map((d) => (
                <div key={d.activity_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span className="mono" style={{ fontWeight: 600, width: 48 }}>
                    {d.activity_id}
                  </span>
                  <span className={PPILL[d.priority as 1 | 2 | 3]}>P{d.priority}</span>
                  <span style={{ flex: 1 }}>{d.contract_number}</span>
                  <span style={{ color: TONE_COLOR[d.tone] }}>{d.effect}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: `repeat(${done.options.length}, minmax(0, 1fr))`, gap: 10 }}>
            {done.options.map((o) => (
              <div
                key={o.run_id}
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: `1px solid ${o.kind === "REQUESTED" ? "#cfd5df" : "#e6e9ef"}`,
                  background: o.kind === "REQUESTED" ? "#fbfcfd" : "#fff",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", color: "#5b6578" }}>{o.kind}</span>
                  <div style={{ flex: 1 }} />
                  <span className={IMPACT_PILL[o.impact]}>{o.impact}</span>
                </div>
                <span style={{ fontWeight: 600 }}>{weeksLabel(o.week_from, o.week_to)}</span>
                <span className="small muted">
                  score {o.score_before} → {o.score_after ?? "—"}
                </span>
                {o.points.map((pt) => (
                  <span key={pt.text} className="small" style={{ color: TONE_COLOR[pt.tone] }}>
                    · {pt.text}
                  </span>
                ))}
              </div>
            ))}
          </div>

          <div className="field">
            <label htmlFor="rq-d">Draft response</label>
            <textarea id="rq-d" className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ height: "auto", padding: 10, lineHeight: 1.5 }} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(draft)}>
              Copy response
            </button>
            <button className="btn" onClick={() => decide("rejected")}>
              Reject
            </button>
            <button className="btn" onClick={() => decide("countered")} disabled={done.options.length < 2}>
              Counter-offer
            </button>
            <button className="btn btn-primary" onClick={() => decide("accepted")}>
              Accept
            </button>
          </div>
          <span className="small muted">
            Recording a decision does not change the approved plan. To apply an accepted request, re-solve with the extra
            night in Scenarios and adopt the result.
          </span>
        </>
      )}
    </div>
  );
}

export function Requests({ go }: { go: (t: TabId) => void }) {
  const plan = usePlan();
  const { instance } = usePlanState();
  const [list, setList] = useState<AccessRequest[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!instance) return;
    let alive = true;
    api
      .requests(instance.id)
      .then((rows) => {
        if (!alive) return;
        setList(rows);
        setAdding(rows.length === 0);
      })
      .catch((e: unknown) => alive && setFailure(e instanceof Error ? e.message : "Requests could not be loaded."));
    return () => {
      alive = false;
    };
  }, [instance]);

  const replace = (r: AccessRequest) => setList((rows) => (rows ?? []).map((x) => (x.id === r.id ? r : x)));
  const current = list?.find((r) => r.id === selected) ?? null;
  const open = (list ?? []).filter((r) => r.status === "pending").length;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Contractor Requests</h1>
          <span className="muted small">
            Access requests measured against the approved plan · alternatives generated by the what-if engine
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {list && <span className="pill p-grey">{open} pending</span>}
        <button className="btn btn-sm" onClick={() => setAdding((a) => !a)}>
          {adding ? "Close form" : "Log a request"}
        </button>
      </div>

      {failure && <div className="callout c-red">{failure}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 380px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {adding && (
            <NewRequest
              onCreated={(r) => {
                setList((rows) => [...(rows ?? []), r]);
                setSelected(r.id);
                setAdding(false);
              }}
            />
          )}
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #e6e9ef" }}>
              <span className="h2">Requests</span>
            </div>
            {!list && !failure && <div className="small muted" style={{ padding: 16 }}>Loading…</div>}
            {list && !list.length && (
              <div className="small muted" style={{ padding: 16 }}>
                No requests logged for {plan.name} yet.
              </div>
            )}
            {list?.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r.id)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  padding: "10px 16px",
                  borderBottom: "1px solid #eef0f4",
                  background: r.id === selected ? "#f2f6fd" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {r.contract_number}
                  </span>
                  <span style={{ flex: 1, fontSize: 13 }}>{r.contractor}</span>
                  <span className={STATUS_PILL[r.status]}>{r.status}</span>
                </div>
                <span className="small muted">
                  {r.request} · {plan.locations.find((l) => l.id === r.location_id)?.label ?? r.location_id} ·{" "}
                  {weeksLabel(r.week_from, r.week_to)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {current ? (
          <Assessment key={current.id} request={current} onStatus={replace} />
        ) : (
          <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="h2">Who could raise one</span>
            <span className="small muted">
              Select a request to assess it. Contracts with no slack are the likeliest to ask for more access.
            </span>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Contractor</th>
                  <th>Priority</th>
                  <th>Weekly cap</th>
                  <th>Slack</th>
                </tr>
              </thead>
              <tbody>
                {[...plan.contracts]
                  .sort((a, b) => a.slack - b.slack)
                  .slice(0, 8)
                  .map((c) => (
                    <tr key={c.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {c.id}
                      </td>
                      <td>{c.contractor}</td>
                      <td>
                        <span className={PPILL[c.priority]}>P{c.priority}</span>
                      </td>
                      <td>{c.weeklyCap} nights</td>
                      <td>
                        <span className={c.slack < 0 ? "pill p-crit" : c.slack === 0 ? "pill p-warn" : "pill p-ok"}>
                          {c.slack < 0 ? `${c.slack} wk` : c.slack === 0 ? "0 wk" : `+${c.slack} wk`}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div>
              <button className="btn btn-sm" onClick={() => go("scenarios")}>
                Price a change by hand in Scenarios
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
