// Thin typed client. Paths are relative so the Vite proxy (/api -> 127.0.0.1:8000)
// and the deployed build both work without configuration.

import type {
  ReportEntry,
  ReportGenerated,
  DatasetEntry,
  DatasetHistory,
  ScenarioBatch,
  ApprovedPlan,
  Assessment,
  ContractorRequest,
  RecoveryBatch,
  Weights,
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
  const isForm = init?.body instanceof FormData;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body && !isForm
        ? { "content-type": "application/json", ...init?.headers }
        : init?.headers,
    });
  } catch (e) {
    if (init?.signal?.aborted) throw e;
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
  reports: () => call<ReportEntry[]>("/api/reports"),
  generateReport: (id: string, runId: string) =>
    call<ReportGenerated>(`/api/reports/${id}/generate`, {
      method: "POST", body: JSON.stringify({ run_id: runId }),
    }),
  uploadInstance: (files: File[], name?: string) => {
    const form = new FormData();
    if (name?.trim()) form.append("name", name.trim());
    for (const file of files) form.append("files", file, file.name);
    return call<InstanceSummary>("/api/instances", { method: "POST", body: form });
  },
  health: () => call<HealthReply>("/api/health"),
  demo: () => call<DemoPayload>("/api/demo"),
  instance: (id: string) => call<InstanceSummary>(`/api/instances/${id}`),
  datasets: (signal?: AbortSignal) => call<DatasetEntry[]>("/api/instances", { signal }),
  history: (id: string, signal?: AbortSignal) => call<DatasetHistory>(`/api/instances/${id}/history`, { signal }),
  solveAll: (id: string, requestId: string) => call<ScenarioBatch>(`/api/instances/${id}/solve-all`, {
    method: "POST", body: JSON.stringify({ client_request_id: requestId, seconds: 90 }),
  }),
  run: (id: string, signal?: AbortSignal) =>
    call<Run>(`/api/runs/${id}`, { signal }),
  plan: (id: string) => call<ApprovedPlan>(`/api/instances/${id}/plan`),
  adopt: (id: string, runId: string, plan: ApprovedPlan) =>
    call<ApprovedPlan>(`/api/instances/${id}/plan/adopt`, {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        expected_approved_run_id: plan.approved_run_id,
        expected_revision: plan.revision,
      }),
    }),
  improve: (id: string) =>
    call<Run>(`/api/runs/${id}/improve`, {
      method: "POST",
      body: JSON.stringify({ seconds: 300 }),
    }),
  recover: (body: {
    instance_id: string;
    scenario: ScenarioId;
    baseline_id: string;
    overrides: Override[];
    weights: Weights;
  }) =>
    call<RecoveryBatch>("/api/disruptions/recoveries", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  recovery: (id: string, signal?: AbortSignal) =>
    call<RecoveryBatch>(`/api/disruptions/recoveries/${id}`, { signal }),
  requests: (id: string) =>
    call<ContractorRequest[]>(`/api/requests?instance_id=${id}`),
  createRequest: (
    body: Pick<
      ContractorRequest,
      | "instance_id"
      | "contract_number"
      | "activity_id"
      | "location_id"
      | "week_from"
      | "week_to"
      | "reason"
      | "contractor"
    >,
  ) =>
    call<ContractorRequest>("/api/requests", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  assess: (id: string) =>
    call<Assessment>(`/api/requests/${id}/assessment`, {
      method: "POST",
      body: JSON.stringify({ seconds: 90 }),
    }),
  assessment: (id: string, signal?: AbortSignal) =>
    call<Assessment>(`/api/requests/${id}/assessment`, { signal }),
  decide: (
    id: string,
    decision: "accepted" | "countered" | "rejected",
    runId: string | null,
    plan: ApprovedPlan,
  ) =>
    call<{ request: ContractorRequest; plan: ApprovedPlan }>(
      `/api/requests/${id}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          decision,
          run_id: runId,
          expected_approved_run_id: plan.approved_run_id,
          expected_revision: plan.revision,
        }),
      },
    ),
  startRun: (body: {
    instance_id: string;
    scenario: ScenarioId;
    seconds?: number;
    baseline_id?: string | null;
    overrides?: Override[];
    label?: string;
  }) => call<Run>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  chat: (body: { instance_id: string; run_id: string; message: string }) =>
    call<ChatReply>("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Poll a queued run until it leaves the queue, or the caller aborts. */
export async function waitForRun(
  id: string,
  {
    signal,
    intervalMs = 900,
  }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<Run> {
  for (;;) {
    signal?.throwIfAborted();
    const run = await api.run(id, signal);
    if (run.status !== "queued" && run.status !== "running") return run;
    signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
