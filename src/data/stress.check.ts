import fixture from "../fixtures/demo.json";
import type { InstanceSummary, Run } from "../api/types";
import { scenarioOverrides, stressPresets } from "./stress";
const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
export const stressCases = Object.entries(f.runs).flatMap(([scenario, baseline]) => stressPresets(f.instance, baseline).map(preset => {
  const overrides = scenarioOverrides(preset.a, f.instance, baseline);
  check(overrides.length > 0 && overrides.length <= 100, "Stress preset exceeds API bounds");
  check(overrides.every(o => o.closed && o.capacity === 0 && o.week >= 1 && o.week <= f.instance.horizon_weeks), "Stress preset must send real closures");
  check(baseline.schedule!.access.some(row => overrides.some(o => o.week === row.week && f.instance.activities.find(a => a.activity_id === row.activity_id)!.protected.includes(o.location_id))), "Stress preset misses all scheduled work");
  return { scenario, name: preset.name, overrides };
}));
const location = f.instance.locations[0].id;
const baseline = { ...f.runs.A, overrides: [{ location_id: location, week: 1, capacity: 1, closed: false }] };
const reduced = scenarioOverrides([{ tpl: "reduce", location, from: 1, to: 1 }], f.instance, baseline);
check(reduced[0].capacity === 0, "Reduction must use effective baseline supply");
const stacked = scenarioOverrides([{ tpl: "extra", location, from: 1, to: 1 }, { tpl: "reduce", location, from: 1, to: 1 }], f.instance, baseline);
check(stacked.length === 1 && stacked[0].capacity === 0, "Overlapping changes must compose and deduplicate");
console.log("ok   stress presets: critical work windows, real closures, effective supply, composed overrides");
