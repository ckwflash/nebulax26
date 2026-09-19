// Spec section 9 — Ask RailPlan, answered by the planning service. Every answer comes
// back with the evidence rows the backend used; nothing is composed in the browser.

import { useState } from "react";
import { api } from "../api/client";
import type { ChatEvidence } from "../api/types";
import { usePlanState } from "../state/plan";

interface Msg {
  kind: "user" | "answer" | "error";
  text: string;
  evidence?: ChatEvidence[];
  mode?: string;
  notice?: string | null;
}

export function Ask() {
  const { plan, instance, run } = usePlanState();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);

  const suggestions = plan
    ? [
        `Why is ${plan.contracts.find((c) => c.overrunDays > 0)?.id ?? plan.contracts[0].id} finishing when it does?`,
        "Which locations are closest to capacity?",
        `Explain ${[...plan.activities].sort((a, b) => b.frag - a.frag)[0]?.id ?? "A001"}`,
        "Summarise this plan",
        "What happens if capacity drops by one?",
      ]
    : [];

  const ask = async (text: string) => {
    if (!text.trim() || !instance || !run || busy) return;
    setMsgs((m) => [...m, { kind: "user", text }]);
    setQ("");
    setBusy(true);
    try {
      const reply = await api.chat({ instance_id: instance.id, run_id: run.id, message: text });
      setMsgs((m) => [
        ...m,
        { kind: "answer", text: reply.answer, evidence: reply.evidence, mode: reply.mode, notice: reply.notice },
      ]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { kind: "error", text: e instanceof Error ? e.message : "The planning service did not answer." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="h1">Ask RailPlan</h1>
          <span className="muted small">
            Ask about this plan in plain English · answers and evidence come from the planning service, computed from
            the run you are looking at
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 330px",
          gap: 16,
          flex: 1,
          minHeight: 0,
          alignItems: "stretch",
        }}
      >
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: "18px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {!msgs.length && (
              <div className="callout c-blue">
                Ask about any contract (C001–C0{plan?.contracts.length ?? 14}), activity, location or week in this
                demand book. Answers are grounded in scenario {plan?.scenario} and cite the rows they came from.
              </div>
            )}

            {msgs.map((m, i) =>
              m.kind === "user" ? (
                <div className="msg-u" key={i}>
                  {m.text}
                </div>
              ) : m.kind === "error" ? (
                <div className="callout c-red" key={i} style={{ alignSelf: "flex-start", maxWidth: "82%" }}>
                  {m.text}
                </div>
              ) : (
                <div className="msg-a" key={i} style={{ maxWidth: "100%" }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.5 }}>{m.text}</span>
                  {m.notice && <span className="small muted">{m.notice}</span>}
                  {!!m.evidence?.length && (
                    <div style={{ display: "grid", gridTemplateColumns: "104px 1fr", gap: "8px 12px", fontSize: 13 }}>
                      <span className="card-h" style={{ paddingTop: 2 }}>
                        Evidence
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {m.evidence.map((e) => (
                          <span key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <span style={{ color: "#1d5fd1" }}>•</span>
                            <span style={{ fontWeight: 600 }}>{e.title}</span>
                            <span className="muted">{e.detail}</span>
                          </span>
                        ))}
                      </div>
                      <span className="card-h" style={{ paddingTop: 2 }}>
                        Source
                      </span>
                      <span className="small muted">
                        {m.mode} · scenario {plan?.scenario} · {plan?.solverStatus}
                      </span>
                    </div>
                  )}
                </div>
              ),
            )}

            {busy && (
              <div className="msg-a" style={{ maxWidth: "50%" }}>
                <span className="muted">Working through the schedule…</span>
              </div>
            )}
          </div>

          <div
            style={{
              borderTop: "1px solid #e6e9ef",
              padding: "12px 16px",
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <input
              className="input"
              style={{ flex: 1, height: 40 }}
              placeholder="Ask about a contract, activity, location or scenario…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask(q);
              }}
              aria-label="Question"
            />
            <button className="btn btn-primary" onClick={() => ask(q)} disabled={busy}>
              {busy ? "Asking…" : "Ask"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="h2">Common questions</span>
              <span className="small muted">Built from this plan · tap one to ask it</span>
            </div>
            {suggestions.map((t) => (
              <button
                key={t}
                className="row-btn"
                style={{
                  padding: "11px 12px",
                  border: "1px solid #e6e9ef",
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: 500,
                }}
                onClick={() => ask(t)}
                disabled={busy}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
