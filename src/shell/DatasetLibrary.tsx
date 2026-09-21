import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { DatasetEntry } from "../api/types";
import { usePlanState } from "../state/plan";

export function DatasetLibrary({ onClose }: { onClose: () => void }) {
  const { instance, selectInstance } = usePlanState();
  const [books, setBooks] = useState<DatasetEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api.datasets(controller.signal).then(setBooks).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  const open = async (id: string) => {
    setOpening(id); setError("");
    try { await selectInstance(id); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not open the saved dataset."); }
    finally { setOpening(null); }
  };
  const matches = books.filter(book => `${book.name} ${book.id}`.toLowerCase().includes(query.toLowerCase()));
  return <div style={{ position: "fixed", inset: 0, zIndex: 45, background: "rgba(15,31,61,.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <section role="dialog" aria-modal="true" aria-labelledby="dataset-library-title" className="card" style={{ width: 760, maxWidth: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 18px 48px rgba(15,31,61,.28)" }}>
      <div style={{ padding: 18, borderBottom: "1px solid #e6e9ef" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><h2 id="dataset-library-title" className="h2" style={{ flex: 1 }}>Dataset library</h2><button className="btn btn-sm" onClick={onClose} disabled={!!opening}>Close library</button></div>
        <p className="small muted">Reopen a demand book, its approved plan and saved scenario versions. This public demo shares its library across visitors.</p>
        <input className="input" aria-label="Search saved datasets" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or dataset ID" style={{ width: "100%" }} />
      </div>
      <div style={{ overflow: "auto", padding: "4px 18px 18px" }}>
        {loading && <p role="status">Loading saved datasets…</p>}
        {error && <div role="alert" className="callout c-red">{error} <button className="btn btn-sm" onClick={() => setRetry(n => n + 1)}>Retry library</button></div>}
        {!loading && !error && !matches.length && <p className="small muted">{query ? "No datasets match this search." : "Upload a demand book to save it here."}</p>}
        {matches.map(book => <div key={book.id} style={{ padding: "14px 0", borderBottom: "1px solid #e6e9ef", display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}><strong style={{ overflowWrap: "anywhere" }}>{book.name}</strong>{instance?.id === book.id && <span className="pill p-info" style={{ marginLeft: 8 }}>Current</span>}
            <div className="small muted" style={{ marginTop: 5 }}>{book.activities} activities · {book.contracts} contracts · {book.horizon_weeks} weeks</div>
            <div className="small muted">{book.updated_at ? `Saved ${new Date(book.updated_at).toLocaleString()}` : "Previously saved dataset"} · <span className="mono">{book.id}</span></div>
          </div>
          <a className="btn btn-sm" href={`/api/instances/${book.id}/source`} download>Source ZIP</a>
          <button className="btn btn-sm btn-primary" disabled={!!opening} onClick={() => void open(book.id)}>{opening === book.id ? "Opening…" : "Open dataset"}</button>
        </div>)}
      </div>
    </section>
  </div>;
}
