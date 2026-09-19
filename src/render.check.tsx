// Renders every tab against the real fixture payload and exercises the upload flow's
// client-side checks, to catch runtime errors without a browser.
//   npx vite build --ssr src/render.check.tsx --outDir dist-checks && node dist-checks/render.check.js

import { renderToString } from "react-dom/server";
import fixture from "./fixtures/demo.json";
import type { InstanceSummary, Run } from "./api/types";
import { REQUIRED_FILES } from "./api/client";
import { PlanProvider } from "./state/plan";
import { Tabs } from "./RailPlan";
import { UploadDialog, inspect } from "./shell/UploadDialog";

const f = fixture as unknown as { instance: InstanceSummary; runs: Record<string, Run> };
let bad = 0;

const t = (label: string, ok: boolean, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
};

/* ------------------------------------------------------------ tabs ------- */

for (const scen of ["A", "B", "C"] as const) {
  let html = "";
  try {
    html = renderToString(
      <PlanProvider initial={{ instance: f.instance, run: f.runs[scen] }}>
        <Tabs />
      </PlanProvider>,
    );
  } catch (e) {
    t(`scenario ${scen} renders`, false, (e as Error).message);
    continue;
  }
  const probes = [
    "Operations overview", "Attention queue", "Run summary", "First week of work",
    "Schedule", "Ghost alternatives", "Contracts &amp; Activities", "Fragility",
    "Risk &amp; Resilience", "Where the schedule is most vulnerable", "What drives this score",
    "Ask RailPlan", "Common questions", "Side by side", "What if", "Stress tests",
    "Disruption Response", "Define disruption", "Contractor Requests", "Who could raise one",
    "Reports", "Submission bundle", "Document pack",
    "Load demand book",
  ];
  const missing = probes.filter((p) => !html.includes(p));
  t(`scenario ${scen} renders all nine tabs + upload entry`, missing.length === 0, missing.join(", "));
  for (const id of ["A036", "C006", "H01–H02"])
    t(`scenario ${scen} shows real id ${id}`, html.includes(id));
}

/* ---------------------------------------------------------- upload ------- */

const fake = (name: string, size = 1000) => new File([new Uint8Array(size)], name, { type: "text/csv" });

const all = inspect(REQUIRED_FILES.map((n) => fake(n)));
t("all eight CSVs are accepted", all.ready && all.missing.length === 0);

const short = inspect(REQUIRED_FILES.slice(0, 7).map((n) => fake(n)));
t("a missing file blocks upload", !short.ready && short.missing.length === 1, short.missing.join(","));

const junk = inspect([...REQUIRED_FILES.map((n) => fake(n)), fake("notes.txt")]);
t("an unexpected file blocks upload", !junk.ready && junk.unexpected.length === 1);

const zip = inspect([fake("instance.zip")]);
t("a single zip is accepted", zip.ready && zip.isZip);

const zipPlus = inspect([fake("instance.zip"), fake("01_LINES.csv")]);
t("zip mixed with loose files is blocked", !zipPlus.ready);

const huge = inspect(REQUIRED_FILES.map((n) => fake(n, 800_000)));
t("oversize selection is blocked", !huge.ready, `${Math.round(huge.bytes / 1024)} kB`);

try {
  const dialog = renderToString(
    <PlanProvider initial={{ instance: f.instance, run: f.runs.A }}>
      <UploadDialog onClose={() => {}} />
    </PlanProvider>,
  );
  t("upload dialog renders", dialog.includes("Load a demand book") && dialog.includes("Upload and solve"));
  t("dialog lists all eight required files", REQUIRED_FILES.every((n) => dialog.includes(n)));
} catch (e) {
  t("upload dialog renders", false, (e as Error).message);
}

console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
