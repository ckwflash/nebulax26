// Turns an instance summary + a solved run into the view model the tabs render.
// Every field here traces to real backend output; anything that cannot be derived is
// left out rather than invented. See fragility() for the one computed score.

import type {
  ActivityRow,
  CapacityRow,
  InstanceSummary,
  Run,
  ScenarioId,
  ValidationReport,
} from "../api/types";

/* ------------------------------------------------------------ location ---- */

export interface ParsedLocation {
  kind: "SEC" | "PLAT";
  line: string;
  bound: "EB" | "WB";
  /** Sector: the two station ids it spans. Platform: the station, twice. */
  from: string;
  to: string;
}

/** "SEC:ALP:S01_S02:EB" or "PLAT:ALP:S03:EB" */
export function parseLocation(id: string): ParsedLocation | null {
  const parts = id.split(":");
  if (parts.length !== 4) return null;
  const [kind, line, mid, bound] = parts;
  if (kind !== "SEC" && kind !== "PLAT") return null;
  if (bound !== "EB" && bound !== "WB") return null;
  if (kind === "SEC") {
    const [from, to] = mid.split("_");
    return { kind, line, bound, from, to: to ?? from };
  }
  return { kind, line, bound, from: mid, to: mid };
}

/**
 * Both lines carry an H01_H02 sector and every location exists on both bounds, so a
 * label without line and bound is ambiguous. `lines` disambiguates only where needed.
 */
export function locationLabel(id: string, ambiguous?: Set<string>): string {
  const p = parseLocation(id);
  if (!p) return id;
  const body = p.kind === "SEC" ? `${p.from}–${p.to}` : `${p.from} platform`;
  const prefix = ambiguous?.has(body) ? `${p.line} ` : "";
  return `${prefix}${body} ${p.bound}`;
}

/** Sector/platform names that appear on more than one line. */
export function ambiguousNames(ids: string[]): Set<string> {
  const lines = new Map<string, Set<string>>();
  for (const id of ids) {
    const p = parseLocation(id);
    if (!p) continue;
    const body = p.kind === "SEC" ? `${p.from}–${p.to}` : `${p.from} platform`;
    const set = lines.get(body) ?? new Set<string>();
    set.add(p.line);
    lines.set(body, set);
  }
  return new Set([...lines].filter(([, l]) => l.size > 1).map(([body]) => body));
}

/** The span an activity works, e.g. start S15_S16 + end S16_S17 -> "S15–S17". */
export function spanLabel(a: ActivityRow, ambiguous?: Set<string>): string {
  const s = parseLocation(a.start_location_id);
  const e = parseLocation(a.end_location_id);
  if (!s || !e) return a.start_location_id;
  const body = s.from === e.to ? `${s.from}–${s.to}` : `${s.from}–${e.to}`;
  const prefix = ambiguous?.has(body) ? `${s.line} ` : "";
  return `${prefix}${body} ${s.bound}`;
}

/* ------------------------------------------------------------- weeks ------ */

export function weekEnding(horizonStart: string, week: number): Date {
  const start = new Date(horizonStart + "T00:00:00Z");
  return new Date(start.getTime() + (week * 7 - 1) * 86400000);
}
export function weekStarting(horizonStart: string, week: number): Date {
  const start = new Date(horizonStart + "T00:00:00Z");
  return new Date(start.getTime() + (week - 1) * 7 * 86400000);
}
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const shortDate = (d: Date) => DATE_FMT.format(d);

/* ------------------------------------------------------------- views ------ */

export type RiskLevel = "high" | "med" | "low";

export interface FragPart {
  name: string;
  value: string;
  bar: number;
  level: RiskLevel;
  points: number;
}

