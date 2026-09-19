// Spec section 2.1 — left navigation, 232px, identical on every tab.

import type { ReactElement } from "react";
import type { TabId } from "./tabs";

const ico = {
  stroke: "currentColor",
  fill: "none",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

const ICONS: Record<TabId, ReactElement> = {
  home: (
    <svg {...ico}>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h5v-6h4v6h5V10" />
    </svg>
  ),
  schedule: (
    <svg {...ico}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 13h5M8 16h8" />
    </svg>
  ),
  contracts: (
    <svg {...ico}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 12h6M9 16h6M15 3v4h4" />
    </svg>
  ),
  risk: (
    <svg {...ico}>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v4M12 17v.5" />
    </svg>
  ),
  scenarios: (
    <svg {...ico}>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
    </svg>
  ),
  disruption: (
    <svg {...ico}>
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  requests: (
    <svg {...ico}>
      <path d="M4 4h16v12H8l-4 4z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  ),
  reports: (
    <svg {...ico}>
      <path d="M4 20h16" />
      <path d="M6 17V10M11 17V5M16 17v-7" />
    </svg>
  ),
  ask: (
    <svg {...ico}>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M12 8v3M12 13v.5" />
    </svg>
  ),
};

const SECTIONS: { label: string; items: TabId[] }[] = [
  { label: "OVERVIEW", items: ["home"] },
  { label: "PLAN", items: ["schedule", "contracts"] },
  { label: "ANALYSE", items: ["risk"] },
  { label: "SIMULATE", items: ["scenarios"] },
  { label: "RESPOND", items: ["disruption", "requests"] },
  { label: "DELIVER", items: ["reports"] },
];

const LABEL: Record<TabId, string> = {
  home: "Home",
  schedule: "Schedule",
  contracts: "Contracts & Activities",
  risk: "Risk & Resilience",
  scenarios: "Scenarios",
  disruption: "Disruption Response",
  requests: "Contractor Requests",
  reports: "Reports",
  ask: "Ask RailPlan",
};

export function Nav({ current, go }: { current: TabId; go: (t: TabId) => void }) {
  const askActive = current === "ask";
  return (
    <nav
      style={{
        width: 232,
        height: "100%",
        background: "#0f1f3d",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "2px 8px 16px",
          borderBottom: "1px solid rgba(255,255,255,.1)",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: "#1d5fd1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M5 19L19 5M5 5h6M13 19h6M9 9l6 6" />
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 15, letterSpacing: "-.01em" }}>RailPlan</span>
          <span style={{ color: "#7f8ca6", fontSize: 10.5, fontWeight: 500, letterSpacing: ".08em" }}>
            ACCESS PLANNING
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {SECTIONS.map((s) => (
          <div key={s.label}>
            <div className="nav-sec">{s.label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {s.items.map((id) => (
                <button
                  key={id}
                  className={"nav-link" + (current === id ? " active" : "")}
                  onClick={() => go(id)}
                >
                  {ICONS[id]}
                  <span>{LABEL[id]}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => go("ask")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 46,
          padding: "0 12px",
          marginBottom: 10,
          borderRadius: 9,
          border: 0,
          width: "100%",
          textAlign: "left",
          background: askActive ? "#1746a8" : "#1d5fd1",
          color: "#fff",
          textDecoration: "none",
          boxShadow: askActive
            ? "0 0 0 2px rgba(255,255,255,.25), 0 3px 10px rgba(29,95,209,.4)"
            : "0 3px 10px rgba(29,95,209,.4)",
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: "rgba(255,255,255,.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16v11H9l-5 4z" />
            <path d="M12 8v3M12 13v.5" />
          </svg>
        </span>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, flex: 1 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>Ask RailPlan</span>
          <span style={{ fontSize: 10.5, opacity: 0.85 }}>Any question about the plan</span>
        </div>
        <span style={{ fontSize: 17, opacity: 0.9 }}>›</span>
      </button>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          borderTop: "1px solid rgba(255,255,255,.1)",
          paddingTop: 8,
        }}
      >
        {/* Settings and Help are deliberately inert. */}
        <a className="nav-link" href="#settings" onClick={(e) => e.preventDefault()}>
          <svg {...ico}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.5a7 7 0 0 0-1.7 1L5.1 5.6l-2 3.4L5.1 10.5a7 7 0 0 0 0 2L3.1 14l2 3.4 2.3-.9a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3.9 2-3.4-2-1.5c.1-.3.1-.7.1-1z" />
          </svg>
          <span>Settings</span>
        </a>
        <a className="nav-link" href="#help" onClick={(e) => e.preventDefault()}>
          <svg {...ico}>
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17v.5" />
          </svg>
          <span>Help</span>
        </a>
      </div>
    </nav>
  );
}
