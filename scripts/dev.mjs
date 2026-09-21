import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const vite = "node_modules/vite/bin/vite.js";
if (!existsSync(python) || !existsSync(vite)) {
  console.error("Install dependencies first: uv sync --extra test && npm ci");
  process.exit(1);
}

const children = new Set();
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  const exits = [...children].map(child => new Promise(resolve => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  }));
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  await Promise.all(exits);
  clearTimeout(force);
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

function start(label, command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  children.add(child);
  child.once("error", error => {
    children.delete(child);
    console.error(`${label} could not start: ${error.message}`);
    void stop(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped (${signal ?? code}). Stopping local development.`);
      void stop(code || 1);
    }
  });
  return child;
}

try {
  // Do not accidentally use an unrelated service already listening on our API port.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(8000, "127.0.0.1", () => probe.close(resolve));
  });
  const args = ["-m", "uvicorn", "trackaccess.api:app", "--host", "127.0.0.1", "--port", "8000"];
  if (existsSync(".env")) args.push("--env-file", ".env");
  const backend = start("Planning API", python, args);
  const deadline = Date.now() + 30_000;
  console.log("Starting the local planning API…");
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8000/api/health", {
        signal: AbortSignal.timeout(1000),
      });
      const health = response.ok ? await response.json() : null;
      ready = health?.ok === true && health?.validation === "local";
    } catch { /* The API may still be importing its dependencies. */ }
    if (ready) break;
    await delay(200);
  }
  if (!stopping) {
    if (!ready || backend.exitCode !== null) throw new Error("The planning API did not become ready within 30 seconds. Check its logs above.");
    console.log("Planning API ready at http://127.0.0.1:8000. Starting Vite…");
    start("Vite", process.execPath, [vite, "--host", "127.0.0.1", "--strictPort", ...process.argv.slice(2)]);
  }
} catch (error) {
  console.error(error.code === "EADDRINUSE"
    ? "Port 8000 is already in use. Stop the existing API, or use npm run dev:ui with that API."
    : error.message);
  await stop(1);
}
