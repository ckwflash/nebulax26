// Offline check of the adapter against a real API-shaped payload.
//   npx vite build --ssr src/data/adapt.check.ts --outDir dist-checks && node dist-checks/adapt.check.js
import fixture from "../fixtures/demo.json";
import type { InstanceSummary, Run } from "../api/types";
import { ambiguousNames, buildPlan, locationLabel, spanLabel } from "./adapt";

const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
let bad = 0;
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
};

console.log("validation keys present:", Object.keys(f.runs.A.validation!.soft_scores).join(", "));
console.log("detail block:", f.runs.A.validation!.detail ? "yes" : "no");

for (const scen of ["A", "B", "C"] as const) {
  const plan = buildPlan(f.instance, f.runs[scen]);
  if (!plan) { check(`${scen} builds`, false); continue; }
  console.log(`\n--- Scenario ${scen} (${plan.solverStatus}) horizon ${plan.firstWeek}-${plan.lastWeek}, now=${plan.nowWeek}`);
  check(`${scen}: 54 activities`, plan.activities.length === 54);
  check(`${scen}: 14 contracts`, plan.contracts.length === 14);
  check(`${scen}: all scheduled`, plan.activities.every(a => a.scheduled),
        `${plan.activities.filter(a => !a.scheduled).length} unscheduled`);
  check(`${scen}: nights scheduled >= demand`, plan.activities.every(a => a.scheduledNights * 2 + a.ecloNights >= a.nights * 2));
  check(`${scen}: frag in 0..100`, plan.activities.every(a => a.frag >= 0 && a.frag <= 100));
  check(`${scen}: frag parts = 5`, plan.activities.every(a => a.fragParts.length === 5));
  check(`${scen}: every activity has a slot for each week`, plan.activities.every(a => a.weeks.every(w => a.slots[w] > 0)));
  check(`${scen}: congestion 0..100+`, plan.activities.every(a => a.congestion >= 0));
  check(`${scen}: score matches validation`, plan.validation.score === f.runs[scen].validation!.score);

  const eclo = plan.activities.filter(a => a.eclo);
  const late = plan.contracts.filter(c => c.overrunDays > 0);
  const co = plan.activities.filter(a => a.co.length);
  const top = [...plan.activities].sort((x, y) => y.frag - x.frag).slice(0, 5);
  console.log(`  ECLO activities: ${eclo.length} (${eclo.map(a => a.id).join(" ") || "none"})`);
  console.log(`  late contracts : ${late.length} (${late.map(c => `${c.id} +${c.overrunDays}d`).join(" ") || "none"})`);
  console.log(`  co-sharing     : ${co.length} activities`);
  console.log(`  busiest week   : ${plan.busiestWeek}`);
  console.log(`  peak locations : ${[...plan.locations].sort((a,b)=>b.peak-a.peak).slice(0,3).map(l=>`${l.label} ${Math.round(l.peak)}%`).join(" · ")}`);
  console.log(`  most fragile   : ${top.map(a => `${a.id}=${a.frag}`).join(" ")}`);
  console.log(`  frag spread    : min ${Math.min(...plan.activities.map(a=>a.frag))} max ${Math.max(...plan.activities.map(a=>a.frag))}`);
  const sample = top[0];
  console.log(`  ${sample.id} drivers: ${sample.fragParts.map(p => `${p.name}=${p.value}(+${p.points})`).join(", ")}`);
  console.log(`  ${sample.id} loc=${sample.loc} line=${sample.line} ${sample.dir} slack=${sample.slack} alts=${sample.alternatives} cong=${Math.round(sample.congestion)}%`);
}

const amb = ambiguousNames(f.instance.locations.map(l => l.id));
check("locationLabel sector", locationLabel("SEC:ALP:S01_S02:EB", amb) === "S01–S02 EB", locationLabel("SEC:ALP:S01_S02:EB", amb));
check("locationLabel platform", locationLabel("PLAT:ALP:S03:EB", amb) === "S03 platform EB", locationLabel("PLAT:ALP:S03:EB", amb));
check("shared sector gets its line", locationLabel("SEC:ALP:H01_H02:EB", amb) === "ALP H01–H02 EB", locationLabel("SEC:ALP:H01_H02:EB", amb));
check("labels are unique per location", new Set(f.instance.locations.map(l => locationLabel(l.id, amb))).size === f.instance.locations.length,
      `${new Set(f.instance.locations.map(l => locationLabel(l.id, amb))).size} labels for ${f.instance.locations.length} locations`);
check("spanLabel", spanLabel(f.instance.activities[0], amb) === "S15–S17 EB", spanLabel(f.instance.activities[0], amb));

console.log(bad ? `\n${bad} FAILED` : "\nadapter checks passed");
