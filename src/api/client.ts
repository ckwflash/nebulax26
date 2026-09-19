// Thin typed client. Paths are relative so the Vite proxy (/api -> 127.0.0.1:8000)
// and the deployed build both work without configuration.

import type {
  ChatReply,
  DemoPayload,
  HealthReply,
  InstanceSummary,
  Override,
  ReportEntry,
  ReportGenerated,
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
  // FormData must keep the browser's own multipart boundary, so only JSON bodies
  // get an explicit content-type.
  const isForm = init?.body instanceof FormData;
  try {
    response = await fetch(path, {
      ...init,
      headers:
        init?.body && !isForm ? { "content-type": "application/json", ...init?.headers } : init?.headers,
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

/** The eight files the demand book must contain (domain.py FILES). */
export const REQUIRED_FILES = [
  "01_LINES.csv",
  "02_STATIONS.csv",
  "03_SECTORS.csv",
  "04_LOCATION_SUPPLY.csv",
  "05_BUFFER_LOCATION.csv",
  "06_PARAMETERS.csv",
  "07_PROJECT_DETAILS.csv",
  "08_ACTIVITY_DETAILS.csv",
];

export const UPLOAD_LIMIT_BYTES = 5_000_000;

export const api = {
  health: () => call<HealthReply>("/api/health"),
  demo: () => call<DemoPayload>("/api/demo"),
  instance: (id: string) => call<InstanceSummary>(`/api/instances/${id}`),
  uploadInstance: (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return call<InstanceSummary>("/api/instances", { method: "POST", body: form });
  },
  run: (id: string) => call<Run>(`/api/runs/${id}`),
  startRun: (body: {
    instance_id: string;
    scenario: ScenarioId;
    seconds?: number;
    baseline_id?: string | null;
    overrides?: Override[];
    label?: string;
  }) => call<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  reports: () => call<ReportEntry[]>("/api/reports"),
  generateReport: (id: string, runId: string) =>
    call<ReportGenerated>(`/api/reports/${id}/generate`, { method: "POST", body: JSON.stringify({ run_id: runId }) }),
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
