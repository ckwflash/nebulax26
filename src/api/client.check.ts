import { api, ApiError } from "./client";

function check(ok: unknown, message: string) { if (!ok) throw new Error(message); }
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected the request to fail");
}
const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
let expire!: () => void;
globalThis.setTimeout = ((callback: () => void, ms?: number) => {
  check(ms === 30_000, "Requests must have a 30-second deadline");
  expire = callback;
  return originalTimeout(callback, ms);
}) as typeof setTimeout;

try {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const offline = await failure(api.demo());
  check(offline instanceof ApiError && offline.status === 0, "Connection errors must be actionable API errors");

  globalThis.fetch = async () => new Response("", { status: 500 });
  const proxy = await failure(api.demo());
  check(proxy instanceof ApiError && proxy.status === 500 && proxy.message.includes("planning service"), "Empty proxy errors need a useful message");

  globalThis.fetch = async () => Response.json({ detail: "Demand book not found" }, { status: 404 });
  const missing = await failure(api.instance("missing"));
  check(missing instanceof ApiError && missing.status === 404 && missing.message === "Demand book not found", "API status and detail must survive");

  const hang: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
  globalThis.fetch = hang;
  const timed = failure(api.demo());
  expire();
  const timeout = await timed;
  check(timeout instanceof ApiError && timeout.status === 408, "A stalled demo request must time out");

  const controller = new AbortController();
  const cancelled = failure(api.demo(controller.signal));
  controller.abort();
  const aborted = await cancelled;
  check(aborted instanceof DOMException && aborted.name === "AbortError", "Caller cancellation must not become a service error");
  globalThis.fetch = async () => { throw new Error("An already cancelled request must not be sent"); };
  check(await failure(api.demo(controller.signal)) === controller.signal.reason, "Already aborted requests must stop before fetching");

  // A response can arrive while its JSON body remains stalled.
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }),
  }) as Response;
  const body = failure(api.demo());
  await Promise.resolve();
  expire();
  const stalledBody = await body;
  check(stalledBody instanceof ApiError && stalledBody.status === 408, "The deadline must cover reading the response body");
  console.log("ok   API client: connection failure, proxy error, API detail, request/body timeout, cancellation");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimeout;
}
