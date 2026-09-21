import type { InstanceSummary, Override, Run } from "../api/types";

export type TplKey = "reduce" | "close" | "extra";
export interface Assumption { tpl: TplKey; location: string; from: number; to: number }
export interface StressPreset { name: string; sev: string; desc: string; a: Assumption[] }

/** Apply changes to the effective baseline supply, including overlapping edits. */
export function scenarioOverrides(assumptions: Assumption[], instance: InstanceSummary, baseline: Run): Override[] {
  const nominal = new Map(instance.locations.map(l => [l.id, l.capacity]));
  const effective = new Map((baseline.overrides ?? []).map(o => [`${o.location_id}|${o.week}`, o]));
  const changed = new Map<string, Override>();
  for (const a of assumptions) for (let week = a.from; week <= a.to; week++) {
    const key = `${a.location}|${week}`;
    const previous = changed.get(key) ?? effective.get(key);
    const capacity = previous?.closed ? 0 : (previous?.capacity ?? nominal.get(a.location) ?? 0);
    const next = { location_id: a.location, week,
      capacity: a.tpl === "close" ? 0 : a.tpl === "reduce" ? Math.max(0, capacity - 2) : Math.min(50, capacity + 1),
      closed: a.tpl === "close" || (a.tpl === "reduce" && !!previous?.closed) };
    changed.set(key, next);
  }
  return [...changed.values()];
}

/** Stress the least flexible work window, not a utilisation peak with spare weeks. */
export function stressPresets(instance: InstanceSummary, baseline: Run): StressPreset[] {
  const weekOf = (date: string) => Math.floor((Date.parse(date) - Date.parse(instance.horizon_start)) / 604800000) + 1;
  const projects = new Map(instance.projects.map(p => [p.contract_number, p]));
  const completion = new Map((baseline.validation?.contracts ?? []).map(c => [c.contract_number, c.completion_week]));
  const candidates = instance.activities.map(activity => {
    const project = projects.get(activity.contract_number)!;
    const start = Math.max(1, activity.start_week);
    const deadline = weekOf(project.planned_completion_date);
    const required = baseline.scenario === "A" ? activity.total_accesses : Math.ceil(2 * activity.total_accesses / 3);
    const target = Math.max(deadline, completion.get(activity.contract_number) ?? deadline);
    // Even with maximum ECLO output, the remaining window cannot retain this
    // contract's current finish. If it exceeds the horizon, infeasibility is real.
    const end = Math.min(instance.horizon_weeks, Math.max(start + 1, target - required + 2));
    return { activity, start, end, pressure: activity.total_accesses / Math.max(1, deadline - start + 1) };
  }).filter(c => c.start <= instance.horizon_weeks && c.activity.route.length)
    .sort((a, b) => b.pressure - a.pressure || b.activity.total_accesses - a.activity.total_accesses || a.activity.activity_id.localeCompare(b.activity.activity_id));
  const first = candidates[0];
  if (!first) return [];
  const change = (c: typeof first, extra = 0): Assumption => ({ tpl: "close", location: c.activity.start_location_id,
    from: c.start, to: Math.min(instance.horizon_weeks, c.end + extra) });
  const second = candidates.find(c => c.activity.contract_number !== first.activity.contract_number && c.activity.start_location_id !== first.activity.start_location_id);
  const names = (c: typeof first) => `${c.activity.activity_id} / ${c.activity.contract_number}`;
  const result: StressPreset[] = [{ name: "Delay deadline-critical work", sev: "High",
    desc: `Close ${names(first)}'s corridor in W${first.start}–${first.end}, removing the weeks needed to retain its current completion.`, a: [change(first)] }];
  if (second) result.push({ name: "Disrupt two critical workfronts", sev: "Severe",
    desc: `Block the recovery windows for ${names(first)} and ${names(second)} together.`, a: [change(first), change(second)] });
  result.push({ name: "Extend the critical corridor outage", sev: "Severe",
    desc: `Keep ${names(first)}'s corridor closed through W${Math.min(instance.horizon_weeks, first.end + 2)}. This can make full delivery impossible.`, a: [change(first, 2)] });
  return result;
}
