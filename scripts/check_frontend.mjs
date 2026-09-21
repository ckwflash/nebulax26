import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
const checks = [
  "/src/api/client.check.ts",
  "/src/data/adapt.check.ts",
  "/src/data/stress.check.ts",
  "/src/render.check.tsx",
  "/src/state/handoff.check.tsx",
  "/src/state/scenario.check.tsx",
  "/src/state/startup.check.tsx",
  "/src/state/stress.check.tsx",
];
if (!process.argv[2]) {
  for (const check of checks)
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), check], {
      stdio: "inherit",
    });
} else {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    // These SSR checks do not need a browser scan racing the server shutdown.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const checked = await server.ssrLoadModule(process.argv[2]);
    if (process.env.STRESS_CASES_PATH && checked.stressCases)
      writeFileSync(process.env.STRESS_CASES_PATH, JSON.stringify(checked.stressCases));
  } finally {
    await server.close();
  }
}
