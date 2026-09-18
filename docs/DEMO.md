# Three-minute demonstration

Use the hosted URL once deployed; keep the local app and public-result ZIP as backups. Start on saved public Scenario A with the conversation reset. Rehearse with the same build and benchmark files you submit.

| Time | Action | Narration |
|---|---|---|
| 0:00–0:25 | Show demand book and Run planner | “At 2AM, a controller needs a complete plan and a reason to trust every possession. Nightshift schedules all 54 activities across both lines.” |
| 0:25–1:00 | Show 100% coverage, 25.2 penalty and Validation | “The local model delivers every work unit and reaches its proven lower bound. Its penalty improves the reference's 48.3 to 25.2. Here are the checks and the assumptions; official validation is a separate step.” |
| 1:00–1:40 | Ask “Why is C006 late?”; click A036 evidence | “This delay has a specific cause: seven work units, five eligible weeks, one access per week. Standard access alone cannot hit that date.” |
| 1:40–2:25 | Ask “Preview an on-time plan”; Compare | “Six ECLO accesses across the demand book remove the overruns. The planner computes the cost, shows which activities change, and leaves the current version selected.” |
| 2:25–3:00 | Adopt preview, ask handover, Export schedule | “The controller makes the decision. The numbers, timeline, handover and submission files now all describe the same checked version.” |

For a live hidden-instance demonstration, Upload demand book accepts either eight CSVs or a ZIP. Do not use cached public outputs as hidden-instance results. Allow a 60-second run and show progress if the hidden instance is harder.

Secondary demonstration: Capacity board → a location/week → hard closure → preview → inspect changed activities. A closure does not quietly become purchasable extra supply in B/C.

Before publishing: use actual measured results, test a fresh browser and the exported ZIP, verify model quota if model assistance is enabled, and confirm Cloudflare checkpointing survives a container restart. Recording and publishing the YouTube video and GitLab repository remain owner-account steps.
