---
title: Deployed GCP source PR integration
date: 2026-10-11
type: plan
status: in-progress
---

Integrate the deployed origin 7a4bc73ebbc096754adb954fbb2051a6b28b8b35
and edge 94bad7999fe1e7d998aa3739c2958b56ab22a53f through PRs #290 and
#291. Main starts at d6df06572aafbeea0258e96c58ca488e2025567c.
The owner authorized PR creation and merge; no further deployment is requested.

The origin carries the accumulated GCP line (934 unique commits, 1,277 files)
and main has 169 unique commits. Initial virtual merges report 45 origin and
30 edge conflicts. Work only in this isolated integration worktree.

Acceptance:
- Preserve both deployed commits and main history, without rewriting refs.
- Keep production's closed API contracts, public-source deployment guards,
  owner-only recovery, content-free telemetry and explicit unavailable evidence.
- Retain main's current desktop, updater, model-catalog and qualification work.
- Resolve canonical inputs and regenerate owned mirrors; never edit generated
  contracts or protected R7 evidence by hand.
- Inspect analytics compute provenance and run affected source/contract gates.
  Record baseline failures separately from integration regressions.
- Merge reviewable PRs through normal repository policy and verify both deployed
  commits are reachable from remote main. Restore any automatically deleted
  deployed branch references so the released sources remain easy to recover.
