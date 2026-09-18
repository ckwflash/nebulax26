import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity as Pulse, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Columns3, FileUp, GitCompareArrows, Layers3, LoaderCircle, MessageSquareText, MoreHorizontal, Play, Plus, RotateCcw, Send, ShieldCheck, SlidersHorizontal, Sparkles, TrainFront, TriangleAlert, X } from 'lucide-react';
import type { Activity, Capacity, ChatMessage, Evidence, Instance, Run, Scenario } from './types';

const policies = { A: { name: 'Protect access', description: 'Fixed capacity · flexible deadlines' }, B: { name: 'Protect deadlines', description: 'Fixed deadlines · flexible capacity' }, C: { name: 'Balance both', description: 'Limited capacity flexibility · selective ECLO' } };
const fmt = (n:number) => new Intl.NumberFormat('en', {maximumFractionDigits:1}).format(n);
const dateLabel = (date:string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
const weekDate = (instance:Instance, week:number) => { const d = new Date(`${instance.horizon_start}T12:00:00`); d.setDate(d.getDate()+(week-1)*7); return d; };
async function api<T>(path:string, options?:RequestInit):Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) { const data = await response.json().catch(()=>({})); throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}). Check the input and try again.`); }
  return response.json();
}

export default function App() {
  const [instance,setInstance] = useState<Instance|null>(null);
  const [runs,setRuns] = useState<Record<string,Run>>({});
  const [activeId,setActiveId] = useState('');
  const [scenario,setScenario] = useState<Scenario>('A');
  const [page,setPage] = useState<'timeline'|'capacity'|'compare'|'checks'>('timeline');
  const [selected,setSelected] = useState<string|null>(null);
  const [priority,setPriority] = useState('all');
  const [line,setLine] = useState('all');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [previewId,setPreviewId] = useState('');
  const [pendingId,setPendingId] = useState('');
  const [modal,setModal] = useState<'upload'|'capacity'|null>(null);
  const [location,setLocation] = useState('');
  const [week,setWeek] = useState(22);
  const [capacity,setCapacity] = useState(0);
  const [modelConfigured,setModelConfigured] = useState(false);
  const [messages,setMessages] = useState<ChatMessage[]>([{role:'assistant',text:'Your demand book, with the reasoning attached. Ask about a contract, inspect a constraint, or preview a different plan.'}]);
  const [question,setQuestion] = useState('');
  const [chatBusy,setChatBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const run = runs[activeId];
  const report = run?.validation;
  const preview = runs[previewId];
  const pending = runs[pendingId];
  const solving = !!pending && ['queued','running'].includes(pending.status);

  useEffect(()=>{
    let alive = true;
    (async()=>{
      try {
        const demo = await api<{instance:Instance;run:Run}>('/api/demo');
        const savedInstance = localStorage.getItem('nightshift-instance');
        const loaded = savedInstance && savedInstance !== demo.instance.id ? await api<Instance>(`/api/instances/${savedInstance}`).catch(()=>demo.instance) : demo.instance;
        const ids:string[] = JSON.parse(localStorage.getItem(`nightshift-runs-${loaded.id}`)||'[]');
        const restored = await Promise.all(ids.slice(-15).map(id=>api<Run>(`/api/runs/${id}`).catch(()=>null)));
        if (!alive) return;
        const all:Record<string,Run> = loaded.id===demo.instance.id ? {[demo.run.id]:demo.run} : {};
        restored.forEach(r=>{if(r && r.instance_id===loaded.id) all[r.id]=r;});
        const saved = localStorage.getItem(`nightshift-active-${loaded.id}`);
        const chosen = saved && all[saved]?.schedule ? saved : Object.keys(all).find(id=>all[id].schedule)||'';
        setInstance(loaded);setRuns(all);setActiveId(chosen);setScenario(all[chosen]?.scenario||'A');
        setLocation(loaded.locations.find(l=>l.id.includes('H01_H02'))?.id||loaded.locations[0].id);
        setWeek(Math.min(22,loaded.horizon_weeks));
        const health = await api<{chat_configured:boolean}>('/api/health');
        if(alive) setModelConfigured(health.chat_configured);
      } catch(e) {if(alive)setError((e as Error).message);}
    })();
    return ()=>{alive=false;};
  },[]);

  const unfinished = Object.values(runs).filter(r=>['queued','running'].includes(r.status)).map(r=>r.id).sort().join(',');
  useEffect(()=>{
    if(!unfinished) return;
    let alive=true;
    const poll = async()=>{
      for(const id of unfinished.split(',')) {
        try {const updated=await api<Run>(`/api/runs/${id}`);if(alive)setRuns(old=>({...old,[id]:updated}));}
        catch(e){if(alive)setError((e as Error).message);}
      }
    };
    const timer=setInterval(poll,1500);void poll();
    return ()=>{alive=false;clearInterval(timer);};
  },[unfinished]);
  useEffect(()=>{
    if(pending?.status==='completed' && pending.schedule){setActiveId(pending.id);setScenario(pending.scenario);setPendingId('');}
    if(pending && ['failed','no_solution'].includes(pending.status)){setError(pending.error||pending.message||'No complete schedule found. Try a longer search.');setPendingId('');}
  },[pending]);
  useEffect(()=>{
    if(instance){localStorage.setItem('nightshift-instance',instance.id);localStorage.setItem(`nightshift-runs-${instance.id}`,JSON.stringify(Object.keys(runs).filter(id=>!id.startsWith('reference-')&&!id.startsWith('public-'))));if(activeId)localStorage.setItem(`nightshift-active-${instance.id}`,activeId);}
  },[instance,runs,activeId]);
  useEffect(()=>{if(modal)dialog.current?.showModal();else dialog.current?.close();},[modal]);
  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:'smooth',block:'nearest'});},[messages,chatBusy]);

  const selectedActivities = useMemo(()=>instance?.activities.filter(a=>a.contract_number===selected)||[],[instance,selected]);
  const work = useMemo(()=>{
    const map:Record<string,typeof run.schedule.access>={};
    for(const row of run?.schedule?.access||[]) (map[row.activity_id]??=[]).push(row);
    return map;
  },[run]);

  function evidenceClick(e:Evidence) {
    if(e.contract_number){setSelected(e.contract_number);setPriority('all');setPage('timeline');}
    if(e.location_id){setLocation(e.location_id);setWeek(e.week||week);setPage('capacity');setLine('all');}
  }
  async function start(s:Scenario=scenario,seconds=60,isPreview=false,overrides:unknown[]=[]) {
    if(!instance)return;
    setBusy(true);setError('');
    try {
      const result=await api<Run>('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instance_id:instance.id,scenario:s,seconds,baseline_id:run?.schedule?run.id:null,overrides,label:isPreview?`Preview · ${s}`:`Scenario ${s}`})});
      setRuns(old=>({...old,[result.id]:result}));
      if(isPreview)setPreviewId(result.id);else{setPendingId(result.id);setScenario(s);}
      setModal(null);
    } catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  async function ask(text=question) {
    if(!instance||!run?.schedule||!text.trim()||chatBusy)return;
    setMessages(old=>[...old,{role:'user',text}]);setQuestion('');setChatBusy(true);
    try {
      const response=await api<{answer:string;evidence:Evidence[];mode:string;notice?:string;preview?:Run;run_id:string}>('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instance_id:instance.id,run_id:run.id,message:text})});
      setMessages(old=>[...old,{role:'assistant',text:response.answer,evidence:response.evidence,mode:response.mode,notice:response.notice,run_id:response.run_id}]);
      if(response.preview){const p=response.preview;setRuns(old=>({...old,[p.id]:p}));setPreviewId(p.id);}
    } catch(e){setMessages(old=>[...old,{role:'assistant',text:(e as Error).message}]);}finally{setChatBusy(false);}
  }
  async function upload(files:FileList|null) {
    if(!files?.length)return;
    setBusy(true);setError('');
    const body=new FormData();Array.from(files).forEach(f=>body.append('files',f));
    try {const loaded=await api<Instance>('/api/instances',{method:'POST',body});setInstance(loaded);setRuns({});setActiveId('');setSelected(null);setPreviewId('');setPendingId('');setLocation(loaded.locations[0].id);setWeek(Math.min(22,loaded.horizon_weeks));setModal(null);setMessages([{role:'assistant',text:`Loaded ${loaded.activities.length} activities and ${loaded.total_workload} work units. Run the planner to create a schedule, then ask me about its decisions.`}]);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }

  if(!instance) return <div className="boot"><div className="brand-symbol"><TrainFront size={25}/></div><h1>Nightshift</h1>{error?<><p role="alert">{error}</p><button className="primary" onClick={()=>window.location.reload()}>Retry connection</button><p className="muted">Start the API on port 8000 and the app on port 5173.</p></>:<><LoaderCircle className="spin"/><p>Opening the planning desk…</p></>}</div>;
  const weekNumbers=Array.from({length:instance.horizon_weeks},(_,i)=>i+1);
  const projects=instance.projects.filter(p=>priority==='all'||p.contract_priority===Number(priority));
  const title={timeline:'The access plan',capacity:'Where access gets tight',compare:'Every trade-off, visible',checks:'The evidence behind the plan'}[page];

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e=>{e.preventDefault();setPage('timeline');}}><span className="brand-symbol"><TrainFront size={22}/></span><span>nightshift<span className="brand-sub">POSSESSION CONTROL</span></span></a>
      <div className="workspace-label">PLANNING WORKSPACE</div>
      <nav aria-label="Workspace">
        {([{key:'timeline',label:'Access plan',icon:Columns3},{key:'capacity',label:'Capacity board',icon:Layers3},{key:'compare',label:'Scenario comparison',icon:GitCompareArrows},{key:'checks',label:'Validation',icon:ShieldCheck}] as const).map(item=><button key={item.key} className={`nav-item ${page===item.key?'active':''}`} onClick={()=>setPage(item.key)}><item.icon size={18}/>{item.label}{item.key==='checks'&&report?.feasible&&<span className="nav-dot"/>}</button>)}
      </nav>
      <div className="sidebar-divider"/>
      <div className="workspace-label">YOUR DEMAND BOOK</div>
      <div className="book-name"><span className="file-icon"><Layers3 size={17}/></span><div>{instance.name.startsWith('NebulaX')?'NebulaX public instance':'Uploaded instance'}<small>{instance.activities.length} activities · {instance.projects.length} contracts</small></div></div>
      <button className="sidebar-upload" onClick={()=>setModal('upload')}><Plus size={16}/> Upload demand book</button>
      <div className="sidebar-bottom"><div className="shift-note"><Clock3 size={17}/><span>Ready for the night shift.<small>Every access accounted for.</small></span></div><div className="connection"><span/>Planner connected <span className="version">v0.1</span></div></div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumbs">Network operations <ChevronRight size={13}/> <strong>Access planning</strong></div><span className="horizon-label"><span className="status-dot"/> {instance.horizon_weeks}-week planning horizon</span></header>
      {error&&<div className="error-banner" role="alert"><TriangleAlert size={18}/><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}
      <div className="page-heading"><div><div className="eyebrow">{weekDate(instance,1).getFullYear()} / DUAL-LINE OPERATIONS</div><h1>{title}<span>.</span></h1><p>{page==='timeline'?'Make room for the work that keeps the network moving.':page==='capacity'?'Inspect possessions, co-sharing and the cost of extra access.':page==='compare'?'Compare the policies on the same demand book.':"Complete workloads. Explicit checks. Traceable decisions."}</p></div><button className="export-button" disabled={!report?.feasible} onClick={()=>window.location.assign(`/api/runs/${run.id}/export`)}><ArrowDownToLine size={16}/><span>Export schedule</span></button></div>

      <div className="network-strip"><div className="network-label"><span className="eyebrow">THE NETWORK</span><strong>Two lines.<br/>One coordinated plan.</strong><span className="network-key"><i className="alpha"/> Alpha <i className="beta"/> Beta</span></div><div className="network-lines">{instance.lines.map((l,index)=><div className={`network-line ${index?'beta':'alpha'}`} key={l.line_code}><span className="line-code">{l.line_code}</span><div className="station-track">{instance.stations.filter(s=>s.line_code===l.line_code).sort((a,b)=>Number(a.seq)-Number(b.seq)).map(s=><div className={`station ${s.is_interchange==='1'?'hub':''}`} key={s.station_id}><span className="station-node"/><span>{s.station_id}</span></div>)}</div><span className="direction">EB / WB</span></div>)}</div></div>

      <section className="policy-bar" aria-label="Scenario policy"><div className="scenario-tabs">{(['A','B','C'] as Scenario[]).map(s=><button key={s} className={scenario===s?'selected':''} onClick={()=>{setScenario(s);const existing=Object.values(runs).filter(r=>r.scenario===s&&r.schedule&&r.id!==previewId).at(-1);if(existing){setActiveId(existing.id);setSelected(null);}}}><span>{s}</span><div>{policies[s].name}<small>{s==='A'?'Strict supply':s==='B'?'Strict schedule':'Balanced'}</small></div></button>)}</div><div className="solve-controls"><button className="primary" disabled={busy||solving} onClick={()=>void start()}>{busy||solving?<LoaderCircle size={16} className="spin"/>:<Play size={15} fill="currentColor"/>}{solving?'Planning…':'Run planner'}</button><button className="icon-button improve" title="Improve for up to five minutes" aria-label="Improve for five minutes" disabled={busy||solving||!run?.schedule} onClick={()=>void start(scenario,300)}><RotateCcw size={16}/></button></div></section>
      {solving&&<div className="solve-status" role="status"><Pulse size={15}/><span>{pending.status==='queued'?'Run queued':'Searching for the best complete schedule'}{pending.validation?` · current penalty ${fmt(pending.validation.score)}`:''}</span><span>{pending.elapsed_seconds?`${pending.elapsed_seconds}s`:''}</span></div>}
      {run&&scenario!==run.scenario&&<div className="info-banner">Showing saved Scenario {run.scenario}. Run the planner to compute Scenario {scenario}: {policies[scenario].description.toLowerCase()}.</div>}

      {preview&&<section className="preview-banner" aria-live="polite"><div className="preview-icon"><GitCompareArrows size={20}/></div><div><strong>{preview.status==='completed'?'A new plan is ready to review':preview.status==='failed'||preview.status==='no_solution'?'Preview needs attention':'Computing your preview…'}</strong><p>{preview.diff?`${preview.diff.changed_activities.length} activities changed · penalty ${fmt(preview.validation!.score)} (${preview.diff.score_delta>0?'+':''}${fmt(preview.diff.score_delta)})`:preview.error||preview.message||'Your current schedule remains selected.'}</p></div><div className="preview-actions">{preview.schedule&&<button className="secondary" onClick={()=>{setPage('compare');}}>Compare</button>}{preview.status==='completed'&&preview.validation?.feasible&&<button className="primary" onClick={()=>{setActiveId(preview.id);setScenario(preview.scenario);setPreviewId('');setSelected(null);}}>Adopt preview <Check size={15}/></button>}<button className="icon-button" aria-label="Dismiss preview" onClick={()=>setPreviewId('')}><X size={16}/></button></div></section>}

      {report?<>
        <section className="metrics" aria-label="Schedule metrics">
          <div className="metric"><span>Work delivered <CheckCheck size={15}/></span><strong>{fmt(report.coverage_percent)}<em>%</em></strong><small>{report.completed_activities} / {report.total_activities} activities complete</small></div>
          <div className="metric"><span>Schedule penalty <Pulse size={15}/></span><strong>{fmt(report.score)}<em>pts</em></strong><small>{run.model_bound!=null?`Model bound ${fmt(run.model_bound)} · ${run.solver_status==='OPTIMAL'?'optimal in local model':'improving'}`:'Lower is better · local scoring'}</small></div>
          <div className="metric"><span>Completion overrun <Clock3 size={15}/></span><strong>{report.soft_scores.overrun_days_total}<em>days</em></strong><small>Across {report.soft_scores.contracts_overrunning} contracts</small></div>
          <div className="metric"><span>Access flexibility <SlidersHorizontal size={15}/></span><strong>{report.soft_scores.eclo_nights_total}<em>ECLO</em><span className="metric-slash">/</span>{report.soft_scores.excess_access_nights_total}<em>extra</em></strong><small>Early closures / additional location-nights</small></div>
        </section>

        {page==='timeline'&&<section className="board"><div className="board-heading"><div><h2>Possession timeline</h2><span>{dateLabel(instance.horizon_start)} — {weekDate(instance,instance.horizon_weeks).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span></div><div className="board-tools"><select aria-label="Filter priority" value={priority} onChange={e=>setPriority(e.target.value)}><option value="all">All priorities</option><option value="1">Priority 1</option><option value="2">Priority 2</option><option value="3">Priority 3</option></select><span className="legend-item"><i className="work-dot"/> Access</span><span className="legend-item"><i className="late-dot"/> Late</span><span className="legend-item"><i className="eclo-dot"/> ECLO</span></div></div>
          <div className="timeline-scroll"><div className="timeline" style={{minWidth:Math.max(750,instance.horizon_weeks*23+220)}}><div className="timeline-header"><div className="contract-column">CONTRACT / ACTIVITY</div><div className="weeks" style={{gridTemplateColumns:`repeat(${instance.horizon_weeks},1fr)`}}>{weekNumbers.map(w=><span key={w} title={weekDate(instance,w).toLocaleDateString()}><small>{w===1||weekDate(instance,w).getMonth()!==weekDate(instance,w-1).getMonth()?weekDate(instance,w).toLocaleDateString('en',{month:'short'}):''}</small>{String(w).padStart(2,'0')}</span>)}</div></div>
            {projects.map(p=>{
              const activities=instance.activities.filter(a=>a.contract_number===p.contract_number);
              const all=activities.flatMap(a=>work[a.activity_id]||[]);
              const completion=report.contracts.find(c=>c.contract_number===p.contract_number)!;
              const deadline=Math.floor((new Date(p.planned_completion_date).getTime()-new Date(instance.horizon_start).getTime())/(7*86400000))+1;
              return <div className={`contract-group ${selected===p.contract_number?'expanded':''}`} key={p.contract_number}><div className="timeline-row"><button className="contract-column contract-name" onClick={()=>setSelected(selected===p.contract_number?null:p.contract_number)} aria-expanded={selected===p.contract_number}>{selected===p.contract_number?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<span><strong>{p.contract_number}</strong><small>{p.contract_description.replace(/ programme /,' · ')}</small></span><span className={`priority-tag p${p.contract_priority}`}>P{p.contract_priority}</span></button><div className="week-cells" style={{gridTemplateColumns:`repeat(${instance.horizon_weeks},1fr)`}}>{weekNumbers.map(w=>{const present=all.filter(a=>a.week===w);return <button key={w} className={`week-cell ${w===deadline?'deadline':''}`} title={`Week ${w}: ${present.length} accesses${w===deadline?' · planned deadline':''}`} onClick={()=>setSelected(p.contract_number)}>{present.length>0&&<span className={`access-block ${w>deadline?'late':''} ${present.some(a=>a.eclo)?'eclo':''}`} style={{opacity:.48+Math.min(present.length,4)*.13}}>{present.length>1?present.length:''}</span>}</button>;})}</div></div>
                {selected===p.contract_number&&<><div className="contract-detail"><span><strong>{completion.overrun_days?`${completion.overrun_days} days late`:'On time'}</strong> · finish {dateLabel(completion.simulated_completion_date)} · {p.access_type} · {p.nature_of_activity}</span><button onClick={()=>void ask(`Why is ${p.contract_number} scheduled this way?`)}>Explain this contract <ArrowRight size={13}/></button></div>{activities.map(a=><div className="timeline-row activity-row" key={a.activity_id}><div className="contract-column"><span className="activity-indent"/>{a.activity_id}<small>{a.total_accesses} units</small></div><div className="week-cells" style={{gridTemplateColumns:`repeat(${instance.horizon_weeks},1fr)`}}>{weekNumbers.map(w=>{const row=(work[a.activity_id]||[]).find(r=>r.week===w);return <div className="week-cell" key={w} title={row?`${a.activity_id} · week ${w} · ${row.eclo?'ECLO (1.5 units)':'standard (1 unit)'} · local access ${row.access_night}`:''}>{row&&<span className={`activity-block ${w>deadline?'late':''} ${row.eclo?'eclo':''}`}/>}</div>;})}</div></div>)}</>}
              </div>;
            })}</div></div>
          <div className="board-footer"><span><span className="deadline-key"/> Planned completion week</span><span>One access per activity, per week <CircleHelp size={13}/></span></div>
        </section>}

        {page==='capacity'&&<section className="board"><div className="board-heading"><div><h2>Location capacity</h2><span>{report.sharing_saved} location bookings saved through co-sharing</span></div><div className="board-tools"><select aria-label="Filter line" value={line} onChange={e=>setLine(e.target.value)}><option value="all">Both lines</option>{instance.lines.map(l=><option key={l.line_code} value={l.line_code}>{l.line_name}</option>)}</select><button className="secondary" onClick={()=>setModal('capacity')}><SlidersHorizontal size={14}/> Preview a change</button></div></div><div className="capacity-scroll"><div style={{minWidth:900}} className="capacity-grid"><div className="capacity-row"><strong className="location-column">LOCATION / BOUND</strong><div className="heat-cells" style={{gridTemplateColumns:`repeat(${instance.horizon_weeks},1fr)`}}>{weekNumbers.map(w=><span className="heat-heading" key={w}>{w}</span>)}</div></div>{instance.locations.filter(l=>line==='all'||l.id.split(':')[1]===line).map(l=><div className={`capacity-row ${location===l.id?'selected-location':''}`} key={l.id}><button className="location-column" title={l.id} onClick={()=>setLocation(l.id)}><span className={l.id.startsWith('SEC')?'location-type':'location-type platform'}>{l.id.startsWith('SEC')?'SEC':'PLAT'}</span>{l.id.split(':').slice(1).join(' · ')}</button><div className="heat-cells" style={{gridTemplateColumns:`repeat(${instance.horizon_weeks},1fr)`}}>{weekNumbers.map(w=>{const c=report.capacity.find(c=>c.location_id===l.id&&c.week===w);const cap=run.overrides.find(o=>o.location_id===l.id&&o.week===w)?.capacity??l.capacity;const used=c?.used||0;return <button aria-label={`${l.id} week ${w}: ${used} of ${cap} possessions. Preview change.`} title={`Week ${w}: ${used} / ${cap}`} onClick={()=>{setLocation(l.id);setWeek(w);setCapacity(cap);setModal('capacity');}} className={`heat-cell ${used>cap?'excess':used===cap&&used>0?'full':used?'used':''}`} key={w}>{used||'·'}</button>;})}</div></div>)}</div></div><div className="board-footer"><span>Each cell counts possession slots, including shared work.</span><span>Click a cell to preview capacity.</span></div></section>}

        {page==='compare'&&<section className="board comparison-board"><div className="board-heading"><div><h2>Scenario comparison</h2><span>Compare computed results, including capacity-change previews.</span></div></div><div className="comparison-cards">{(['A','B','C'] as Scenario[]).map(s=>{const r=Object.values(runs).filter(r=>r.scenario===s&&r.validation).at(-1);return <article className={`comparison-card ${s===run.scenario?'current':''}`} key={s}><div className="comparison-title"><span className="scenario-letter">{s}</span><span>{policies[s].name}<small>{policies[s].description}</small></span></div>{r?.validation?<><div className="comparison-score">{fmt(r.validation.score)}<small>penalty points</small></div><dl><dt>Work delivered</dt><dd>{r.validation.coverage_percent}%</dd><dt>Contract overrun</dt><dd>{r.validation.soft_scores.overrun_days_total} days</dd><dt>ECLO accesses</dt><dd>{r.validation.soft_scores.eclo_nights_total}</dd><dt>Extra location-nights</dt><dd>{r.validation.soft_scores.excess_access_nights_total}</dd><dt>Capacity changes</dt><dd>{r.overrides.length}</dd></dl><button className="secondary full-width" onClick={()=>{setActiveId(r.id);setScenario(s);if(r.id===previewId)setPreviewId('');setPage('timeline');}}>Open this plan <ArrowRight size={15}/></button></>:<div className="comparison-empty"><GitCompareArrows size={28}/><p>No result yet</p><button className="secondary" disabled={busy} onClick={()=>void start(s,60,true)}>Compute scenario {s}</button></div>}</article>;})}</div><div className="version-heading"><h3>Saved versions</h3><span>Capacity overrides stay attached to their version.</span></div><div className="versions">{Object.values(runs).map(r=><button key={r.id} className={r.id===activeId?'selected-version':''} onClick={()=>{if(r.schedule){setActiveId(r.id);setScenario(r.scenario);}}} disabled={!r.schedule}><span className="scenario-letter small">{r.scenario}</span><span><strong>{r.label}</strong><small>{r.overrides.length?`${r.overrides.length} capacity overrides`:'Original demand book'} · {r.status}</small></span><span>{r.validation?`${fmt(r.validation.score)} pts`:'Searching…'}</span>{r.id===activeId?<Check size={15}/>:<ArrowRight size={15}/>}</button>)}</div>{preview?.diff&&<div className="diff-summary"><h3>Preview impact</h3><p>{preview.diff.changed_activities.length} changed activities · {preview.diff.added_accesses} added accesses · {preview.diff.removed_accesses} removed accesses.</p><div>{preview.diff.changed_activities.map(a=><span className="activity-chip" key={a}>{a}</span>)}</div></div>}</section>}

        {page==='checks'&&<section className="board checks-board"><div className="board-heading"><div><h2>Schedule validation</h2><span>Published rules, implemented locally. Official conformance remains unverified.</span></div><span className={`validation-pill ${report.feasible?'good':'warning'}`}><ShieldCheck size={15}/>{report.feasible?'Local checks passed':'Needs verification'}</span></div><div className="check-grid">{[{name:'Workload conservation',detail:`${report.completed_activities} activities · ${report.coverage_percent}% of required units`,ok:report.coverage_percent===100},{name:'Temporal safety',detail:'Work spans, exclusion buffers and Live isolation',ok:report.safety_verified&&!report.hard_violations.some(v=>['closure','witness'].includes(v.rule))},{name:'Possession capacity',detail:'Location slots, co-sharing and legal mixes',ok:!report.hard_violations.some(v=>['capacity','mix'].includes(v.rule))},{name:'Contract allocation',detail:'Weekly access budgets and concurrent workfronts',ok:!report.hard_violations.some(v=>['workfront','allocation'].includes(v.rule))},{name:'Dates and dependencies',detail:'Release weeks, predecessor completion and deadlines',ok:!report.hard_violations.some(v=>['planned_start','planned_date','predecessor'].includes(v.rule))},{name:'Scenario policy',detail:'ECLO eligibility and continuity windows',ok:!report.hard_violations.some(v=>['eclo','eclo_window'].includes(v.rule))}].map(c=><div className="check-item" key={c.name}><span className={c.ok?'check-icon':'warning-icon'}>{c.ok?<Check size={18}/>:<TriangleAlert size={18}/>}</span><div><strong>{c.name}</strong><p>{c.detail}</p></div></div>)}</div><div className="rule-note"><CircleHelp size={20}/><div><strong>What “locally checked” means</strong><p>The planner verifies the published rules and keeps an additional timing witness to check simultaneous work. Possession labels in the submitted CSVs remain local. The organiser’s validator is not supplied, so these checks do not certify official acceptance.</p></div></div>{report.warnings.map(w=><div className="info-banner" key={w}>{w}</div>)}{report.hard_violations.map((v,i)=><div className="error-banner" key={i}><TriangleAlert size={16}/><span>{v.rule}: {v.detail}</span></div>)}<div className="bounds-section"><h3>Unavoidable work constraints</h3><p>These lower bounds ignore competition for track access.</p>{instance.bounds.details.map(b=><button key={b.activity_id} className="bound-card" onClick={()=>void ask(`Explain ${b.activity_id}`)}><span className="mono">{b.activity_id}</span><span>{b.standard_accesses} work units in {b.available_weeks} eligible weeks</span><strong>≥ {b.minimum_overrun_days} days / ≥ {b.minimum_eclo} ECLO</strong><ArrowRight size={15}/></button>)}</div></section>}

        <footer className="workspace-footer"><span><ShieldCheck size={13}/>{report.feasible?'Locally checked':'Reference · structural checks'}<span className="footer-separator">/</span>Official validator unavailable</span><span>{run.solver_status}{run.elapsed_seconds?` · ${run.elapsed_seconds}s`:''}</span></footer>
      </>:<section className="empty-board"><Columns3 size={40}/><h2>Your demand book is ready.</h2><p>{instance.activities.length} activities. {instance.total_workload} work units. Choose a policy and run the planner.</p><button className="primary" disabled={busy||solving} onClick={()=>void start()}><Play size={15}/> Build the access plan</button></section>}
    </main>

    <aside className="conversation"><div className="conversation-header"><span className="assistant-symbol"><Sparkles size={19}/></span><div><h2>Control room</h2><span>{modelConfigured?'Model-assisted · evidence grounded':'Evidence mode · no API key needed'}</span></div><button className="icon-button" aria-label="Reset conversation" onClick={()=>setMessages([{role:'assistant',text:'Start with a contract, a constraint, or a what-if. Every answer is tied to the selected schedule.'}])}><RotateCcw size={15}/></button></div><div className="conversation-context"><span className="status-dot"/>{run?`Reading Scenario ${run.scenario}`:'Awaiting a schedule'}<span>{run?.id===previewId?'Preview':'Current version'}</span></div>
      {selected&&<div className="selected-context"><span className="eyebrow">IN FOCUS</span><button aria-label="Clear selection" onClick={()=>setSelected(null)}><X size={13}/></button><strong>{selected} <span>{selectedActivities.length} activities</span></strong><p>{instance.projects.find(p=>p.contract_number===selected)?.contract_description}</p><button className="context-link" onClick={()=>void ask(`Explain ${selected}`)}>Explain this contract <ArrowRight size={14}/></button></div>}
      <div className="chat-messages" aria-live="polite">{messages.map((m,i)=><div key={i} className={`chat-message ${m.role}`}>{m.role==='assistant'&&<span className="message-label"><span className="tiny-spark">✦</span> NIGHTSHIFT{m.mode==='gemini'&&<span>MODEL ASSISTED</span>}</span>}<p>{m.text}</p>{m.run_id&&m.run_id!==activeId&&<small className="stale-notice">Evidence from a previously selected version.</small>}{m.notice&&<small className="stale-notice">{m.notice}</small>}{m.evidence?.map(e=><button className="evidence-card" key={e.id} onClick={()=>evidenceClick(e)}><span className="evidence-icon"><Layers3 size={13}/></span><span><strong>{e.title}</strong><small>{e.detail}</small></span><ArrowRight size={13}/></button>)}</div>)}{chatBusy&&<div className="chat-thinking"><LoaderCircle className="spin" size={14}/> Reading the schedule…</div>}<div ref={chatEnd}/></div>
      <div className="chat-bottom"><div className="suggestions">{[selected?`Why is ${selected} scheduled this way?`:'Why is C006 late?','Preview an on-time plan','Where are the bottlenecks?'].map(q=><button disabled={!run?.schedule||chatBusy} key={q} onClick={()=>void ask(q)}>{q}<ArrowRight size={12}/></button>)}</div><form className="chat-input" onSubmit={e=>{e.preventDefault();void ask();}}><textarea aria-label="Ask the controller" placeholder={run?'Ask about this plan…':'Run the planner to begin…'} value={question} onChange={e=>setQuestion(e.target.value)} disabled={!run?.schedule} rows={2} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void ask();}}}/><div><span><MessageSquareText size={12}/> Changes open as previews</span><button type="submit" aria-label="Send question" disabled={!question.trim()||chatBusy||!run?.schedule}><Send size={15}/></button></div></form><p className="chat-footnote">Computed facts. Inspectable sources. Your decision.</p></div>
    </aside>

    <dialog ref={dialog} onClose={()=>setModal(null)} className="modal"><div className="modal-heading"><div><span className="eyebrow">{modal==='upload'?'DEMAND BOOK':'WHAT-IF WORKSPACE'}</span><h2>{modal==='upload'?'Bring your next plan.':'Preview a capacity change.'}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={()=>setModal(null)}><X size={20}/></button></div>{modal==='upload'?<><p>Upload the eight PS1 instance CSVs, or a ZIP containing them. The planner reads your topology, workloads and policies directly.</p><label className="upload-target"><FileUp size={34}/><strong>{busy?'Reading your demand book…':'Choose CSV files or a ZIP'}</strong><span>Eight CSVs · maximum 5 MB</span><input type="file" aria-label="Upload instance CSVs or ZIP" accept=".csv,.zip" multiple disabled={busy} onChange={e=>void upload(e.target.files)}/></label><div className="upload-list">Lines · Stations · Sectors · Location supply · Buffers · Parameters · Projects · Activities</div></>:<form onSubmit={e=>{e.preventDefault();void start(scenario,60,true,[{location_id:location,week,capacity}]);}}><p>Test a change against the current schedule. Review the impact before adopting a new version.</p><label className="field">Location<select value={location} onChange={e=>setLocation(e.target.value)}>{instance.locations.map(l=><option key={l.id}>{l.id}</option>)}</select></label><div className="field-row"><label className="field">Week<input type="number" min={1} max={instance.horizon_weeks} value={week} onChange={e=>setWeek(Number(e.target.value))} required/></label><label className="field">Available possessions<input type="number" min={0} max={50} value={capacity} onChange={e=>setCapacity(Number(e.target.value))} required/></label></div><p className="modal-note">Capacity 0 removes nominal access. Scenarios B/C may buy extra access within their policy. Use Scenario A for a strict closure.</p><button className="primary full-width" disabled={busy||!run?.schedule}>{busy?<LoaderCircle className="spin" size={16}/>:<GitCompareArrows size={16}/>} Compute preview</button></form>}{error&&<div className="modal-error" role="alert">{error}</div>}</dialog>
  </div>;
}
