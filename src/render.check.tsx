// Renders every tab against the real fixture payload, to catch runtime errors without
// a browser. Run: npx vite build --ssr src/render.check.tsx --outDir dist-checks && node dist-checks/render.check.js
import { renderToString } from "react-dom/server";
import fixture from "./fixtures/demo.json";
import type { InstanceSummary, Run } from "./api/types";
import { PlanProvider } from "./state/plan";
import { Tabs } from "./RailPlan";

const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
let bad = 0;

for (const scen of ["A", "B", "C"] as const) {
  let html = "";
  try {
    html = renderToString(
      <PlanProvider initial={{ instance: f.instance, run: f.runs[scen] }}>
        <Tabs />
      </PlanProvider>,
    );
  } catch (e) {
    bad++;
    console.log(`FAIL scenario ${scen} threw: ${(e as Error).message}`);
    continue;
  }
  const probes = [
    "Operations overview", "Attention queue", "Run summary", "First week of work",
    "Schedule", "Ghost alternatives", "Contracts &amp; Activities", "Fragility",
    "Risk &amp; Resilience", "Where the schedule is most vulnerable", "What drives this score",
    "Ask RailPlan", "Common questions", "Side by side", "What if", "Stress tests",
    "Disruption Response", "Define disruption", "Contractor Requests", "Who could raise one",
    "Reports", "Submission bundle", "Document pack",
  ];
  const missing = probes.filter((p) => !html.includes(p));
  if (missing.length) { bad++; console.log(`FAIL scenario ${scen} missing: ${missing.join(", ")}`); }
  else console.log(`ok   scenario ${scen} renders all nine tabs (${Math.round(html.length / 1024)} kB of markup)`);

  // Real identifiers must actually appear, not placeholders.
  for (const id of ["A036", "C006", "H01–H02"]) {
    if (!html.includes(id)) { bad++; console.log(`FAIL scenario ${scen}: ${id} not rendered`); }
  }
}
console.log(bad ? `\n${bad} FAILED` : "\nall tabs render against real data");
