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

Integration decisions:
- Retain the deployed Pro 20x v0.5/v1.5 producer and its Pro Max 25x cohort;
  read older Pro 10x and three-plan publications under their own exact contracts.
  Browser fixtures now select their schema and normalization explicitly. Known
  historical model evidence stays retained while the served roster controls the
  selected public comparison.
- Main already ships the September 29 catalog. Reuse its 43-model configuration
  once and retain September 23 history without inferring GPT-6.1 Sol coverage.
- Preserve both telemetry activation migration guards and main's Electron,
  updater, ultrafast performance and desktop quota-package export.
- The combined closure is kernel 17, sha256
  `89ee4ba5ceb5ef9d9b754a438b1b943160fce6e8210dfb98542d00525a6d7d03`.
  Kernel 16 and every older entry are immutable. The vendor, prices and B'
  allowance projection are unchanged; no combined-source image is deployed.

Qualification (2026-10-12):
- Cloud Run rebuilt before checks: 626 passed, four environment skips; kernel
  registry, Worker TypeScript and architecture checks passed.
- Local PostgreSQL 17: 47 synthetic integration tests passed, including forced
  GitHub sync, owner admin routes, reconstruction progress and daily publication.
- Analytics: 349 synthetic Vitest cases and 25 script cases passed, including
  differential pricing and the retained allowance goldens.
- Final browser suite: 1,081 passed. Release-site suite: 81 passed. Localization,
  model-history, static tool callers and documentation/preflight checks passed.
- The first full root run had 6,113 passes, 47 skips and 19 failures. Seventeen
  stale cross-branch assertions/fixtures were resolved and their owning suites
  rerun. The two retained R7 workload-digest failures reproduce on deployed
  origin 7a4bc73, while exact main d6df065 passes. Protected receipts are retained
  unchanged; this integration does not qualify a new R7 release.
- Full Worker pool: 2,750 passed and 14 failed across 183 files. The header audit
  now names the reviewed Map reads in their actual modules; five old allowance
  assertions select the current Pro 20x contract, and activation refusal checks
  prove the captured policy state remains unchanged. All seven failed files
  then passed (168 tests). The unchanged 16-owner statement-meter case is flaky:
  its 5,000 ms timeout failed in the full run and passed on retry; no timeout or
  assertion was relaxed.
- The generated offline allowance card was inspected at actual viewport widths
  962 and 293 pixels. Its basis and unavailable state remained explicit without
  horizontal overflow. No live data was fetched. The task's preview and local
  PostgreSQL server were stopped afterward.

Merge sequence: PR #291 targets the production origin branch with the qualified
combined source, then PR #290 targets main. Use ordinary merge commits and match
the reviewed head SHA at each operation. Confirm both released commits remain
ancestors of remote main and preserve any automatically deleted deployed refs.

GitHub CI surfaced an additional integration gate before merge:
- Its Cloud Run, documentation, dependency, release-policy and contract-drift
  jobs passed. The Worker job stopped at the CI contract/migration guard.
- The socket permission negative fixture now uses synchronous filesystem chmod;
  the subprocess-based mutation was ineffective. All 43 CI harness tests pass.
  The 0700 admission checks remain unchanged and fail closed.
- The numbering guard now covers the newly integrated staging-edge stand-in's
  migration directory, with the same unique/contiguous checks as every other
  owned migration directory.
- Main's `0013_performance_ultrafast.sql` collides with the GCP line's guarded
  `0013_v12_quarantine_admission.sql`. The GCP plan explicitly requires whichever
  reaches production D1 first to retain 0013. This is a D1 naming collision;
  no PostgreSQL migration or deployed schema has changed. Production ledger
  read approval was requested to identify applied filenames/checksums before
  renumbering only unapplied files. Both PRs remain unmerged pending this gate.
