# Three-minute demonstration

Written for the RailPlan UI (`src/RailPlan.tsx`). Use the hosted URL once deployed, and keep
the local app and the public-result ZIP as backups. Rehearse with the same build and
benchmark files you submit.

## Before you record

1. Start the service and the UI. On Windows:
   `.venv/Scripts/python.exe -m uvicorn trackaccess.api:app --port 8000` and `npx vite`.
   Then open `http://127.0.0.1:5173`.
2. If a previous rehearsal left an uploaded book loaded, go to **Load demand book → Back to
   sample book**.
3. In the top bar, switch to scenario **C** (about 20 s). The disruption beat needs C:
   Scenario A allows no ECLO or excess nights, so the five recovery philosophies all come
   out the same there.
4. Pre-run the two slow beats so the recording doesn't wait on the solver. Tabs keep their
   state while you move between them.
   - **Disruption Response:** location **BET H01–H02 EB**, full closure, weeks **10–12** →
     Map the blast radius → Generate recovery → **Generate 5 recoveries** at 30 s each
     (about a minute in total).
   - **Contractor Requests:** Log a request → **C006**, Additional access night, **BET
     H01–H02 EB**, week **15** → Assess impact (about 25 s).
5. Go back to **Home**.

## Script

| Time | Where | Action | Narration |
|---|---|---|---|
| 0:00–0:20 | Home | Point at the Run summary and the feasible pill | "At 2 a.m. a controller needs a complete plan and a reason to trust every possession. RailPlan schedules all 54 activities across both lines, and every one is checked." |
| 0:20–0:40 | Home → Reports | Point at score, coverage and safety in the Submission bundle card | "Every work unit is delivered, and the penalty is 25.2. That is the proven lower bound, against 48.3 for the reference schedule. Structural checks and the safety witness pass. Official validation is a separate step." |
| 0:40–1:05 | Ask RailPlan | Ask "Why is C006 late?" and read the A036 evidence | "This delay has a specific cause. A036 needs seven work units, has five eligible weeks, and gets one access a week. Standard access alone cannot hit that date." |
| 1:05–1:20 | Risk & Resilience | Where the schedule is most vulnerable | "Here is where the plan is brittle: the Beta H01–H02 eastbound section is full for twenty weeks." |
| 1:20–2:05 | Disruption Response | Step 3 cards → the Protect Deadlines change map → Adopt | "Now close that section for three weeks. RailPlan re-plans five ways. Minimum churn moves the least but spends two ECLOs. Protecting deadlines cuts the overrun from 21 days to 7 with four ECLOs. Protecting passengers uses no ECLO. Every option is scored on the same official formula. The controller picks one and adopts it." |
| 2:05–2:35 | Contractor Requests | Open C006's request | "A contractor asks for an extra night on that same section in week 15. Granting it moves three other activities, all within their slack, and no completion date changes. Weeks 24 and 25 would move nothing. RailPlan drafts the reply." |
| 2:35–3:00 | Reports | Generate → Open the management summary; show the bundle download | "The decision, the reports and the three submission CSVs all describe the same checked plan. Export is blocked for any plan that is not feasible." |

The Disruption figures above were measured on the public book with 30 s per recovery
(`docs/BACKEND_CONTRACT.md` §4.3). Re-read them from the cards after your own rehearsal
run, and say what is on screen.

## Hidden-instance demonstration

**Load demand book** takes the eight CSVs or a single ZIP, solves the scenario you pick
and switches every tab to the new book. Allow a 60–90 s budget and show the progress
label. Do not use cached public outputs as hidden-instance results. The uploaded book
survives a page reload. **Back to sample book** returns to the public book.

## Backups and before publishing

- If the solver is slow on the recording machine, use the pre-run results (step 4 above).
- Test a fresh browser and the exported ZIP.
- Verify model quota if model assistance is enabled for Ask.
- Confirm Cloud Run checkpoint recovery survives a revision replacement.
- Recording and publishing the YouTube video and the GitLab repository are steps for the
  account owner.