export interface ActivityView {
  id: string;
  contract: string;
  priority: 1 | 2 | 3;
  contractPriority: 1 | 2 | 3;
  line: string;
  lineCode: string;
  dir: "EB" | "WB";
  type: string;
  access: "PM" | "PC" | "C";
  live: boolean;
  nature: string;
  /** Required access nights from the demand book. */
  nights: number;
  /** Nights actually scheduled, and how many of those are ECLO. */
  scheduledNights: number;
  ecloNights: number;
  eclo: boolean;
  ws: number;
  we: number;
  weeks: number[];
  loc: string;
  route: string[];
  protectedFootprint: string[];
  predecessor: string;
  successors: string[];
  co: string[];
  delayed: boolean;
  plannedStart: string;
  startWeek: number;
  /** Highest utilisation, as a percentage, across this activity's route weeks. */
  congestion: number;
  slack: number;
  alternatives: number;
  /** Weeks it could move to on capacity + precedence grounds. */
  altWeeks: number[];
  /** Weeks it cannot move to because a route location is already full. */
  blockedWeeks: number[];
  confidence: Confidence;
  frag: number;
  risk: RiskLevel;
  fragParts: FragPart[];
  /** week -> synchronized opportunity from the run's timing witness. */
  slots: Record<number, number>;
  scheduled: boolean;
}

export interface ContractView {
  id: string;
  priority: 1 | 2 | 3;
  name: string;
  contractor: string;
  activityCount: number;
  nights: number;
  deadlineWeek: number;
  projectedWeek: number;
  overrunDays: number;
  slack: number;
  status: string;
  accessType: "PM" | "PC" | "C";
  nature: string;
  workfronts: number;
  weeklyCap: number;
  plannedCompletion: string;
  simulatedCompletion: string;
}

export interface LocationView {
  id: string;
  label: string;
  capacity: number;
  /** Peak used/capacity across the horizon, as a percentage. */
  peak: number;
  peakWeek: number | null;
}

export interface PlanModel {
  instanceId: string;
  name: string;
  horizonStart: string;
  weeks: number[];
  firstWeek: number;
  lastWeek: number;
  /** Week containing today, when today falls inside the horizon. */
  nowWeek: number | null;
  scenario: ScenarioId;
  runId: string;
  solverStatus: string;
  activities: ActivityView[];
  contracts: ContractView[];
  locations: LocationView[];
  /** "<location>|<week>" -> capacity row. */
  usage: Map<string, CapacityRow>;
  validation: ValidationReport;
  /** Busiest week by scheduled accesses — the default for night detail. */
  busiestWeek: number;
  activityTypes: string[];
}

const pct = (used: number, capacity: number) => (capacity > 0 ? (used / capacity) * 100 : 0);

/* --------------------------------------------------------- fragility ------ */

/**
 * Fragility 0–100: how badly this activity would suffer from losing a night.
 * Five drivers, each traceable to backend output — no hand-authored scores.
 */
function fragility(input: {
  slack: number;
  alternatives: number;
  congestion: number;
  ecloNights: number;
  deps: number;
}): { score: number; parts: FragPart[] } {
  const { slack, alternatives, congestion, ecloNights, deps } = input;

  const slackPts = slack <= 0 ? 24 : slack === 1 ? 17 : slack === 2 ? 10 : 4;
  const altPts = alternatives === 0 ? 25 : alternatives === 1 ? 19 : alternatives === 2 ? 12 : alternatives === 3 ? 6 : 2;
  const utilPts = Math.min(25, Math.round(congestion / 4));
  const ecloPts = ecloNights >= 2 ? 18 : ecloNights === 1 ? 10 : 2;
  const depPts = deps >= 3 ? 12 : deps === 2 ? 8 : deps === 1 ? 4 : 0;

  const lvl = (p: number, hi: number, mid: number): RiskLevel => (p >= hi ? "high" : p >= mid ? "med" : "low");

  const parts: FragPart[] = [
    {
      name: "Deadline slack",
      value: slack <= 0 ? (slack === 0 ? "0 weeks" : `${slack} weeks`) : `${slack} week${slack === 1 ? "" : "s"}`,
      bar: Math.round((slackPts / 24) * 100),
      level: lvl(slackPts, 17, 10),
      points: slackPts,
    },
    {
      name: "Alternative viable periods",
      value: String(alternatives),
      bar: Math.round((altPts / 25) * 100),
      level: lvl(altPts, 19, 12),
      points: altPts,
    },
    {
      name: "Location utilisation",
      value: `${Math.round(congestion)}%`,
      bar: Math.min(100, Math.round(congestion)),
      level: congestion >= 90 ? "high" : congestion >= 70 ? "med" : "low",
      points: utilPts,
    },
    {
      name: "ECLO dependence",
      value: ecloNights ? `${ecloNights} night${ecloNights === 1 ? "" : "s"}` : "None",
      bar: Math.round((ecloPts / 18) * 100),
      level: lvl(ecloPts, 18, 10),
      points: ecloPts,
    },
    {
      name: "Downstream dependencies",
      value: deps ? `${deps} link${deps === 1 ? "" : "s"}` : "None",
      bar: Math.round((depPts / 12) * 100),
      level: lvl(depPts, 12, 8),
      points: depPts,
    },
  ];

  const score = Math.max(0, Math.min(100, slackPts + altPts + utilPts + ecloPts + depPts));
  return { score, parts };
}

