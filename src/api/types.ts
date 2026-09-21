// Wire shapes returned by trackaccess/api.py. Kept deliberately close to the Python
// models (domain.py summary(), validation.py validate(), api.py run records) so a
// backend change shows up here as a type error rather than a blank panel.

export type ScenarioId = "A" | "B" | "C";

export interface ProjectRow {
  contract_number: string;
  contract_description: string;
  contract_award_date: string;
  activity_type: string;
  nature_of_activity: string;
  contract_priority: 1 | 2 | 3;
  contract_completion_date: string;
  planned_completion_date: string;
  number_of_workfronts: number;
  access_type: "PM" | "PC" | "C";
  number_of_maximum_access_per_week: number;
  /** Not in 07_PROJECT_DETAILS.csv today; read if the backend adds it. */
  contractor?: string;
}

export interface ActivityRow {
  activity_id: string;
  contract_number: string;
  activity_type: string;
  start_location_id: string;
  end_location_id: string;
  total_accesses: number;
  planned_start_date: string;
  predecessor_activity_id: string;
  activity_priority: 1 | 2 | 3;
  /** Added by summary(): every location the work occupies, and its protected footprint. */
  route: string[];
  protected: string[];
  start_week: number;
}

export interface LocationRow {
  id: string;
  capacity: number;
}

export interface StationRow {
  station_id: string;
  line_code: string;
  seq: string;
  is_interchange: string;
}

export interface LineRow {
  line_code: string;
  line_name: string;
}

export interface BoundDetail {
  activity_id: string;
  contract_number: string;
  standard_accesses: number;
  available_weeks: number;
  minimum_overrun_days: number;
  minimum_eclo: number;
  deadline_feasible_with_eclo: boolean;
  evidence_id: string;
}

export interface InstanceSummary {
  id: string;
  name: string;
  horizon_start: string;
  horizon_weeks: number;
  total_workload: number;
  projects: ProjectRow[];
  activities: ActivityRow[];
  locations: LocationRow[];
  lines: LineRow[];
  stations: StationRow[];
  bounds: {
    A: number;
    B: number;
    minimum_b_eclo: number;
    details: BoundDetail[];
    note: string;
  };
}

export interface AccessRow {
  activity_id: string;
  access_seq: number;
  week: number;
  eclo: 0 | 1;
  access_night: number;
}

export interface OccupancyRow {
  activity_id: string;
  week: number;
  location_id: string;
  co_share_group: string;
}

export interface CompletionRow {
  scenario: ScenarioId;
  contract_number: string;
  simulated_completion_date: string;
  overrun_days: number;
}

export interface ScheduleDoc {
  scenario: ScenarioId;
  access: AccessRow[];
  occupancy: OccupancyRow[];
  results: CompletionRow[];
  /** Local sidecar: "<activity>:<week>" -> synchronized opportunity (1-based). */
  witness: Record<string, number>;
}

export interface CapacityRow {
  location_id: string;
  week: number;
  used: number;
  capacity: number;
  excess: number;
  evidence_id: string;
}

export interface ContractResult {
  contract_number: string;
  completion_week: number;
  simulated_completion_date: string;
  planned_completion_date: string;
  overrun_days: number;
  priority: 1 | 2 | 3;
  evidence_id: string;
}

export interface Violation {
  rule: string;
  severity: string;
  detail: string;
  activity_id?: string;
  other_activity?: string;
}

export interface SoftScores {
  scenario?: ScenarioId;
  priority_weighted_score: number;
  overrun_days_total: number;
  contracts_overrunning: number;
  earliness_days_total?: number;
  priority_overrun: Record<"1" | "2" | "3", number>;
  excess_access_nights_total: number;
  eclo_nights_total: number;
  objective_score?: number;
  formula_version?: string;
}

export interface ValidationReport {
  scenario: ScenarioId;
  feasible: boolean;
  structurally_valid: boolean;
  safety_verified: boolean;
  validation_authority: string;
  rule_version: string;
  hard_violations: Violation[];
  warnings: string[];
  score: number;
  coverage_percent: number;
  completed_activities: number;
  total_activities: number;
  soft_scores: SoftScores;
  contracts: ContractResult[];
  capacity: CapacityRow[];
  eclo_windows: Record<string, [number, number]>;
  sharing_saved: number;
  detail?: {
    capacity_hotspots: CapacityRow[];
    nights_scheduled: number;
    eclo_nights: number;
  };
}

