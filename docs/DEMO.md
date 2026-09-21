# Three-minute demonstration

Written for the RailPlan UI. Rehearse with the exact build and benchmark files you submit.
Use the hosted service only after this merged version has been deployed; keep the local
app and corrected public-result ZIPs as backups.

## Before recording

1. Open the public demand book and display the saved Scenario A run. Its corrected
   local score is 137.9. Keep the approved plan and displayed preview distinct.
2. Pre-run a disruption comparison: select a location and closure window, map the blast
   radius, then generate the five recovery options. The options share a 90-second
   computation budget. Read the results from the cards; an impossible policy stays unavailable.
3. Pre-assess a contractor booking: choose a contract, an activity on its route, a
   requested week range and a reason. Assessment uses the approved baseline and offers
   checked alternatives. Acceptance saves the booking and approves its schedule together.
4. Generate the management summary under Reports. It opens as printable HTML; use
   Print → Save as PDF when a paper copy is useful.
5. Return to Home. Tabs retain their state while moving between them.

## Script

| Time | Where | Action and narration |
|---|---|---|
| 0:00–0:25 | Home | Show all 54 activities and complete workload coverage. Explain that the controller starts from a checked plan for both lines. |
| 0:25–0:50 | Reports | Show Scenario A's corrected 137.9 score, the rule version and the validation result. Distinguish the local model's checks from official judging acceptance. |
| 0:50–1:15 | Ask RailPlan | Ask "Why is C006 late?" and open A036 evidence: seven work units, five eligible weeks, one access per week. |
| 1:15–2:00 | Disruption Response | Compare the pre-run recovery cards. Show minimum changed activities, hard deadline protection, no ECLO/excess for passengers, and frozen P1 activity bookings. Read the actual outcomes; compare operational metrics when scenarios use different score formulas. Review and explicitly adopt a feasible option. |
| 2:00–2:35 | Contractor Requests | Show a booking assessment against the current approved plan. Reassess if the previous adoption made it stale. Explain the requested activity guarantee, alternatives, and atomic acceptance. Draft replies are displayed for review. |
| 2:35–3:00 | Reports | Open the management summary for the displayed run and download its three-CSV submission bundle. Infeasible diagnostics carry a report warning and cannot be exported or adopted. |

## Hidden-instance demonstration

Load demand book accepts eight CSVs or one ZIP. Uploading selects the demand book and
starts a 90-second solve; it does not approve the result. Review and adopt explicitly.
Reload restores the selected demand book and its durable approved plan. Use Back to
sample book to return to the public book. Do not present cached public results as
hidden-instance solves. Allow additional time for a harder book or a 300-second Improve.

## Before publishing

Use the actual figures from the final rehearsal. Test a fresh browser, reload after
adoption, printed reports and exported ZIPs. Verify model quota for Ask and Cloud Run
checkpoint recovery. Recording and publishing the video and repository remain
owner-account steps.
