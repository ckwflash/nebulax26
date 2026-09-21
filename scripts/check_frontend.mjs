import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const checks = [
  "/src/data/adapt.check.ts",
  "/src/render.check.tsx",
  "/src/state/handoff.check.tsx",
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
    await server.ssrLoadModule(process.argv[2]);
  } finally {
    await server.close();
  }
}