export type ConfLevel = "HIGH" | "MEDIUM" | "LOW";
export interface Confidence {
  score: number;
  level: ConfLevel;
  reasons: string[];
  cls: string;
  color: string;
}

/**
 * Operational confidence (spec 4.3), fed by real slack, alternatives, utilisation,
 * ECLO and dependency counts rather than an authored fragility number.
 */
export function confidenceOf(input: {
  frag: number;
  slack: number;
  alternatives: number;
  congestion: number;
  ecloNights: number;
  deps: number;
  delayed: boolean;
  loc: string;
}): Confidence {
  const { frag, slack, alternatives: alts, congestion: cg, ecloNights, deps, delayed, loc } = input;
  let s = 100 - Math.round(frag * 0.45);
  if (slack <= 0) s -= 18;
  else if (slack === 1) s -= 8;
  if (alts === 0) s -= 14;
  else if (alts === 1) s -= 9;
  else if (alts === 2) s -= 4;
  if (cg >= 90) s -= 10;
  else if (cg >= 70) s -= 5;
  if (ecloNights) s -= 10;
  if (deps >= 3) s -= 6;
  else if (deps >= 2) s -= 3;
  if (delayed) s -= 6;
  s = Math.max(8, Math.min(96, s));
  const level: ConfLevel = s >= 70 ? "HIGH" : s >= 45 ? "MEDIUM" : "LOW";
  const reasons = [
    slack <= 0 ? "No deadline slack" : slack === 1 ? "Low deadline slack (1 week)" : `${slack} weeks of deadline slack`,
    alts === 0 ? "No viable alternative period" : alts === 1 ? "1 viable alternative period" : `${alts} viable alternative periods`,
    cg >= 90
      ? `High congestion at ${loc} (${Math.round(cg)}%)`
      : cg >= 70
        ? `Moderate congestion at ${loc} (${Math.round(cg)}%)`
        : `Spare capacity at ${loc} (${Math.round(cg)}%)`,
  ];
  if (ecloNights) reasons.push(`Depends on ${ecloNights} ECLO night${ecloNights === 1 ? "" : "s"}`);
  if (deps >= 2) reasons.push(`${deps} scheduling dependencies`);
  return {
    score: s,
    level,
    reasons,
    cls: level === "HIGH" ? "pill p-ok" : level === "MEDIUM" ? "pill p-warn" : "pill p-crit",
    color: level === "HIGH" ? "#1e8a5a" : level === "MEDIUM" ? "#b7791f" : "#c1352c",
  };
}

export const riskOf = (frag: number): RiskLevel => (frag >= 65 ? "high" : frag >= 40 ? "med" : "low");

/* ------------------------------------------------------------ builder ----- */

