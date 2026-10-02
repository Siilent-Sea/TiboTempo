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
`2bb6cb04`, the C-ADMIN merge that landed on that line during this work, and
at `1bea3b5f`, the C-IPR merge, where the review round checked it again.

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
it, because `src/edge-google-subrequest.ts` cites it. Since the review round,
this line also carries its own version of the edge runbook,
[Production edge modes](../runbooks/production-edge-modes.md). Production
service operations, the Worker README and the documentation index point to
it ([review round](#review-round)).

## Result

- The edge ships from the production line. Every edge source file, the
  contract, the EP-9 overlay, E10 and the EP-8 fence are blob-identical to
  `9700d167`, apart from `production-deploy.check.mjs`, which keeps this
  line's own migration count. `src/index.ts` differs from `d43c8f92` by the `export` keyword
  on `contributionRequestPreflight` and two comment lines only. This held at
  the port's head. STG-DRV and its review round later changed E10, EP-9 and
  `production-deploy.mjs` ([Open](#open)).
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
`production-edge-mode.mjs`. Every existing deploy and reconcile path is
structurally unchanged, with one addition.

`checkDeploymentEndpointConsumers` now also runs
`validateEdgeModePublicSurface`. Every ordinary deploy and
`deployment:endpoints:check` call it, so this is a new hard gate on the
default path. It requires the public route hosts to include the apex and
`www`, and the admin host to stay separate. Today's endpoints pass it.
`production-deploy.check.mjs` and `production-reconcile.check.mjs` pass with
the production line's own expectations.

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
- The fast-path plan, the edge receipt and the planned cutover runbook. They
  move here with the cutover documentation (decision record, section 16).
  The GCP line's edge runbook stays there too. This line carries its own
  version, adapted in the review round.

### The decision record copy

The edge source cites the decision record, and the documentation gate refuses
a citation of a missing file. The port therefore carries the record. Its text
equals the GCP line's at `2bb6cb04`, with three kinds of change: 14 links to
files that exist only on the GCP line are written as paths; the status, the
banner, the sign-off box and section 15 record the owner's approval of
2026-10-02; and a banner note names this copy and points here. In the
review round, one of those paths, the Operations row, became a link to this
line's runbook, and the banner says so. Section 16 still lists that pointer
as owed at the cutover. The record's text stays as approved. The GCP line's
copy still reads "proposed", and the two copies must be reconciled when the
lines merge.

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

## Review round

A review of `4a5e6afd` on 2026-10-02 raised four actionable findings and
six verified observations. Each was checked against the source before it was
acted on.

| Finding | Disposition | Evidence and change |
|---|---|---|
| Node.js 22.13 to 22.17 cannot load the new edge scripts | Accepted in part. The edge deploy and reconcile paths are affected. The `scripts:check` part predates the port | On Node.js 22.16.0, importing `edge-mode-configuration.mjs` fails with `ERR_UNKNOWN_FILE_EXTENSION`. `production-deploy.mjs` and `production-reconcile.mjs` still load, because they load the edge module only on request. An `--edge-mode` run fails closed with only `PRODUCTION_DEPLOYMENT_FAILED` or `PRODUCTION_RECONCILE_FAILED`, before any journal or remote call. The finding's premise is wrong: at `d43c8f92`, `accountless-migration-operator.mjs` and its check, plus both qualification preparers, already import `src/mutation-barrier.ts`. The operator's check fails on 22.16.0 with the same error, so `scripts:check` already needed type stripping before the port. Change: documentation only. The requirement is stated in the edge runbook, in Production service operations' local validation, in the Worker README and in the owner steps below. Node.js 24.14.0 and 26.2.0 were verified. E10 is not changed, so it stays blob-identical to the GCP line |
| No maintained runbook for the new operator surfaces | Accepted and fixed | Added `docs/runbooks/production-edge-modes.md`, this line's version of the GCP line's runbook. It covers the deploy line, Node.js, the gates, the release-guard D1, the bindings, the deploy, reconcile and recovery flags, the secrets and their order, the fence, the brake, the verifier and the local proof. Pointers were added in Production service operations (introduction, local validation, endpoint check, typed recovery), in the Worker README and in the documentation index, together with the accepted decision record. The decision record's Operations row now links it |
| "Unchanged" deploy tooling overstates | Accepted. No code change | The default path's one new gate, `validateEdgeModePublicSurface`, is now stated under [deploy tooling](#deploy-tooling) and in both runbooks |
| The production release line is not settled | Facts verified. The fix's release-candidate branch is rejected | `claude/release-candidate-d43c8f92` (`ec0b3fce`) is 4 commits past `d43c8f92` and merges cleanly with the port. Its own receipt, `docs/receipts/2026-10-02-gcp-r-merge.md` on that branch, says it must never be deployed to Cloudflare, under the owner's OD-OAI-1 (#258 ships on GCP only, after cutover). It is therefore not a candidate edge deploy line. Owner step 0 now names the rule: deploy from this branch, or from an owner-named descendant without #257 or #258. On any other commit past `d43c8f92`, merge the port and rerun the listed gates first |
| Worker-mode neutrality; dry-run bundles; carry blobs; EP-1 call sites; E12 15 of 15; no secrets | Verified observations. No change | The carry was re-checked against `1bea3b5f`, the current tip of the GCP line. Only the hand-ports differ: `production-deploy.check.mjs`, `index.ts`, the two hand-ported specs, the port-only dry run and its check, and this line's `package.json` scripts. E12 was rerun on this round's tree (below). Merging the S0 fix `41bd9702` into `claude/gcp-fastpath-final` belongs to the GCP line's owner and stays open |

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

### Review-round gates

These ran on 2026-10-02, on the review round's tree: `4a5e6afd` plus this
round's Markdown changes. Only Markdown changed, including
`apps/worker/README.md`, so no bundled source changed. The full Worker
vitest suite and the direct production and staging `--dry-run` bundle diff
were not rerun. Tooling: Node.js 26.2.0, except where a row names another
version.

| Gate | Result |
|---|---|
| E12 from `fp/EDGEPORT-E12` (`41bd9702`, clean) | 15 of 15 in 377 s, S0 to S10 |
| E12 settings | Node.js 22.16.0, `--test-concurrency=1`, `EDGE_E2E_EDGE_TREE` set to this tree's `apps/worker`, `EDGE_E2E_GOLDEN=analytics-v2-test/golden`, `EDGE_E2E_REHEARSAL_NODE` set to Node.js 26.2.0, dedicated database `edgeport_e12f` on the local fan-out cluster |
| E12 edge bundle | sha256 `8115167c…` and 2,785,245 bytes, as before |
| E12 contract | sha256 `675a98fc…` |
| E12 exchanges | 3,929, with 3,929 distinct request ids and 3 token exchanges |
| E12 transport retry | 1, the known 9 MiB enrollment race |
| E12 S9 | sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`, 396,337 bytes, read from the run's private report, with 0 unexpected differences |
| E12 cleanup | Database dropped; no `edgeport_` database remains |
| `npm run scripts:check` (apps/worker) | Exit 0: 23 node:test runs, 1,076 pass, 0 fail |
| Edge dry run inside `scripts:check` | worker, fenced and gcp overlays `3e72fae5…`, `98904b29…` and `3b6a1c39…`, unchanged |
| `npx tsc --noEmit` | Exit 0 |
| `deployment:endpoints:check` | Exit 0 |
| `types:check` | Exit 0 |
| `workspace-packages:guard` | Exit 0 |
| Edge unit specs (`edge-*.spec.ts`, `distribution-analytics*.spec.ts`) | 9 files, 325 of 325 |
| Node.js 22.16.0, importing `scripts/edge-mode-configuration.mjs` | `ERR_UNKNOWN_FILE_EXTENSION` |
| Node.js 22.16.0, importing `production-deploy.mjs` and `production-reconcile.mjs` | Both load |
| Node.js 22.16.0, `node --test scripts/accountless-migration-operator.check.mjs` | Fails with `ERR_UNKNOWN_FILE_EXTENSION` on `src/mutation-barrier.ts`. This file is unchanged since `d43c8f92` |
| Node.js 24.14.0, importing `edge-mode-configuration.mjs` | Loads |
| Repository root `npm run docs:check` | Valid across 289 Markdown files |
| Repository root `npm run test:preflight` | Exit 0, 20 of 20 |
| Repository root `npm run architecture:check` | Passed: 676 production files, 2,861 imports, 0 debt edges |

## Addendum: STG-DRV, the typed staging-edge driver

Added on 2026-10-02, after the port. The code is commit `e06768de` on this
branch. The evidence is local and synthetic, from the same workstation, on
Node.js 26.2.0 and wrangler `4.114.0`. No credential was present, and
wrangler ran with `--dry-run` only. Nothing was deployed, put, migrated or
created. No Cloudflare, Google or production endpoint was called. The
staging-edge rehearsal itself has not run. This addendum does not qualify it.

**What it adds.** It follows the staging-edge plan's STG-DRV, STG-STANDIN and
STG-PLAN items. The procedure is section 11 of the
[edge runbook](../runbooks/production-edge-modes.md).

- **The driver.** `scripts/staging-edge-deploy.mjs` (`npm run staging-edge`)
  has five subcommands: `render`, `deploy`, `reconcile`, `endpoints` and
  `rehearsal`. Each is a dry run unless it is given `--execute`. `deploy`
  runs E10's `prepareEdgeModeDeployment` with EP-9's staging overlay. An
  executed deploy needs `--confirm DEPLOY_STAGING_EDGE` and the dry run's
  candidate sha256.
- **The target library.** `scripts/staging-edge-target.mjs` holds:
  - the closed private inputs schema (`staging-edge-inputs-v1`);
  - the template renderer and the genesis snapshot;
  - the EP-8 fence plan and gcp plan wrappers, validated by the fence's and
    EP-9's own validators;
  - the refusals of every production or reserved Worker name, hostname, D1,
    bucket and rate-limit namespace.
- **The committed inputs.** `ops/staging-edge/` holds:
  - the template, with placeholders only;
  - synthetic example inputs;
  - the stand-in fenced cron Worker and its one heartbeat migration.
- **Changes to existing code.** E10 (`production-edge-mode.mjs`) gains the
  optional `overlay` and `renderTrackedConfig` parameters.
  `recheckProductionEdgeHealth` in `production-deploy.mjs` gains an optional
  `origin`. Their defaults keep production's behaviour: the E10, EP-9, deploy
  and reconcile checks pass unchanged, 106 of 106. These two files are
  therefore no longer blob-identical to the GCP line ([Open](#open)).

**Findings while building it:**

- **Genesis secrets.** Wrangler `4.114.0` refuses to create a Worker whose
  config lists `secrets.required` unless `--secrets-file` supplies them. Its
  code says "required secrets missing before first deploy". The plan's phase
  D order (deploy, then put the three worker-mode secrets) therefore cannot
  work. The genesis deploy takes the owner's 0600 secrets file by path
  instead. The driver checks its metadata only, never reads it, and refuses
  an executed genesis if the Worker already exists.
- **The empty namespace var.** The typed render refuses an empty var, so
  `env.staging`'s empty `TELEMETRY_STORAGE_NAMESPACE` cannot round-trip. JSON
  storage mode never reads it, so the template omits it.
- **Rate-limit profiles.** A typed redeploy reproduces the live limits. The
  `load` profile therefore takes effect only at genesis. Moving a live
  staging edge to it needs its own reviewed change.
- **The stand-in's exports.** The stand-in exports only its handler, because
  workerd refuses a named export that is not a handler.
- **U-4.** Typed schema inspection is skipped for the staging edge's JSON
  topology. Every plan records
  `typedSchemaInspection: "not_applicable_staging_json_topology"`.
- **U-5.** The Access team domain and the owner email are not refused as
  production references. The checks cover this.
- **Sequence numbering.** The requested order runs worker, fenced (EP-8
  drill), abort to worker, gcp, then brake to fenced. It needs a fresh fenced
  step and a fresh fence between the abort and gcp, as the plan's finding 5
  says. `npm run staging-edge -- rehearsal` prints that sequence as R1.0 to
  R2.13, with each step's command and expected outcome.

**Gates.** These ran on the commit's tree:

| Gate | Result |
|---|---|
| `npm run staging-edge:scripts-check` | Exit 0: 29 of 29, then the staging dry run |
| Staging dry run (`npm run staging-edge:dry-run`) | All 19 deploy steps of R1.0 to R2.13 (11 more are EP-8 steps) give their expected outcome through the driver's own dry run, against EP-9's synthetic production snapshot. The worker, fenced, gcp and brake candidates and the stand-in bundle with `wrangler deploy --dry-run` under PATH and HOME only. gcp and the brake keep only `RELEASE_GUARD_DB` and `SPARKLE_RELEASES`; gcp has no crons; all keep the eight rate limits and the Durable Object. Overlay sha256: `3e72fae5…` (worker), `98904b29…` (fenced), `23b4f471…` (gcp, synthetic staging plan) |
| `npm run scripts:check` (apps/worker) | Exit 0: 24 node:test runs, 1,105 pass, 0 fail, then both edge dry runs |
| E10, EP-9, deploy and reconcile checks | 106 of 106, unchanged |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| Repository root `npm run architecture:check` | Passed: 677 production files, 2,861 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this addendum and the runbook section in place | Exit 0: root workspace hygiene clean; documentation governance valid across 289 Markdown files and 1,196 source and config files; 20 of 20 |

## STG-DRV review round

A review of `92137db4` on 2026-10-02 raised six findings and one set of
verified observations. Each finding was reproduced before it was acted on:
the reviewer's synthetic probes were rerun on `92137db4` and gave the stated
results. The fixes are commit `5a604d95`. The evidence is local and
synthetic, on Node.js 26.2.0 and wrangler `4.114.0`. Nothing was deployed,
created or migrated, and no Cloudflare, Google or production endpoint was
called.

| Finding | Disposition | Evidence and change |
|---|---|---|
| High: nothing checks that `--production-inventory` is production's | Accepted and fixed | Reproduced: another Worker's inventory in its place made genesis accept the production `ANALYTICS_DB` id and put it in the candidate. A production inventory (live or baseline) must now be a capture of `app-usagemonitor` in the inputs' account (`STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION`, `STAGING_EDGE_PRODUCTION_ACCOUNT_MISMATCH`). The expected account is the inputs' own, because the staging Custom Domains sit in the production zone (plan R-1, D-S10). One resolver, `resolveStagingEdgeIsolation`, serves render and deploy. EP-9's `productionSnapshots` enforces the same name, against the staging snapshot's account. Negative tests cover the live inventory, the baseline, another account and the reviewer's other-Worker case, in the library, in `prepareStagingEdgeDeployment` and through the render CLI |
| Medium: render checks less than deploy | Accepted and fixed | Reproduced (the reviewer's P2a and P2c). `render` now takes deploy's isolation flags with the same rules: the production inventory and its sha256 (required), `--production-plan` or `--production-plan-absent`, the optional baseline pair, and the production fence plan. They go through EP-9's own rules by the new export `edgeModeStagingProductionReferences`, so a gcp-era inventory without a baseline, or a null plan once production binds gcp values, is refused at render too. Render then runs EP-9's guard on the snapshot the rendered edge config declares, as genesis does. A refused render writes no file. Runbook section 11 is corrected |
| Medium: D1s that only other production Workers bind are never refused | Accepted and fixed, with the first option | Reproduced (P2e). Render and deploy now require the owner-private production EP-8 fence plan and its sha256. It is validated by EP-8's own validator and must name `app-usagemonitor` in the same account. Its ingestion, analytics, deletion-ledger and quarantine entries must equal what the production captures bind, which is EP-8's own label rule. Its four D1s (including the catch-up control D1), its bucket and every script it names are refused. The second option, a read-only D1 lookup per id, was not taken, because it would make render need a token and a network |
| Medium: the genesis existence check fails open | Accepted and fixed | Reproduced (P1): `DEPLOYMENT_AMBIGUOUS`, `READ_REFUSED` and `READ_FAILED` each reached `wrangler deploy`. Genesis now makes one read-only deployments read. Only HTTP 404 whose errors are all Cloudflare's script-not-found code 10007 counts as absent; this is Wrangler's `WORKER_NOT_FOUND_ERR_CODE` and the code EP-8's tests model. A successful read, even of a split deployment, is `STAGING_EDGE_GENESIS_WORKER_EXISTS`. Anything else is `STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN`. The old test that used a generic error as "absent" is replaced by tests for 403, 429, other 404 codes, malformed bodies and a network failure, none of which reach Wrangler. The 10007 shape is not yet observed against the live API |
| Low: R2.5 expects the wrong code for a never-migrated D1 | Accepted, with option (a) | Reproduced with real wrangler `4.114.0` against local D1 state, through production's own `determinePendingD1Migrations`: a fresh D1 gives `PRODUCTION_MIGRATION_STATE_UNKNOWN` (exit 1, "no such table: d1_migrations"). After `wrangler d1 migrations list` the empty ledger exists with nothing applied, and the same gate returns `0001_sparkle_appcast_guard_nonces.sql` pending. Phase B in the runbook now creates the throwaway guard D1 and initialises its ledger that way, and R2.5 keeps `EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING`. The dry run's stub is replaced by production's own reader over a synthetic Wrangler, which answers with rows, an empty ledger, or "no such table". A check covers all three |
| Low: `reconcile --execute` trusts `target.json` | Accepted and fixed | Before any read, `target.json` must hold a valid account, a `staging` Worker name that is not reserved or checked in, and staging domains only. Both the library reconcile and the CLI check it. CLI tests run without a token, so a missed check would surface as a credential error instead |
| Info: gates, dry-run defaults, secret handling, sequence order | Verified observations. No change | The example inputs now use the synthetic production fixture's account, because of the shared-account rule. The overlay sha256s are unchanged |

**Gates.** These ran on `5a604d95`'s tree:

| Gate | Result |
|---|---|
| `npm run staging-edge:scripts-check` | Exit 0: 38 of 38, then the staging dry run |
| Staging dry run | All 19 deploy steps give their expected outcome. R2.5 comes from the real ledger reader. The four candidates and the stand-in bundle under PATH and HOME only. Overlay sha256s unchanged: `3e72fae5…`, `98904b29…`, `23b4f471…` |
| `npm run scripts:check` (apps/worker) | Exit 0: 24 node:test runs, 1,114 pass, 0 fail, then both edge dry runs |
| E10, EP-9, deploy and reconcile checks | 106 of 106; EP-9's staging test gains the new negatives |
| EP-8 fence and edge dry-run checks | 29 of 29 |
| Mutation check (scratch, each file restored) | Each of six mutations fails at least one check. They remove the production-name check in the driver, the production-name check in EP-9, the account check in EP-9, the 10007 rule, the fence-plan D1 refusal and the operation-target check |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| Repository root `npm run test:preflight`, with this section and the runbook changes in place | Exit 0: hygiene clean; documentation governance valid across 289 Markdown files and 1,196 source and config files; 20 of 20 |
| Repository root `npm run architecture:check` | Passed: 677 production files, 2,861 imports, 0 debt edges |

## PROD-5: owner-run steps

Every step below is a protected operation. Each needs the owner's explicit
authorization for that step, and the owner runs it. Nothing here authorizes
one.

- Keep identifiers, inventories, plans and receipts owner-private and outside
  the repository.
- Supply `CLOUDFLARE_API_TOKEN` only through the approved credential
  mechanism.
- Never print a secret value.

The maintained procedure is
[Production edge modes](../runbooks/production-edge-modes.md). The section
numbers below refer to it. This list records the order for PROD-5 as of this
receipt. It reconciles the secret order with OWN-6b in the owner's cutover
checklist: the secrets go on after P1 and before the fence.

### 0. Deploy line and toolchain

1. **Name the deploy line (OD-E1).** It is this branch, or a descendant of it
   that the owner names as the production release line. It must contain
   `d43c8f92` and every commit above. If it does not, E10 refuses
   `EDGE_MODE_SOURCE_NOT_DESCENDANT`.
   - Never use `claude/release-candidate-d43c8f92`, or any line that carries
     #257 or #258. OD-OAI-1 keeps that release off Cloudflare.
   - On any other commit past `d43c8f92`, merge the port. Then rerun on the
     merged commit:
     - the EP-1 and pre-admission specs;
     - the header ratchet;
     - the production and staging dry-run bundle diff;
     - `npm run edge:modes:dry-run`;
     - E12.
2. **Check Node.js.** Use a Node.js release that strips TypeScript types by
   default (section 1). 24.14.0 and 26.2.0 were verified. Node.js 22.16.0
   fails: on it, `--edge-mode` reports only `PRODUCTION_DEPLOYMENT_FAILED` or
   `PRODUCTION_RECONCILE_FAILED`.
3. **Run the local gates.** From a clean checkout of that commit, run the
   local validation in Production service operations. Then, from
   `apps/worker`, run `npm run edge:scripts-check` and the edge specs
   (section 1).

### 1. Create and migrate the release-guard D1

Follow section 2. In summary:

- Create the database with
  `npx wrangler d1 create tibotattle-release-guard`. Use the same location
  hint as the production D1 databases.
- Record its id only in the owner-private gcp plan.
- Apply the one migration through a throwaway private config that binds only
  `RELEASE_GUARD_DB`. The config must use the absolute
  `release-guard-migrations` directory and the default `d1_migrations` table.
- Confirm that nothing is pending, then delete the config.

The worker and fenced modes never bind this database.

### 2. Confirm the edge-tier bindings

Follow section 3. In the current private inventory, all six bindings must be
live:

- `ENROLLMENT_RATE_LIMIT`
- `RECOVERY_RATE_LIMIT`
- `CLIENT_ATTEMPT_RATE_LIMIT`
- `PUBLIC_READ_RATE_LIMIT`
- `UPLOAD_INGRESS_REQUEST_RATE_LIMIT`
- `UPLOAD_INGRESS_CLIENT_RATE_LIMIT`

### 3. Baseline and read-only reconciliation

1. Capture a fresh owner-private inventory of the active version and pin its
   sha256.
2. Run the read-only reconciliation on the deploy commit:

   ```bash
   npm run production:reconcile -- \
     --inventory <fresh-private-inventory.json> \
     --inventory-sha256 <fresh-inventory-sha256> \
     --expected-previous-source d43c8f92a059d9c577776f7eca8a331eb305b8a6 \
     --output-directory <new-private-output-directory> \
     --edge-mode worker
   ```

   It must report a compatible candidate whose `edge.edgeMode` is `worker`.

### 4. Staging-edge rehearsal

Rehearse worker, fenced (with an EP-8 drill) and gcp on the staging edge. Do
this before the first production use of each mode, as
`design/staging-edge-plan-2026-10-02.md` in the parity home lays out. The
gating rehearsal (R1 and R2 there) must run from this line.

At the port's head (`218fa91a`) this step was blocked: no typed staging-edge
driver existed, and EP-9's staging overlay was only a library. STG-DRV is now
on this line, with E10 ([addendum](#addendum-stg-drv-the-typed-staging-edge-driver)).
The owner-run procedure is section 11 of the runbook. The owner runs it in
this order:

1. Phases A to C and G of the plan: `npm run staging-edge -- render` with
   the production isolation inputs (the production inventory, the production
   gcp plan or its absence, and the production EP-8 fence plan), the six
   D1s (the throwaway guard D1's ledger initialised empty, never migrated),
   buckets, migrations, stand-in and Access application.
2. R1, from genesis to the abort and release.
3. Phase F.
4. R2.

The gcp half (R2) still needs the staging origin: D-CRB, the staging OPS-2
apply and the verifier smoke.

### 5. Worker-mode edge deploy (P1)

After steps 0 to 4, run this from `apps/worker` on the deploy commit, with
the inventory from step 3, or a newer one if anything changed:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source d43c8f92a059d9c577776f7eca8a331eb305b8a6 \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  --retained-public-source <reviewed-full-public-source-sha> \
  --expected-live-manifest-sha256 <reviewed-live-manifest-sha256> \
  --edge-mode worker
```

- **What changes.** This is the typed path with the worker overlay: `main`
  becomes `src/edge-entry.ts` and `EDGE_UPSTREAM_MODE` is `worker`. Nothing
  else changes.
- **The public site.** The retained public release tree must be the exact live
  site. A privacy page that carries the gcp marker is refused
  (`EDGE_PRIVACY_PAGE_PREMATURE`). Build or restore the tree on this line: it
  stages through this line's asset allowlist, which differs from the fast-path
  line's ([Changing the public site](../runbooks/production-edge-modes.md#changing-the-public-site)).
  Keep this deploy's operation journal directory unmodified: it is the
  evidence a later website rollback to this site names.
- **Verify.** Check these:
  - public health reports the deploy commit as `deployment.sourceCommit`;
  - one version serves 100%, with the matching `DEPLOYMENT_SOURCE_COMMIT` and
    `EDGE_UPSTREAM_MODE=worker` bindings;
  - the public surface is unchanged.
- **Recapture.** The deploy created a new version, so recapture the baseline
  again.
- **An uncertain outcome.** Follow the typed recovery
  (`RECONCILE_TYPED_PRODUCTION_DEPLOYMENT`, section 4). Never retry with raw
  Wrangler.

### 6. Put the edge secrets

Follow section 5. Put them in worker mode, after P1 and before the fence:

1. **`EDGE_INVOKER_KEY_JSON`.** One JSON key of the edge-invoker service
   account.
   - If organization policy blocks key creation, request the exception for
     this account only (owner decision, 2026-10-02).
   - Pipe the key into the put, then delete every local copy.
   - Rotate it every 90 days.
2. **`EDGE_CLIENT_KEY_SECRET`.** A fresh value of at least 32 characters,
   generated inside the pipe. It must never equal `IDENTITY_LINK_SECRET`.

Keep `SPARKLE_APPCAST_GUARD_TOKEN` and `DISTRIBUTION_ANALYTICS_API_TOKEN`.

After each put:

1. Confirm one version at 100%, unchanged `DEPLOYMENT_SOURCE_COMMIT` and
   `EDGE_UPSTREAM_MODE` bindings, and unchanged public health.
2. Recapture the baseline. Only the version id and the new `secret_text` name
   may differ.
3. Rerun the worker-mode reconciliation from step 3.

Two behaviours stay unverified until the staging rehearsal (U-2):

- that a put against this Worker copies the active version's bindings
  unchanged;
- that piping a key through stdin works.

**The other order.** The code also accepts the secrets before P1, and that
order is equally inert. If the key is ready earlier, the owner may put the
secrets first. P1 must then use an inventory captured after the puts.

PROD-5 is complete when steps 1 to 6 are done and the last baseline is
recaptured. After that, `none` → `fenced` and `worker` → `gcp` are refused.
The next edge step is the fence, at the cutover window. After the switch, the
only brake is gcp → fenced (OWN-10).

## Open

- **STG-DRV.** Built on this line ([addendum](#addendum-stg-drv-the-typed-staging-edge-driver)).
  The staging rehearsal itself (R1 and R2) is owner-run and has not run. Its
  gcp half waits for the staging origin.
- **E10 and EP-9 differ from the GCP line.** STG-DRV adds optional
  parameters to `production-edge-mode.mjs` and `production-deploy.mjs`; their
  defaults keep production's behaviour. Its review round tightens EP-9's
  staging variant in `edge-mode-configuration.mjs`. The production captures
  must be `app-usagemonitor` in the staging account, and a new export,
  `edgeModeStagingProductionReferences`, exposes its references. Production's
  own overlay is unchanged. Port these, or reconcile the copies, when the lines merge.
- **The staging-edge plan.** `design/staging-edge-plan-2026-10-02.md` in the
  parity home, outside this repository, still lists five D1s in phase B and
  takes no production fence plan. The runbook's section 11 supersedes it on
  both points.
- **The E12 S0 fix.** `41bd9702` is not merged into
  `claude/gcp-fastpath-final`. Until it is, E12 gates this port only from a
  worktree that carries it.
- **Two decision record copies.** This line's reads "accepted" and links this
  line's runbook. The GCP line's reads "proposed". Reconcile them when the
  lines merge. Reconcile the two runbook texts at the same time.
- **The secret order.** This line's runbook and the owner steps follow OWN-6b:
  after P1, before the fence. The GCP line's runbook says the same.
- **OD-E6.** The owner's private receipt records a production-zone address
  probe pass on 2026-10-02 (OWN-7). E10 does not check it, and the receipt
  is not in this repository.
- **E12's cross-line limits.**
  - S0's "today's main" bundle comes from this tree only with the fix.
  - The reference Worker's migrations and sanitized variables come from the
    GCP line's tree.
  - The worker-mode neutrality comparison above covers the first for this
    tree.
- **Client-disconnect cancellation.** It stays unproven, as on the GCP line.
- **Node.js engines.** The root `engines` field still allows Node.js 22.13.
  The Worker operator scripts need a release that strips types by default.
  Narrowing `engines` is a repository-wide decision that this port does not
  make.
