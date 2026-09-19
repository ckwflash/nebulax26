// Thin typed client. Paths are relative so the Vite proxy (/api -> 127.0.0.1:8000)
// and the deployed build both work without configuration.

import type {
  ChatReply,
  DemoPayload,
  HealthReply,
  InstanceSummary,
  Override,
  Run,
  ScenarioId,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch {
    throw new ApiError("The planning service is not reachable.", 0);
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => call<HealthReply>("/api/health"),
  demo: () => call<DemoPayload>("/api/demo"),
  instance: (id: string) => call<InstanceSummary>(`/api/instances/${id}`),
  run: (id: string) => call<Run>(`/api/runs/${id}`),
  startRun: (body: {
    instance_id: string;
    scenario: ScenarioId;
    seconds?: number;
    baseline_id?: string | null;
    overrides?: Override[];
    label?: string;
  }) => call<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  chat: (body: { instance_id: string; run_id: string; message: string }) =>
    call<ChatReply>("/api/chat", { method: "POST", body: JSON.stringify(body) }),
};

/** Poll a queued run until it leaves the queue, or the caller aborts. */
export async function waitForRun(
  id: string,
  { signal, intervalMs = 900 }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<Run> {
  for (;;) {
    const run = await api.run(id);
    if (run.status !== "queued" && run.status !== "running") return run;
    if (signal?.aborted) return run;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
