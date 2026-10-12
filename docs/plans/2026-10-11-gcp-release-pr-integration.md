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
- The first combined closure is kernel 17, sha256
  `89ee4ba5ceb5ef9d9b754a438b1b943160fce6e8210dfb98542d00525a6d7d03`.
  The later statement-attribution correction appends kernel 18, sha256
  `dfc22ac42c7f99a0bc91cc2abacafca239b0fc1bd8a2e9b8cf2019fc30cc09ff`.
  Kernel 17 and every older entry remain immutable. The vendor, prices and B'
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
  readback and renumbering were authorized by the owner on 2026-10-12.

Migration collision resolution (2026-10-12):
- Read-only production queries inspected only the two migration-ledger table
  names, migration filenames and stored SHA-256 checksums across the four
  production D1 roles. Ingestion has 13 storage-ledger rows, analytics has 32,
  deletion has three Wrangler rows and legacy primary has 60 Wrangler rows.
  Wrangler's ledger does not store SQL checksums. No payload rows were read.
- None of the performance, quarantine or v1.2 history tail files is applied.
  All nine applied ingestion-isolation rows, `0004` through `0012`, match
  their source checksums and retain their exact names and bytes.
- Keep main's `0013_performance_ultrafast.sql`. Rename only the unapplied GCP
  quarantine and history files to `0014_v12_quarantine_admission.sql` and
  `0015_accountless_history_transfer_v12.sql`. Their SHA-256 values remain
  `01f7b2f75dcbe9de8d42fb194702504db39f7ea8dbc475e28d09604230152344`
  and `73662adb122ff7abf9665d8778565056465a07d52e5234c8b0230fe740b62ef7`.
  Activation pins, synthetic fixtures, sequence guards and current runbooks
  follow the new names. Retired names stay refused. Historical receipts remain
  point-in-time evidence.
- No D1 or PostgreSQL migration was applied, no deployment ran and no secret
  was created or changed. The production readback does not qualify staging.
- Final rename checks: 142 synthetic migration, schema, source-seal and CI
  harness cases passed with no skips; all 58 affected Worker activation,
  performance and v1.2 cases passed. Worker TypeScript and final documentation
  preflight passed. The analytics closure and every migration SQL checksum are
  unchanged. Rebuild Cloud Run before the final hosted checks and normal merges.

Hosted PostgreSQL gate follow-through:
- Enabling the script checks against PG17 exposed stale full-chain assertions
  at 77. The promoted primary source already includes
  `0078_classification_link_lookup_indexes.sql`; exact counts and tail-name
  assertions now require that existing 78-file chain. PostgreSQL SQL files and
  migration checksums remain unchanged.
- The parallel/inline PG parity test also exposed untagged shared
  classification-proof reads. The A-1 caller now wraps just those helper reads
  with the existing closed `occurrences.correction_sources` family. It retains
  SQL parameters, row results, bounds and release behavior. No taxonomy or
  public failure schema is broadened. The full worker/block matrix retains
  its assertion that no reader statement is untagged and produces exactly the
  inline rows.
- Kernel 18 is appended with immutable registry pin
  `5f808f13dccf3aa6eb919bb56d7ca9b57b1ea2e474fc1bb5847102a73c78a5fd`.
  Rebuilt Cloud Run and registry: 630 passed, no skips. Analytics: 349 Vitest
  and 25 script cases passed. Worker TypeScript passed. Source-transfer scripts
  passed 23 cases; the correction/intake specs passed seven and the legacy
  roundtrip passed one. All 76 affected PG Node cases passed with no skips,
  including the worker/block parity matrix and the dense refresh fixture.
  Two PG Vitest cases passed; their separate TCP case
  requires the CI-provided loopback listener and was skipped locally.
- The disposable local PG17 cluster keeps its 30-connection bound and uses
  `max_locks_per_transaction=256` for the schema-heavy parity matrix. This
  changes no production setting or test assertion. Temporary query diagnostics
  were removed before review.
