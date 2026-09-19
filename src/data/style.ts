// Shared pill/colour lookups (spec section 3.2).

import type { RiskLevel } from "./adapt";

export const RISKCOL: Record<RiskLevel, string> = { high: "#c1352c", med: "#b7791f", low: "#1e8a5a" };
export const RISKLBL: Record<RiskLevel, string> = { high: "High risk", med: "Medium risk", low: "Low risk" };
export const RISKPILL: Record<RiskLevel, string> = {
  high: "pill p-crit",
  med: "pill p-warn",
  low: "pill p-ok",
};
export const PPILL: Record<number, string> = { 1: "pill p-p1", 2: "pill p-p2", 3: "pill p-p3" };

export const LVL_PILL: Record<RiskLevel, [string, string]> = {
  high: ["pill p-crit", "High risk"],
  med: ["pill p-warn", "Medium risk"],
  low: ["pill p-ok", "Low risk"],
};