export function buildPlan(instance: InstanceSummary, run: Run): PlanModel | null {
  if (!run.schedule || !run.validation) return null;
  const { schedule, validation } = run;

  const weeks = Array.from({ length: instance.horizon_weeks }, (_, i) => i + 1);
  const lineName = new Map(instance.lines.map((l) => [l.line_code, l.line_name.replace(/^Line\s+/i, "")]));
  const capacityOf = new Map(instance.locations.map((l) => [l.id, l.capacity]));

  const ambiguous = ambiguousNames(instance.locations.map((l) => l.id));

  const usage = new Map<string, CapacityRow>();
  for (const row of validation.capacity) usage.set(`${row.location_id}|${row.week}`, row);

  // Peak utilisation per location across the horizon.
  const peaks = new Map<string, { peak: number; week: number | null }>();
  for (const row of validation.capacity) {
    const p = pct(row.used, row.capacity);
    const seen = peaks.get(row.location_id);
    if (!seen || p > seen.peak) peaks.set(row.location_id, { peak: p, week: row.week });
  }
  const locations: LocationView[] = instance.locations.map((l) => ({
    id: l.id,
    label: locationLabel(l.id, ambiguous),
    capacity: l.capacity,
    peak: peaks.get(l.id)?.peak ?? 0,
    peakWeek: peaks.get(l.id)?.week ?? null,
  }));

  // Access rows grouped per activity.
  const accessByActivity = new Map<string, { week: number; eclo: number }[]>();
  for (const row of schedule.access) {
    const list = accessByActivity.get(row.activity_id) ?? [];
    list.push({ week: row.week, eclo: row.eclo });
    accessByActivity.set(row.activity_id, list);
  }

  // Co-sharing: same location, week and group means one possession.
  const groups = new Map<string, Set<string>>();
  for (const row of schedule.occupancy) {
    const key = `${row.location_id}|${row.week}|${row.co_share_group}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(row.activity_id);
    groups.set(key, set);
  }
  const partners = new Map<string, Set<string>>();
  for (const set of groups.values()) {
    if (set.size < 2) continue;
    for (const id of set) {
      const mine = partners.get(id) ?? new Set<string>();
      for (const other of set) if (other !== id) mine.add(other);
      partners.set(id, mine);
    }
  }

  const projectOf = new Map(instance.projects.map((p) => [p.contract_number, p]));
  const resultOf = new Map(validation.contracts.map((c) => [c.contract_number, c]));

  const successors = new Map<string, string[]>();
  for (const a of instance.activities) {
    if (!a.predecessor_activity_id) continue;
    const list = successors.get(a.predecessor_activity_id) ?? [];
    list.push(a.activity_id);
    successors.set(a.predecessor_activity_id, list);
  }

  const finishOf = new Map<string, number>();
  for (const [id, rows] of accessByActivity) finishOf.set(id, Math.max(...rows.map((r) => r.week)));

  const contracts: ContractView[] = instance.projects.map((p) => {
    const result = resultOf.get(p.contract_number);
    const members = instance.activities.filter((a) => a.contract_number === p.contract_number);
    const deadlineWeek = weekOfDate(instance.horizon_start, p.planned_completion_date);
    const projectedWeek = result?.completion_week ?? 0;
    const overrunDays = result?.overrun_days ?? 0;
    const slack = deadlineWeek - projectedWeek;
    const contractEclo = members.some((m) =>
      (accessByActivity.get(m.activity_id) ?? []).some((r) => r.eclo === 1),
    );
    const status = overrunDays > 0 ? "Projected late" : slack <= 0 ? "At risk" : contractEclo ? "ECLO dependent" : "On track";
    return {
      id: p.contract_number,
      priority: p.contract_priority,
      name: p.contract_description,
      contractor: p.contractor ?? p.contract_description,
      activityCount: members.length,
      nights: members.reduce((n, m) => n + m.total_accesses, 0),
      deadlineWeek,
      projectedWeek,
      overrunDays,
      slack,
      status,
      accessType: p.access_type,
      nature: p.nature_of_activity,
      workfronts: p.number_of_workfronts,
      weeklyCap: p.number_of_maximum_access_per_week,
      plannedCompletion: p.planned_completion_date,
      simulatedCompletion: result?.simulated_completion_date ?? "",
    };
  });
  const contractOf = new Map(contracts.map((c) => [c.id, c]));

  const activities: ActivityView[] = instance.activities.map((a) => {
    const p = projectOf.get(a.contract_number)!;
    const c = contractOf.get(a.contract_number)!;
    const rows = accessByActivity.get(a.activity_id) ?? [];
    const activityWeeks = [...new Set(rows.map((r) => r.week))].sort((x, y) => x - y);
    const ecloNights = rows.filter((r) => r.eclo === 1).length;
    const start = parseLocation(a.start_location_id);

    // Utilisation the activity actually sits in: its route locations, its weeks.
    let congestion = 0;
    for (const loc of a.route) {
      for (const w of activityWeeks.length ? activityWeeks : [a.start_week]) {
        const row = usage.get(`${loc}|${w}`);
        if (row) congestion = Math.max(congestion, pct(row.used, row.capacity));
      }
      // A location with no work in those weeks still has a standing peak.
      if (!activityWeeks.length) congestion = Math.max(congestion, peaks.get(loc)?.peak ?? 0);
    }

    // Weeks it could move to on capacity and precedence grounds alone.
    const predFinish = a.predecessor_activity_id ? (finishOf.get(a.predecessor_activity_id) ?? 0) : 0;
    const altWeeks: number[] = [];
    const blockedWeeks: number[] = [];
    for (const w of weeks) {
      if (w < a.start_week || w <= predFinish) continue;
      if (activityWeeks.includes(w)) continue;
      const roomy = a.route.every((loc) => {
        const row = usage.get(`${loc}|${w}`);
        const cap = capacityOf.get(loc) ?? 0;
        return row ? row.used < row.capacity : cap > 0;
      });
      (roomy ? altWeeks : blockedWeeks).push(w);
    }
    const alternatives = altWeeks.length;

    const co = [...(partners.get(a.activity_id) ?? [])].sort();
    const succ = successors.get(a.activity_id) ?? [];
    const deps = co.length + succ.length + (a.predecessor_activity_id ? 1 : 0);
    const { score, parts } = fragility({
      slack: c.slack,
      alternatives,
      congestion,
      ecloNights,
      deps,
    });

    const slots: Record<number, number> = {};
    for (const w of activityWeeks) {
      const slot = schedule.witness?.[`${a.activity_id}:${w}`];
      if (slot) slots[w] = slot;
    }

    return {
      id: a.activity_id,
      contract: a.contract_number,
      priority: a.activity_priority,
      contractPriority: p.contract_priority,
      line: lineName.get(start?.line ?? "") ?? start?.line ?? "",
      lineCode: start?.line ?? "",
      dir: start?.bound ?? "EB",
      type: a.activity_type,
      access: p.access_type,
      live: p.nature_of_activity === "Live",
      nature: p.nature_of_activity,
      nights: a.total_accesses,
      scheduledNights: rows.length,
      ecloNights,
      eclo: ecloNights > 0,
      ws: activityWeeks[0] ?? a.start_week,
      we: activityWeeks[activityWeeks.length - 1] ?? a.start_week,
      weeks: activityWeeks,
      loc: spanLabel(a, ambiguous),
      route: a.route,
      protectedFootprint: a.protected,
      predecessor: a.predecessor_activity_id,
      successors: succ,
      co,
      delayed: c.overrunDays > 0,
      plannedStart: a.planned_start_date,
      startWeek: a.start_week,
      congestion,
      slack: c.slack,
      alternatives,
      altWeeks,
      blockedWeeks,
      confidence: confidenceOf({
        frag: score,
        slack: c.slack,
        alternatives,
        congestion,
        ecloNights,
        deps,
        delayed: c.overrunDays > 0,
        loc: spanLabel(a, ambiguous),
      }),
      frag: score,
      risk: riskOf(score),
      fragParts: parts,
      slots,
      scheduled: activityWeeks.length > 0,
    };
  });

  const perWeek = new Map<number, number>();
  for (const row of schedule.access) perWeek.set(row.week, (perWeek.get(row.week) ?? 0) + 1);
  const busiestWeek =
    [...perWeek.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? weeks[0] ?? 1;

  const today = new Date();
  const start = new Date(instance.horizon_start + "T00:00:00Z");
  const elapsed = Math.floor((today.getTime() - start.getTime()) / (7 * 86400000)) + 1;
  const nowWeek = elapsed >= 1 && elapsed <= instance.horizon_weeks ? elapsed : null;

  return {
    instanceId: instance.id,
    name: instance.name,
    horizonStart: instance.horizon_start,
    weeks,
    firstWeek: weeks[0] ?? 1,
    lastWeek: weeks[weeks.length - 1] ?? 1,
    nowWeek,
    scenario: run.scenario,
    runId: run.id,
    solverStatus: run.solver_status,
    activities,
    contracts,
    locations,
    usage,
    validation,
    busiestWeek,
    activityTypes: [...new Set(instance.activities.map((a) => a.activity_type))].sort(),
  };
}

/** Week index (1-based) containing a calendar date, relative to the horizon start. */
export function weekOfDate(horizonStart: string, date: string): number {
  const start = new Date(horizonStart + "T00:00:00Z").getTime();
  const at = new Date(date + "T00:00:00Z").getTime();
  return Math.floor((at - start) / (7 * 86400000)) + 1;
}
