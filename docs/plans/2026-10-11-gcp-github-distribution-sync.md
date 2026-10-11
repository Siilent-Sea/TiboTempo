---
title: GCP GitHub distribution sync
date: 2026-10-11
type: plan
status: implemented-candidate
---

Port the snapshot writer from D1 to the PostgreSQL production line based on
`2fd6d050d29e15db69de91effeb7355592136294`. Work only in this isolated
branch. Merge the captured integration tip
`67281641501800cde114f4a425761fbcc53267d2` locally before the final gates.
No push, deployment, production read, Secret Manager write or migration is
authorized.

Acceptance:

- Reuse the reviewed complete GitHub inventory reader. Preserve the 15-minute
  due check, one-minute forced cooldown, singleton lease, last-good snapshot
  and closed failure vocabulary. Publish rows, manifest and success state in
  one PostgreSQL transaction; a lost lease cannot publish.
- Run the optional sync after successful or partial production maintenance.
  Bound network and database work; a sync failure cannot alter maintenance's
  result. Inject a forced sync into the audited admin action.
- Check public inventory without authentication before adding any secret.
  Keep the default production desired state free of an unnecessary token;
  any future optional token belongs only to maintenance.
- Test only synthetic inventory and mocked fetch. Qualify rollback, due checks,
  contention, failure attempts and reader visibility on local PostgreSQL 17.
  Rebuild Cloud Run dist before its checks; retain the registered analytics
  kernel and existing migration bytes. Update maintained README and infra
  guidance, then commit a clean candidate and exact owner handoff.

Public source check on 2026-10-11: unauthenticated list-releases returned 200,
27 public releases, no next page and at most 20 assets per release. `v0.1.28`
was present; `v0.1.27` was absent and its tag endpoint returned 404. The owner
confirmed that 0.1.27 was never published as a GitHub release. No token is
needed for this complete public inventory. The post-roll table must include
0.1.28 and must not manufacture a 0.1.27 release.

Source: [GitHub release API](https://api.github.com/repos/adamallcock/tibotattle/releases?per_page=100&page=1).

Implementation: the shared inventory and binding exports feed
`src/postgres-github-distribution-history.ts`; production maintenance calls it
after lifecycle work, and the audited admin action forces it. Infra retains the
token-free committed desired state and restricts any future pinned token to
maintenance. There is no new migration, retention change or analytics registry
entry. The maintenance receipt advances to `postgres-maintenance-job-v2` with
the closed `githubDistributionSync` result, independent of lifecycle status.

Local evidence before integration:

| Check | Result |
|---|---|
| Local PostgreSQL 17.10 spec | 8 passed, no skipped cases; synthetic inventory and mocked fetch |
| Focused Cloud Run/admin checks | 65 passed |
| Infra/configuration checks | 70 passed, including maintenance-only optional mount |
| D1 distribution regressions | 40 passed |
| Worker type check | Passed |
| Root preflight and architecture | Passed |
| Cloud Run build | Passed, unchanged kernel 16, compute closure `d2e867213fe9656f6edf91d0ac991cb293a323f3b2cd84af7d79c0ac431f39f4` |
| Full Cloud Run gate on original base | Refused by pre-existing test-migration pins (expected 77; current primary manifest 79). Captured integration tip fixes these pins; rerun after merge |

These prove source and local synthetic behavior. Production state, rendering
and rollout remain owner-only checks. The disposable cluster contains only
synthetic test schemas; it is unrelated to Cloud SQL.

Owner steps, after reviewing and integrating this candidate:

1. Choose the final clean production commit and rerun the build and local gates
   after any further merge forward. The original base and integration tip above
   are provenance, not the final rollout commit.
2. **Secret creation: skip.** Public inventory is complete without a token.
   **Desired-state apply: skip for this fix.** The production desired-state JSON
   and its secret entries are unchanged. If production preflight finds unrelated
   drift, review its exact plan separately before applying it; this change does
   not authorize a whole-estate reconciliation.
3. From `apps/worker`, build the image using the owner workflow:

   ```bash
   rollout_commit=$(git rev-parse HEAD)
   node scripts/gcp-production-rollout.mjs build --environment=production \
     --commit="$rollout_commit" --authorize="build:production:$rollout_commit" --execute
   ```

4. Follow [GCP rollout](../runbooks/gcp-rollout.md) to capture a fresh backup
   audit, pause and drain the plane's triggers, and capture the live edge. Record
   both triggers' actual pre-pause states; the committed bootstrap `PAUSED`
   values are not evidence of their live state. The existing rollout CLI requires
   a **fresh migrate receipt matching this exact commit and digest**, even with
   an unchanged migration manifest. Its owner-run `migrate` verb should apply no
   new DDL for this port; do not relabel or reuse a receipt for another image.
   If a later integrated commit adds migrations, review them independently.

   ```bash
   node scripts/gcp-production-rollout.mjs migrate --environment=production \
     --commit=<final-commit> --digest=<sha256:image-digest> \
     --backup-audit=<private-absolute-audit-path> --migrate-receipt=<new-private-absolute-receipt-path> \
     --authorize=migrate:production:<sha256:image-digest> --execute
   node scripts/gcp-production-rollout.mjs roll --environment=production \
     --commit=<final-commit> --digest=<sha256:image-digest> \
     --backup-audit=<private-absolute-audit-path> --migrate-receipt=<matching-private-absolute-receipt-path> \
     --edge-live=<fresh-private-absolute-edge-capture-path> \
     --authorize=roll:production:<sha256:image-digest> --execute
   ```

   Replace angle-bracket placeholders before running. The roll moves the origin
   and maintenance job together and executes a maintenance pass before its
   serving-commit check. Resume only the previously enabled plane triggers using
   the current owner scheduler procedure; keep maintenance every minute and
   analytics refresh at 03:00 UTC. Never resume an intentionally paused trigger.
5. **Post-roll acceptance:** verify the served commit and maintenance's v2
   receipt; `githubDistributionSync.code` should be `GITHUB_SYNCED` (or fresh
   with a matching completed snapshot), while lifecycle stays complete/partial
   as appropriate. Open the owner console, refresh, and verify the GitHub table
   includes **v0.1.28**, the GitHub success timestamp is current and the
   **GitHub release evidence needs a refresh** attention item clears. After the
   one-minute cooldown, press Sync and verify a successful forced refresh and
   terminal audit outcome. The active-versions traffic panel is independent and
   does not qualify GitHub evidence. Version 0.1.27 is not an expected GitHub row.

If GitHub is unavailable or rate limited, the job still completes lifecycle
work, reports only `GITHUB_UNAVAILABLE` or `GITHUB_RELEASES_BOUNDED`, and keeps
the last good snapshot. A future token is a separate owner decision: create a
read-only GitHub credential in Secret Manager, add only its id and numeric
version to desired state, review `gcp-infra.mjs plan --environment=production`,
then apply its exact approved plan digest. The production service and both
analytics/migration jobs must still render without that credential. Never put a
token value into JSON, command arguments, receipts, logs or Git.
