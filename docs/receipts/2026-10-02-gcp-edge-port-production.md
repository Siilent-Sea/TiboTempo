---
title: GCP thin-edge port onto the production line
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP thin-edge port onto the production line

This 2026-10-02 receipt records the port of the thin Worker edge onto the
production line, branch `claude/gcp-edge-port-d43c8f92`, cut from
`d43c8f92a059d9c577776f7eca8a331eb305b8a6`. That is the source Cloudflare
production runs: the owner read `deployment.sourceCommit` from public
`GET /api/health` on 2026-10-02. The edge source comes from the GCP line,
`claude/gcp-fastpath-final` at `9700d167`. Every carried file is unchanged at
`2bb6cb04`, the C-ADMIN merge that landed on that line during this work.

It records **local, synthetic** evidence from one macOS arm64 workstation:
Node 26.2.0 for the Worker and repository tooling, Node 22.16.0 for the E12
spec and its origin, wrangler `4.114.0` (bundling with `--dry-run` only, with
no Cloudflare credential in its environment), and a local PostgreSQL 17
cluster on a private Unix socket. Every key, token, account, address and row
is synthetic.

Nothing was pushed, deployed, put or migrated. No Cloudflare API, Google
endpoint, GCP resource or production service was called. This receipt does
not qualify a deploy, the staging-edge rehearsal, Cloudflare's network,
Access, custom domains, Workers Rate Limiting across locations, the
production origin composition (CR-6 and CR-7) or production data.

