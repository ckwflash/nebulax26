// Lets a works controller (or a judge) load their own demand book: the eight instance
// CSVs or a single ZIP of them. Uploads to /api/instances, solves, and rebinds the app.

import { useRef, useState } from "react";
import { REQUIRED_FILES, UPLOAD_LIMIT_BYTES } from "../api/client";
import type { ScenarioId } from "../api/types";
import { SCENARIO_LABEL, usePlanState } from "../state/plan";

const SCENARIOS: ScenarioId[] = ["A", "B", "C"];
const BUDGETS = [30, 60, 90, 150, 300];

interface Checked {
  files: File[];
  isZip: boolean;
  present: string[];
  missing: string[];
  unexpected: string[];
  bytes: number;
  ready: boolean;
}

/** Mirrors the server's rules so the user hears about a bad drop before uploading. */
export function inspect(files: File[]): Checked {
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const zips = files.filter((f) => f.name.toLowerCase().endsWith(".zip"));
  const isZip = zips.length > 0;

  if (isZip) {
    return {
      files,
      isZip: true,
      present: [],
      missing: [],
      unexpected: files.filter((f) => !f.name.toLowerCase().endsWith(".zip")).map((f) => f.name),
      bytes,
      ready: files.length === 1 && bytes <= UPLOAD_LIMIT_BYTES,
    };
  }

  const names = files.map((f) => f.name);
  const present = REQUIRED_FILES.filter((r) => names.includes(r));
  const missing = REQUIRED_FILES.filter((r) => !names.includes(r));
  const unexpected = names.filter((n) => !REQUIRED_FILES.includes(n));
  return {
    files,
    isZip: false,
    present,
    missing,
    unexpected,
    bytes,
    ready: missing.length === 0 && unexpected.length === 0 && bytes <= UPLOAD_LIMIT_BYTES,
  };
}

export function UploadDialog({ onClose }: { onClose: () => void }) {
  const { loadDemandBook, solving, solvingLabel, isSample, backToSample, instance } = usePlanState();
  const [picked, setPicked] = useState<Checked | null>(null);
  const [scenario, setScenario] = useState<ScenarioId>("C");
  const [seconds, setSeconds] = useState(90);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null) => {
    if (!list || !list.length) return;
    setFailure(null);
    setPicked(inspect([...list]));
  };

  const start = async () => {
    if (!picked?.ready) return;
    setFailure(null);
    try {
      await loadDemandBook(picked.files, scenario, seconds);
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The demand book could not be loaded.");
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(15,31,61,.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
    >
      <div
        className="card"
        style={{
          width: 620,
          maxHeight: "88%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 18px 48px rgba(15,31,61,.28)",
        }}
      >
        <div
          style={{
            padding: "16px 18px",
            borderBottom: "1px solid #e6e9ef",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="h2">Load a demand book</span>
            <span className="small muted">
              The eight instance CSVs, or one ZIP containing them. Solved here, on this machine.
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <button className="x-btn" onClick={onClose} aria-label="Close" disabled={solving}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div style={{ overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              take(e.dataTransfer.files);
            }}
            onClick={() => input.current?.click()}
            style={{
              border: `1.5px dashed ${dragging ? "#1d5fd1" : "#cfd5df"}`,
              background: dragging ? "#f2f6fd" : "#fbfcfd",
              borderRadius: 8,
              padding: "26px 18px",
              textAlign: "center",
              cursor: solving ? "default" : "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              alignItems: "center",
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5b6578" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4M7 9l5-5 5 5" />
              <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <span style={{ fontWeight: 600 }}>Drop the instance files here</span>
            <span className="small muted">or click to browse · CSV ×8, or a single .zip · 5 MB limit</span>
            <input
              ref={input}
              type="file"
              multiple
              accept=".csv,.zip"
              style={{ display: "none" }}
              onChange={(e) => take(e.target.files)}
            />
          </div>

          {!picked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="card-h">Expected files</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4 }}>
                {REQUIRED_FILES.map((name) => (
                  <span key={name} className="mono small muted" style={{ display: "flex", gap: 7 }}>
                    <span style={{ width: 12 }}>·</span>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {picked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="card-h">Selected</span>
                <div style={{ flex: 1 }} />
                <span className="small muted">
                  {picked.files.length} file{picked.files.length === 1 ? "" : "s"} ·{" "}
                  {Math.round(picked.bytes / 1024)} kB
                </span>
              </div>

              {picked.isZip ? (
                <div className="callout c-blue">
                  Archive <span className="mono">{picked.files[0]?.name}</span> — its contents are checked on the
                  server; anything that is not one of the eight expected files is ignored.
                  {picked.files.length > 1 && " Drop the ZIP on its own."}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4 }}>
                  {REQUIRED_FILES.map((name) => {
                    const ok = picked.present.includes(name);
                    return (
                      <div key={name} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
                        <span style={{ color: ok ? "#176842" : "#a12a22", fontWeight: 700, width: 12 }}>
                          {ok ? "✓" : "✕"}
                        </span>
                        <span className="mono" style={{ color: ok ? "#14213a" : "#5b6578" }}>
                          {name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {!!picked.unexpected.length && (
                <div className="callout c-amber">
                  Not part of a demand book, remove {picked.unexpected.length === 1 ? "it" : "them"}:{" "}
                  <span className="mono">{picked.unexpected.join(", ")}</span>
                </div>
              )}
              {picked.bytes > UPLOAD_LIMIT_BYTES && (
                <div className="callout c-red">
                  {Math.round(picked.bytes / 1024)} kB exceeds the 5 MB upload limit.
                </div>
              )}
            </div>
          )}

          <div className="divider" />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label htmlFor="up-scen">Scenario to solve</label>
              <select
                id="up-scen"
                className="input"
                style={{ height: 34 }}
                value={scenario}
                onChange={(e) => setScenario(e.target.value as ScenarioId)}
                disabled={solving}
              >
                {SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {s} — {SCENARIO_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="up-budget">Solve budget</label>
              <select
                id="up-budget"
                className="input"
                style={{ height: 34 }}
                value={String(seconds)}
                onChange={(e) => setSeconds(Number(e.target.value))}
                disabled={solving}
              >
                {BUDGETS.map((b) => (
                  <option key={b} value={String(b)}>
                    {b} seconds
                  </option>
                ))}
              </select>
            </div>
          </div>
          <span className="small muted">
            The other two scenarios can be solved afterwards from the switcher in the top bar.
          </span>

          {failure && <div className="callout c-red">{failure}</div>}
          {solving && (
            <div className="callout c-blue" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 600 }}>{solvingLabel || "Working…"}</span>
              <span className="small muted">
                Up to {seconds}s for the search. The page stays responsive; this dialog closes when it lands.
              </span>
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid #e6e9ef",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span className="small muted" style={{ flex: 1 }}>
            {picked?.ready
              ? "Ready to solve."
              : picked && !picked.isZip && picked.missing.length
                ? `${picked.missing.length} file${picked.missing.length === 1 ? "" : "s"} still missing.`
                : "Nothing selected yet."}
          </span>
          {!isSample && (
            <button
              className="btn btn-sm"
              onClick={() => {
                backToSample();
                onClose();
              }}
              disabled={solving}
              title={`Currently showing: ${instance?.name ?? "an uploaded book"}`}
            >
              Back to sample book
            </button>
          )}
          <button className="btn btn-sm" onClick={onClose} disabled={solving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={start} disabled={!picked?.ready || solving}>
            {solving ? "Solving…" : "Upload and solve"}
          </button>
        </div>
      </div>
    </div>
  );
}
