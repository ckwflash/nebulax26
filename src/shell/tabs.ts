export type TabId =
  | "home"
  | "schedule"
  | "contracts"
  | "risk"
  | "scenarios"
  | "disruption"
  | "requests"
  | "reports"
  | "ask";

export const TAB_TITLE: Record<TabId, string> = {
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

/** Every tab shows the same plan crumb under its title. */
export const PLAN_CRUMB = "Plan P-2026-24 · Scenario C (Balanced) · Feasible";

export interface Nav {
  go: (tab: TabId) => void;
}