export interface Override {
  location_id: string;
  week: number;
  capacity: number;
  closed: boolean;
}

export interface RunDiff {
  changed_activities: string[];
  removed_accesses: number;
  added_accesses: number;
  score_delta: number | null;
}

export interface Run {
  id: string;
  instance_id: string;
  scenario: ScenarioId;
  status: "queued" | "running" | "completed" | "failed" | "no_solution";
  label: string;
  created_at: string;
  overrides: Override[];
  baseline_id: string | null;
  schedule: ScheduleDoc | null;
  validation: ValidationReport | null;
  solver_status?: string;
  elapsed_seconds?: number;
  model_bound: number | null;
  message?: string;
  error?: string;
  diff?: RunDiff;
  bookings?: Booking[];
  philosophy?: Philosophy | null;
  optimization?: {
    philosophy: Philosophy;
    weights: Weights | null;
    proven_optimal: boolean;
    stages: {
      name: string;
      status: string;
      value: number | null;
      bound: number | null;
    }[];
  };
}

export interface DemoPayload {
  instance: InstanceSummary;
  run: Run;
}

export interface DatasetEntry {
  id: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  activities: number;
  contracts: number;
  horizon_weeks: number;
  total_workload: number;
}
export interface SavedRun {
  id: string;
  instance_id: string;
  scenario: ScenarioId;
  status: Run["status"];
  label: string;
  created_at: string;
  has_schedule: boolean;
  feasible: boolean;
  score: number | null;
  solver_status: string | null;
  error?: string | null;
  message?: string | null;
}
export interface DatasetHistory {
  instance_id: string;
  versions: SavedRun[];
  latest: Partial<Record<ScenarioId, Run>>;
}
export interface ScenarioBatch {
  id: string;
  instance_id: string;
  status: Run["status"];
  children: Run[];
}

/** conversation.py emits {id, title, detail} plus the ids the row came from. */
export interface ChatEvidence {
  id: string;
  title: string;
  detail: string;
  contract_number?: string;
  activity_id?: string;
  location_id?: string;
  week?: number;
}

export interface ChatReply {
  answer: string;
  evidence: ChatEvidence[];
  mode: string;
  notice?: string | null;
  run_id: string;
  preview?: Run | null;
  tool?: string;
}

export interface HealthReply {
  ok: boolean;
  validation: string;
  chat_configured: boolean;
  chat_provider: string;
  chat_model: string | null;
}

export type Philosophy = "churn" | "deadlines" | "passengers" | "p1" | "custom";
export interface Weights {
  churn: number;
  deadlines: number;
  passengers: number;
  priority1: number;
}
export interface Booking {
  request_id: string;
  activity_id: string;
  week_from: number;
  week_to: number;
}
export interface ApprovedPlan {
  instance_id: string;
  approved_run_id: string | null;
  revision: number;
  commitments: Booking[];
  run: Run | null;
}
export interface RecoveryBatch {
  id: string;
  status: Run["status"];
  baseline_id: string;
  remaining_seconds: number;
  results: { philosophy: Philosophy; run: Run; policy: { label: string; scenario: ScenarioId; guarantees: string[]; objectives: string[] } }[];
  error?: string;
}
export interface ContractorRequest {
  id: string;
  instance_id: string;
  contract_number: string;
  activity_id: string;
  location_id: string;
  week_from: number;
  week_to: number;
  reason: string;
  contractor: string;
  status: "pending" | "countered" | "accepted" | "rejected";
  assessment_id: string | null;
  counteroffer_run_id?: string;
  accepted_run_id?: string;
}
export interface Assessment {
  id: string;
  status: Run["status"];
  baseline_id: string;
  plan_revision: number;
  stale: boolean;
  capacity_before: number | null;
  capacity_after: number | null;
  displaced: {
    activity_id: string;
    contract_number: string;
    effect: string;
    priority: number;
  }[];
  options: {
    kind: "REQUESTED" | "ALTERNATIVE";
    run_id: string;
    week_from: number;
    week_to: number;
    feasible: boolean;
    run: Run;
  }[];
  draft_response: string;
  error?: string;
}

/** GET /api/reports — one entry of the document-pack catalogue. */
export interface ReportEntry {
  id: string;
  name: string;
  audience: string;
  description: string;
  format: "PDF" | "XLSX" | "HTML" | "CSV";
  size_hint: string;
  generated_at: string | null;
}

export interface ReportGenerated {
  download_url: string;
  generated_at: string;
}