The governing design is the
[thin-edge decision record](../decisions/2026-10-01-thin-worker-edge-proxy.md),
which the owner approved as written on 2026-10-02. This port carries a copy of
it, because `src/edge-google-subrequest.ts` cites it. The edge runbook,
`docs/runbooks/production-edge-modes.md`, stays on the GCP line (see
[what stays on the GCP line](#what-stays-on-the-gcp-line)).

## Result

- The edge ships from the production line. Every edge source file, the
  contract, the EP-9 overlay, E10 and the EP-8 fence are blob-identical to
  `9700d167`, apart from `production-deploy.check.mjs`, which keeps this
  line's own migration count. `src/index.ts` differs from `d43c8f92` by the `export` keyword
  on `contributionRequestPreflight` and two comment lines only.
- `wrangler.jsonc` is unchanged, so its `main` is still `src/index.ts`. Only
  the typed overlay of an `--edge-mode` deploy names `src/edge-entry.ts`.
  Moving the checked-in `main` stays a post-cutover integration commit
  (decision record, section 16).
- Production's own bundles change only where the port touches shared code.
  `wrangler deploy --dry-run` for `production` and for `staging` gives bundles
  that differ from a pristine `d43c8f92` tree only by EP-3's refactor of
  `distribution-analytics.ts`, which `distribution-analytics-split.spec.ts`
  pins to the pre-split outputs, and by the one added export name.
- In worker mode the edge answers like `d43c8f92`'s own `main`. With both
  bundles built from the port tree, 46 of 46 sampled requests gave equal
  status, headers and bodies, with only request ids and timestamps masked
  ([worker-mode neutrality](#worker-mode-neutrality)).
- EP-1 and `EDGE_PRE_ADMISSION_GUARDS` hold against `d43c8f92`'s admission
  call sites unchanged (OD-E5).
- E12 against the GCP line's local origin, with the edge built from this
  tree and the golden stage on: 15 of 15, S0 to S10. It took one harness fix
  on the GCP line, so that S0 compares worker mode with this line's own `main`
  ([E12](#e12)).

## Commits

On top of `d43c8f92`, in order. Cherry-picks carry `-x` provenance.

| Commit | Item | Source on `claude/gcp-fastpath-final` | How |
|---|---|---|---|
| `67560d49`, `a7c9911c` | EP-0 contract and vectors | `e130e531`, `7798b61e` | Cherry-pick without the origin-side `cloud-run/edge-origin-contract.check.mjs` |
| `91259032`, `61cfb225` | EP-1 admission policy | `aaae672c`, `ab750a8e` | Clean cherry-pick |
| `4fbb4e8e`, `dc599d0a` | EP-2 Google ID-token source | `7bd3187b`, `8bfcfe3a` | Clean cherry-pick |
| `29820975`, `9b30d8d7`, `fe68a611` | EP-3 distribution-analytics split | `e127d68b`, `89b1bd71`, `88c7df2e` | Clean cherry-pick; `d43c8f92`'s `distribution-analytics.ts` equals the pre-split base |
| `b07552c2`, `58531262`, `c6377596` | EP-9 overlay and `production-live-config.mjs` | `8c827e65`, `f0b72f06`, `6ef1b6b8` | Clean cherry-pick |
| `058ccf2f`, `820bdad4` | E4 proxy core and header ratchet | `2a7b8b7f`, `6d3d55a9` | Clean cherry-pick |
| `a386fc2a`, `1ca3fdfb` | E5 entry, release-guard migration, `edge-entry-env.ts` | `dba10d89`, `8a4e0763` | Clean cherry-pick |
| `75596874` | Pre-admission guards, `x-real-ip` override, `contributionRequestPreflight` export | `02841e26` | Cherry-pick of the edge source, specs and `index.ts` hunk; the E12 spec, harness and GCP-line documents stay there |
| `20b90c59` | RFC 7235 invoker credentials | `417dd594` | The contract and vectors only; the origin boundary stays on the GCP line |
| `3572fc4b` | Subrequest comment pointing at the address probe | `c76893a7` | That file's hunk only |
| `12e90ce7` | Header ratchet scoped to `src/` | `6d3d55a9`, `44c8de6a` | Hand-port (below) |
| `0277796d` | Contract source check without `cloud-run/` | `e130e531` | Hand-port (below) |
| `f186bc69` | Typed recovery of uncertain typed deploys | `f2d0b5aa` (GitHub `main` `378002f0`) | Clean cherry-pick; E10 wires the edge pin into it, and `d43c8f92` lacks it |
| `08ed2dd0` | E10 typed edge-mode deploy, reconcile and endpoint checks | `fe1ed615` | Clean cherry-pick |
| `e097c645` | EP-8 writer fence and its R2 inventory reader | `5d6445ac`, `73ab5183`, `fb9e170f` | Blob copies; E10 imports the fence's receipt reader |
| `faf9c254` | Production-line edge-mode dry run; edge checks in `scripts:check` | `scripts/edge-e2e/edge-mode-dry-run.mjs` | Hand-port (below) |
| This receipt's commit | The decision record and this receipt | `docs/decisions/2026-10-01-thin-worker-edge-proxy.md` at `2bb6cb04` | Copy (below) |

### Deploy tooling

At `d43c8f92`, `production-deploy.mjs`, `production-reconcile.mjs`,
`check-deployment-endpoints.mjs` and `production-live-config.mjs` equal the
GCP line's base under E10, before `f2d0b5aa`. E10 therefore applies to the
production line's own tooling unchanged, and every E10 file is blob-identical
to `9700d167`. The one exception is `production-deploy.check.mjs`, which keeps
`d43c8f92`'s own migration count (62 primary migrations, where the GCP line
has 63).

`f2d0b5aa` is carried because E10 wires the edge pin into
`reconcileTypedProductionDeployment`, and `d43c8f92` predates GitHub `main`'s
`378002f0`. It adds a new confirmation, `RECONCILE_TYPED_PRODUCTION_DEPLOYMENT`,
and changes no existing path. Without `--edge-mode`, E10 never loads
`production-edge-mode.mjs`, and every existing deploy and reconcile path is
unchanged. `production-deploy.check.mjs` and `production-reconcile.check.mjs`
pass with the production line's own expectations.

### EP-8, beyond the record's list

The decision record's section 3 lists EP-0 to EP-3, EP-9, E4, E5, the
release-guard migration and E10. E10's fenced-to-worker abort reads the EP-8
fence receipt through `cloudflare-writer-fence.mjs`'s own reader, and the
gcp-to-fenced brake needs the fence on the line that deploys the edge. The
staging-edge plan's finding 7 reached the same conclusion. The port therefore
also carries `cloudflare-writer-fence.mjs`, its check and synthetic inventory
example, and the read-only `scripts/r2-rest-inventory.mjs` that the fence's
quiescence proof imports. They are operator tools; nothing in them is bundled
into the Worker.

### Hand-ports

- **Request-header ratchet.** This line has no `cloud-run/`, so the ratchet
  scans `src/**/*.ts` only. The origin-side entries stay on the GCP line, which
  scans both trees. Re-derived against `d43c8f92`'s `src`, it found one read the
  GCP line does not have: `storage-effective-history.ts` indexes its
  effective-history header rows as `headers[family]`. That is a telemetry
  family index, not an HTTP header, and it is now a reviewed dynamic read. The
  `cloud-run/` injection rows became `src/` property and bracket injection rows.
- **Contract source check.** The EP-0 workerd spec compared the contract's
  callback-query rule with `cloud-run/request-boundary.mjs`. Here it checks only
  that the contract is self-contained, runtime-neutral and names no client
  value. The shared vectors stay blob-identical. The contract-blob rule
  (E10's `EDGE_CONTRACT_DRIFT`, E12's `EDGE_BUNDLE_CONTRACT_DRIFT`) requires the
  contract to be byte-identical to the GCP line's, where the full comparison
  runs. Both lines' contract blob is `c3a8b69cf7dd`.
- **Edge-mode dry run.** `scripts/edge-mode-dry-run.mjs` ports the GCP line's
  E12 dry run without the E12 harness. It inlines the harness's wrangler
  environment (PATH and HOME only) and bundle export reader. It uses a one-file
  synthetic site instead of E12's fixture assets. It pins this line's main-module
  exports, which lack the GCP line's `isPostgresWorkerRequestPathSupported`. It
  also requires the six edge rate-limit bindings, the Durable Object binding,
  empty gcp crons and no release-guard D1 outside gcp. `npm run edge:scripts-check`
  runs the R2 inventory, fence, EP-9, E10 and dry-run checks and then the dry
  run, and `scripts:check` now runs it.

### What stays on the GCP line

- The origin side: EP-6, EP-7, EORIGIN, `cloud-run/` and the future
  production composition.
- E12: `postgres-test/edge-origin-e2e.spec.mjs` and `scripts/edge-e2e/`. It
  builds this tree's edge through `EDGE_E2E_EDGE_TREE`.
- The address-probe tooling (`scripts/edge-ip-probe/`) and the live check
  (`scripts/edge-live-check.mjs`).
- The edge runbook and the fast-path plan. They link GCP-line files
  throughout, so they move here with the cutover documentation (decision
  record, section 16), not in this port.

### The decision record copy

The edge source cites the decision record, and the documentation gate refuses
a citation of a missing file. The port therefore carries the record. Its text
equals the GCP line's at `2bb6cb04`, with three kinds of change: 14 links to
files that exist only on the GCP line are written as paths; the status, the
banner, the sign-off box and section 15 record the owner's approval of
2026-10-02; and a banner note names this copy and points here. The GCP line's
copy still reads "proposed"; the two must be reconciled when the lines
merge.

## OD-E5: admission re-derivation

`d43c8f92`'s `index.ts` calls the address-keyed helpers at exactly the
decision record's 13 sites, with the same helpers, bindings and purposes:
`assertAttemptAllowed` at lines 718 (`enrollment`), 746, 773 and 812
(`accountless_ownership`), 851 (`accountless_renewal`), 899 (`enrollment`),
1508 and 1719 (`sign_in_start`), 2184 (`device_disconnect`), 2225
(`device_credential_renew`) and 3023 (`device_sync`, inside
`deviceSyncPrincipal`); `assertUploadIngressRequestAllowed` at 3342; and
`assertPublicAggregateReadAllowed` at 3979. The origin-tier
`assertUploadAuthorizationAllowed` stays at 2132. The GCP line's `index.ts`
differs from `d43c8f92`'s only outside these call sites.

The mechanical proofs ran against the port's `index.ts`:

- `test/edge-admission-policy.spec.ts`: the probe drives `handleRequest` for
  every registry route and method with spy limiters, and the raw-source
  ratchet ties every helper call site, directly or through
  `deviceSyncPrincipal`, to the policy's route ids and signatures.
- `test/edge-pre-admission-guards.spec.ts`: every EP-1 policy route and method
  under 21 request variants. Wherever `d43c8f92`'s `handleRequest` refuses
  before its limiter, the edge gives the same status, headers and envelope
  locally, with no limiter call and no forward.

Both pass unchanged, so EP-1's `EDGE_ADMISSION_POLICY` and
`EDGE_PRE_ADMISSION_GUARDS` need no change for `d43c8f92`. The decision
record's section 7 table holds as written.

## Worker-mode neutrality

A scratch comparison, not committed, used the GCP line's E12 harness. It built
two bundles from this tree with the same settings: the checked-in `main`
(`src/index.ts`) and `src/edge-entry.ts`. It ran both in workerd with
identical synthetic bindings, storage and Access fixture, the edge one with
`EDGE_UPSTREAM_MODE=worker`. Over 22 request shapes, each without and with a
session cookie, plus two owner Access requests on the admin host, all 46
answers were equal in status, headers (`date` aside) and body (request ids and
timestamps masked). Neither bundle made a subrequest. Both bundles export
exactly `UploadIngressBudget`, `contributionRequestPreflight`, `default`,
`handleRequest` and `runScheduledMaintenance`.

The shapes covered `www` redirects, assets and the 404 page, health,
readiness, the envelope key, unknown API paths, the retired
`DELETE /api/v1/me`, session, community daily, device sync, contributions,
accountless and Google enrollment, the admin API on the apex, the Apple path,
and the admin UI and overview on the admin host.

## E12

E12 is the GCP line's `postgres-test/edge-origin-e2e.spec.mjs`. It builds
the edge with wrangler `--dry-run` from `EDGE_E2E_EDGE_TREE` (this tree's
`apps/worker`) and refuses unless that tree's contract blob is byte-identical.
It runs the edge in workerd in every mode against the GCP line's fast-path
origin (`cloud-run/dist/server.mjs` behind EP-6) on PostgreSQL 17, behind the
Google front-end emulator. The reference Worker, the "unchanged Worker" of
every comparison, is this tree's edge bundle in worker mode, so it is
`d43c8f92`'s Worker. Run with Node 22.16.0, `--test-concurrency=1`,
`EDGE_E2E_GOLDEN=analytics-v2-test/golden` and
`EDGE_E2E_REHEARSAL_NODE` set to Node 26.2.0, against a dedicated database,
`edgeport_e12`, on the local fan-out cluster. The database was dropped
afterwards.

**First run, unchanged harness.** From the GCP line's worktree at `2bb6cb04`
(the C-ADMIN merge, which landed on that line during this work; the contract
blob, the edge files and `index.ts` are unchanged from `9700d167`), 14 of 15
passed in 397 s. S1 to S10 all passed. S0 failed at its first assertion: it
expected the GCP line's main-module exports, including
`isPostgresWorkerRequestPathSupported`, which `d43c8f92`'s `index.ts` does not
export. No S0 mode row ran. S0 also built "today's main" from the GCP line's
checked-in `main` (`src/cloudflare-entry.ts`), not the edge tree's.

**Harness fix.** Commit `41bd9702` on branch `claude/gcp-edge-e2e-edge-tree`
(from `2bb6cb04`, worktree `fp/EDGEPORT-E12`) makes S0 follow the edge tree
when `EDGE_E2E_EDGE_TREE` is set. It reads that tree's `wrangler.jsonc` for the
compatibility settings and `main`, builds "today's main" from that tree, and
expects the PostgreSQL request-path export only when that tree's `index.ts`
re-exports it. Without `EDGE_E2E_EDGE_TREE` nothing changes: S0 alone on the
GCP line, without it, passed. The branch is not merged into
`claude/gcp-fastpath-final`.

**Second run, with the fix: 15 of 15 in 400 s.**

| Figure | Value |
|---|---|
| Edge bundle | `src/edge-entry.ts`, 2,785,245 bytes, sha256 `8115167c…`; exports `UploadIngressBudget`, `contributionRequestPreflight`, `default`, `handleRequest`, `runScheduledMaintenance` |
| Contract sha256 | `675a98fc…`, equal on both lines |
| Forwarded exchanges | 3,929, with 3,929 distinct request ids |
| Body framing | 3,583 with a length, 1 chunked, 345 without a body |
| ID-token exchanges | 3 |
| Transport retries | 1: the 9 MiB accountless enrollment with a session cookie, the known local client race on an early answer, then equal to the Worker |
| S0 | Fenced, absent, cased and invalid-gcp rows as on the GCP line; worker mode equal to this tree's `src/index.ts` bundle on the ten samples |
| S9 | `community/daily` 396,337 bytes, `public, max-age=300`, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`, byte-equal to the GCP-line edge's recorded answer, with 0 unexpected parity differences |
| Schemas left | None |

The S4 rows prove admission parity against `d43c8f92`'s Worker at the
checked-in production limits, and the S3 and S4 rows prove the pre-admission
guards against it. Cross-line limits that remain: the reference Worker applies
the GCP line's `migrations/` (63 files; `d43c8f92` has 62, and its Worker
never touches the extra one's table), and reads the GCP line's sanitized
`env.production` variables, which equal this line's.

## Gates

Local, on the port's head before this receipt's commit (`faf9c254`), unless
stated.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| Worker vitest, default config (`npx vitest run`) | 199 of 199 files and 2,752 of 2,752 tests pass, in 2,186 s while two other agents' suites shared the machine |
| Edge unit specs alone (`edge-*.spec.ts`, `distribution-analytics*.spec.ts`) | 9 files, 325 tests, all pass |
| `npm run scripts:check` (apps/worker) | Exit 0: 23 node:test runs, 1,076 pass, 0 fail, then the three-mode edge dry run |
| `npm run types:check` (apps/worker) | Types up to date |
| `npm run deployment:endpoints:check` and `workspace-packages:guard` | Pass |
| `wrangler deploy --env production --dry-run` and `--env staging --dry-run` | Exit 0 for both, `main` `src/index.ts` (`index.js`), 2,630.76 KiB. Run directly with PATH and HOME only, over a one-file synthetic site in the git-ignored `.release-build/`, because `production:stage-assets` needs a built public release site |
| Bundle diff against a pristine `d43c8f92` tree (`git archive`) | Both environments: only EP-3's `distribution-analytics.ts` refactor and the `contributionRequestPreflight` export name |
| E10 edge-mode dry run (`npm run edge:modes:dry-run`) | worker, fenced and gcp each bundle `src/edge-entry.ts` with `--env production --dry-run`; worker and fenced keep the four data bindings; gcp keeps only `RELEASE_GUARD_DB` and `SPARKLE_RELEASES` and has no crons; all three keep the eight rate limits and the Durable Object; overlay sha256 `3e72fae5…` (worker), `98904b29…` (fenced), `3b6a1c39…` (gcp, synthetic plan) |
| E10, EP-9 and deploy suites (`edge-mode-configuration`, `production-edge-mode`, `production-deploy`, `production-live-config`, `production-reconcile` checks) | 115 of 115 |
| EP-8 and R2 inventory checks | 27 of 27 |
| E12 (above) | 15 of 15 with the harness fix; 14 of 15 without it |
| Worker-mode neutrality (above) | 46 of 46 |
| Repository root `npm run architecture:check` | Passed: 676 production files, 2,861 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this receipt and the decision record in place | Exit 0: root workspace hygiene clean; documentation governance valid across 288 Markdown files and 1,187 source and config files; 20 of 20 governance and guidance tests. Without the record copy it failed on the citation in `src/edge-google-subrequest.ts` |

## PROD-5: owner-run steps

Every step below is a protected operation. Each needs the owner's explicit
authorization for that step, and the owner runs it; nothing here authorizes
one. Keep identifiers, inventories, plans and receipts owner-private and
outside the repository, and supply `CLOUDFLARE_API_TOKEN` only through the
approved credential mechanism. Never print a secret value.

### 0. Prerequisites

1. Approve this branch as the edge-port line (OD-E1) and place it on the
   production release line: merge or push it so the deploy commit contains
   `d43c8f92` and every commit above. The deploy runs from a clean checkout of
   that exact commit; E10 refuses `EDGE_MODE_SOURCE_NOT_DESCENDANT` otherwise.
2. On that commit, from `apps/worker`, run the local validation in
   `docs/runbooks/production-operations.md` ("Local validation before an owner
   deploy") and the gates in this receipt, including
   `npm run edge:scripts-check`.

### 1. Create and migrate the release-guard D1

Only the gcp overlay binds it, so creating it changes nothing that serves
traffic.

1. From `apps/worker`, with the same location hint as the production D1s:

   ```bash
   npx wrangler d1 create tibotattle-release-guard
   ```

   The name must be `tibotattle-release-guard`
   (`EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME`). Record the returned
   `database_id` only in the owner-private gcp plan (OWN-12).
2. Write a throwaway private config (mode 0600, outside the repository) that
   binds only this database as `RELEASE_GUARD_DB`, with `migrations_dir` set to
   the absolute path of `apps/worker/release-guard-migrations` and the default
   migrations table. Then:

   ```bash
   npx wrangler d1 migrations apply tibotattle-release-guard --remote --config <private-config>
   npx wrangler d1 migrations list tibotattle-release-guard --remote --config <private-config>
   ```

   The list must show no pending migration. The one migration,
   `0001_sparkle_appcast_guard_nonces.sql`, creates only the nonce table, with
   the same statements as `migrations/0029`. A gcp deploy later refuses
   `EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING` if anything is pending; no edge
   deploy applies a migration.
3. Delete the throwaway config.

### 2. Confirm the edge-tier bindings

In the current owner-private inventory, confirm that the live version binds
all six edge-tier Workers Rate Limiting bindings: `ENROLLMENT_RATE_LIMIT`,
`RECOVERY_RATE_LIMIT`, `CLIENT_ATTEMPT_RATE_LIMIT`, `PUBLIC_READ_RATE_LIMIT`,
`UPLOAD_INGRESS_REQUEST_RATE_LIMIT` and `UPLOAD_INGRESS_CLIENT_RATE_LIMIT`.
Worker mode does not check them; a gcp deploy refuses
`EDGE_MODE_ADMISSION_BINDING_MISSING` without them.

### 3. Put the edge secrets

Worker mode never reads either secret, so each put is inert. Each put creates
and deploys a new version at 100%.

1. `EDGE_INVOKER_KEY_JSON`: one JSON key of the edge-invoker service account,
   which holds only `run.invoker` on the production service. If organization
   policy blocks key creation, request the exception for this account only
   (owner decision, 2026-10-02). Pipe the key into
   `npx wrangler secret put EDGE_INVOKER_KEY_JSON --name app-usagemonitor`, run
   from a directory with no wrangler configuration, then delete every local
   copy. Rotate every 90 days.
2. `EDGE_CLIENT_KEY_SECRET`: a fresh random value of at least 32 characters
   that must never equal the origin's `IDENTITY_LINK_SECRET`, generated inside
   the pipe, for example
   `openssl rand -hex 32 | npx wrangler secret put EDGE_CLIENT_KEY_SECRET --name app-usagemonitor`.
3. Keep `SPARKLE_APPCAST_GUARD_TOKEN` and `DISTRIBUTION_ANALYTICS_API_TOKEN`;
   the gcp overlay requires both.
4. After each put, confirm one version at 100%, an unchanged
   `DEPLOYMENT_SOURCE_COMMIT` (`d43c8f92`) and unchanged public health.

Unverified until the staging rehearsal: that `wrangler secret put` against
this Worker copies the active version's bindings unchanged, and that piping a
key file through stdin works (the staging plan's U-2). Step 4's recapture
checks the first.

### 4. Recapture the baseline

Each secret put creates a new version, so the earlier inventory is stale and
the next typed deploy must not use it.

1. Capture a fresh owner-private inventory of the active version with the
   owner's usual capture, and pin its sha256.
2. Compare it with the previous inventory. Only the version id and the two new
   `secret_text` binding names may differ.
3. Run the read-only reconciliation with the worker-mode overlay:

   ```bash
   npm run production:reconcile -- \
     --inventory <fresh-private-inventory.json> \
     --inventory-sha256 <fresh-inventory-sha256> \
     --expected-previous-source d43c8f92a059d9c577776f7eca8a331eb305b8a6 \
     --output-directory <new-private-output-directory> \
     --edge-mode worker
   ```

   It must report a compatible candidate whose `edge.edgeMode` is `worker`, and
   its report carries the expected post-deploy live-configuration fingerprint.

### 5. Staging-edge rehearsal

Rehearse worker, fenced (with an EP-8 drill) and gcp on the staging edge
before the first production use of each mode, as
`design/staging-edge-plan-2026-10-02.md` in the parity home lays out. The
gating rehearsal (R1 and R2 there) must run from this line.

Blocked today: no typed staging-edge driver (STG-DRV) exists on either line.
EP-9's staging overlay exists only as a library, and E10 deploys production
only. STG-DRV must be built on this line, with E10, before this step can run.
The gcp half also needs the staging origin.

### 6. Worker-mode edge deploy (P1)

After steps 1 to 5, and with a freshly recaptured inventory, from `apps/worker`
on the deploy commit:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source d43c8f92a059d9c577776f7eca8a331eb305b8a6 \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  --retained-public-source <reviewed-full-public-source-sha> \
  --expected-live-manifest-sha256 <reviewed-live-manifest-sha256> \
  --edge-mode worker
```

- It is the typed path with the worker overlay: `main` becomes
  `src/edge-entry.ts` and `EDGE_UPSTREAM_MODE` is `worker`. Nothing else
  changes. The retained public release tree must be the exact live site; a
  privacy page that carries the gcp marker is refused
  (`EDGE_PRIVACY_PAGE_PREMATURE`).
- Verify as today: public health reports the deploy commit as
  `deployment.sourceCommit`, one version serves 100% with the matching
  `DEPLOYMENT_SOURCE_COMMIT` and `EDGE_UPSTREAM_MODE=worker` bindings, and the
  public surface is unchanged.
- Recapture the baseline again: the deploy created a new version.
- An uncertain outcome follows the typed recovery
  (`RECONCILE_TYPED_PRODUCTION_DEPLOYMENT`) in
  `docs/runbooks/production-operations.md`; never retry with raw wrangler.

From P1 on, `none` to `fenced` and `worker` to `gcp` are refused. The next
edge step is the fence, at the cutover window. After the switch the only brake
is gcp to fenced (owner decision, 2026-10-02).

## Open

- STG-DRV, the typed staging-edge driver, does not exist; PROD-5's staging
  rehearsal cannot run until it is built on this line.
- The edge runbook and the production-operations pointer to it are still
  GCP-line documents. Bring them to the production line with the cutover
  documentation (decision record, section 16). The GCP line's copy of the
  decision record still reads "proposed".
- The GCP-line edge runbook puts the edge secrets after P1, while PROD-5 here
  puts them before it. The code accepts both, because only a gcp deploy reads
  them; reconcile the runbook when it moves.
- OD-E6: the address probe from the `tibotattle.com` zone gates the first gcp
  deploy; E10 does not check it.
- The E12 harness keeps two cross-line limits: S0's "today's main" bundle and
  the reference Worker's migrations and sanitized variables come from the GCP
  line's tree. The worker-mode neutrality comparison above covers the first
  for this tree.
- Client-disconnect cancellation stays unproven, as on the GCP line.
