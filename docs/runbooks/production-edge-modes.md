---
title: Production edge modes
date: 2026-10-02
type: runbook
status: maintained
---

# Production edge modes

> **Not yet operational.** This runbook becomes operational at P1, the first
> typed worker-mode edge deploy from this line. Until then,
> [Production service operations](./production-operations.md) governs every
> Cloudflare operation. After P1 its Cloudflare sections stay authoritative
> wherever this runbook does not replace them. Nothing here authorizes a
> deploy, a D1 creation or migration, a secret change, a writer fence, a GCP
> write or a cutover. Each is a separate operation that the owner authorizes
> and runs.
>
> **Production-line text.** This is the production line's version of the GCP
> line's runbook of the same name (`claude/gcp-fastpath-final` at
> `1bea3b5f`). The edge code it describes is blob-identical on both lines. This
> text differs in five places: the deploy-line rule, the release-guard D1
> procedure, the secret order, the Node.js requirement, and the local gates.
> It also adds section 11, the staging-edge rehearsal. Its driver (STG-DRV)
> exists only on this line.
> Files that exist only on the GCP line are written as paths. Take exact flags
> from this line's code.

The production Worker's thin edge has three modes: `worker`, `fenced` and
`gcp`. This runbook covers:

- the typed deploy for each mode;
- the release-guard D1;
- the edge secrets;
- the writer fence, the brake and the abort;
- the pre-gcp verifier;
- releases in gcp mode;
- the local proof;
- the staging-edge rehearsal.

Authority:

- The contract is the accepted
  [thin Worker edge proxy decision](../decisions/2026-10-01-thin-worker-edge-proxy.md).
  The owner approved it as written on 2026-10-02.
- The order of the cutover belongs to PT-9's cutover runbook, which is planned
  and not yet written. Until it exists, two documents record the intended
  sequence: the owner's cutover checklist and the GCP fast path plan
  (`docs/plans/2026-10-01-gcp-fastpath.md` on the GCP line). This runbook never
  decides the order on its own.
- The [port receipt](../receipts/2026-10-02-gcp-edge-port-production.md) is
  point-in-time evidence for the port. It is not a procedure.

## Never

- **No new front door.** Add no load balancer in front of Cloud Run, no
  Transform Rule and no DNS change, and do not remove or move a custom domain.
  The three hostnames stay custom domains of the same Worker in every mode.
- **No guard-only Worker.** The Sparkle appcast guard stays in the production
  Worker.
- **No untyped deploy.** Do not deploy from the checked-in `env.production`,
  and never run raw `wrangler deploy`. Every edge deploy, reconciliation and
  recovery goes through the typed path. The commands enforce this:
  `production:deploy` without `--inventory`, and `product:web-release:deploy`
  without its inventory and live-site pins, are refused before anything runs
  (`PRODUCTION_UNTYPED_DEPLOY_REFUSED`). So is the release publication's
  website step, which passes no pins.
- **No version split.** Use no gradual deployment on this Worker. Exactly one
  version serves 100%.
- **No edge deploy from the wrong line.** Never deploy the edge from the GCP
  line. Never deploy it from a line that carries the post-cutover OpenAI
  release (#257 or #258), such as `claude/release-candidate-d43c8f92`: the
  owner's OD-OAI-1 keeps that release off Cloudflare.
- **No edge secret outside the Worker.** An edge secret must never be in Google
  Secret Manager, on the origin, in the repository, in a log or in a receipt.
- **No identity token at rest.** An identity token must never be in a file, a
  log, a receipt, shell history or a command-line argument.

## 1. Deploy line, toolchain and local gates

### The deploy line

- **The line.** Deploy the edge from the edge-port line,
  `claude/gcp-edge-port-d43c8f92`. It is cut from
  `d43c8f92a059d9c577776f7eca8a331eb305b8a6`, the source production serves.
  You may also deploy from a descendant of it, but only one that the owner
  names as the production release line (OD-E1).
- **Descent.** The deploy commit must contain the live
  `DEPLOYMENT_SOURCE_COMMIT`. If it does not, E10 refuses with
  `EDGE_MODE_SOURCE_NOT_DESCENDANT`.
- **Other commits.** The named line may carry commits beyond `d43c8f92` other
  than the port. If so, merge the port there. Then rerun these on the merged
  commit before any edge deploy:
  - the EP-1 and pre-admission specs;
  - the request-header ratchet;
  - the production and staging dry-run bundle diff against the live source;
  - `npm run edge:modes:dry-run`;
  - E12.

  A clean textual merge proves none of these.

### Node.js

Several Worker operator scripts import TypeScript sources directly. This
predates the edge: at `d43c8f92`, `accountless-migration-operator.mjs` and the
two qualification preparers already import `src/mutation-barrier.ts`. The EP-9
overlay (`edge-mode-configuration.mjs`) and E10 (`production-edge-mode.mjs`)
import `src/edge-origin-contract.ts`.

- **Use a Node.js release that strips TypeScript types by default.** 24.14.0
  and 26.2.0 were verified here. Node.js documents the default as starting in
  22.18.0. Check `node --version` before any edge operation.
- **On Node.js 22.16.0 these imports fail** with `ERR_UNKNOWN_FILE_EXTENSION`:
  - `npm run scripts:check` and `npm run edge:scripts-check` fail visibly.
  - An `--edge-mode` deploy fails closed before any journal or remote call,
    reporting only `PRODUCTION_DEPLOYMENT_FAILED`.
  - An `--edge-mode` reconciliation fails the same way, reporting `blocked`
    with `PRODUCTION_RECONCILE_FAILED`.

  Ordinary deploys and reconciliations without `--edge-mode` still load,
  because they load the edge module only on request.

### Local gates

On the clean deploy commit, run the
[local validation](./production-operations.md#local-validation-before-an-owner-deploy).
Then, from `apps/worker`:

```bash
npm run edge:scripts-check
npx vitest run test/edge-*.spec.ts test/distribution-analytics*.spec.ts
```

`edge:scripts-check` runs in this order (`scripts:check` also runs it):

1. the R2 inventory, writer fence, EP-9, E10 and dry-run checks;
2. the edge-mode dry run (section 10);
3. `staging-edge:scripts-check`: the staging driver's checks and the staging
   dry run (section 11).

**Endpoint check on every deploy.** Every deploy, with or without
`--edge-mode`, runs the deployment endpoint check. That check now also
validates the edge public surface:

- The public route hosts must include the apex and `www`.
- The admin host must stay separate.

Today's endpoints pass. A failure there is an endpoint-configuration fault, not
an edge-mode fault.

### Gates before the gcp deploy

- **E12.** The local end-to-end check must pass for the edge commit against the
  origin commit (section 10).
- **The address probe (OD-E6).** It must have passed from the
  `tibotattle.com` zone. The owner's private receipt records a pass on
  2026-10-02 (checklist item OWN-7): no header carrying a visitor's address
  reached the origin. E10 does not check this, so the operator confirms it
  before the switch.
- **The staging rehearsal.** Rehearse worker, fenced (with an EP-8 drill) and
  gcp on a staging Worker before the first production use of each mode. The
  staging Worker has its own hostnames, Access application and Cloud Run
  service. STG-DRV, the typed staging driver, is on this line with E10
  (section 11). The gating rehearsal runs from the deploy line.

## 2. Release-guard D1

The gcp overlay binds only one D1 database: `RELEASE_GUARD_DB`. It holds the
Sparkle appcast guard's nonces. The worker and fenced modes never bind it, so
creating and migrating it changes nothing that serves traffic. Create it once,
at any time before the first gcp deploy. No edge deploy applies a migration.

1. **Create it.** From `apps/worker`, use the same location hint as the
   production D1 databases:

   ```bash
   npx wrangler d1 create tibotattle-release-guard
   ```

   The name is fixed (`EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME`).
   Record the returned database id only in the owner-private gcp plan.
2. **Write a throwaway config.** Make it private (mode 0600) and keep it
   outside the repository. It:
   - binds only this database, as `RELEASE_GUARD_DB`;
   - sets `migrations_dir` to the absolute path of
     `apps/worker/release-guard-migrations`;
   - keeps the default migrations table, `d1_migrations`. The gcp deploy reads
     that table.
3. **Apply and list the migrations:**

   ```bash
   npx wrangler d1 migrations apply tibotattle-release-guard --remote --config <private-config>
   npx wrangler d1 migrations list tibotattle-release-guard --remote --config <private-config>
   ```

   The list must show nothing pending. The only migration is
   `0001_sparkle_appcast_guard_nonces.sql`. It creates the nonce table with
   the same statements as `migrations/0029`.
4. **Delete the throwaway config.**

A gcp deploy reads the ledger and refuses
`EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING` while anything is pending.

## 3. Edge-tier rate-limit bindings

In the current owner-private inventory, confirm that the live version binds all
six Workers Rate Limiting bindings that the edge evaluates:

- `ENROLLMENT_RATE_LIMIT`
- `RECOVERY_RATE_LIMIT`
- `CLIENT_ATTEMPT_RATE_LIMIT`
- `PUBLIC_READ_RATE_LIMIT`
- `UPLOAD_INGRESS_REQUEST_RATE_LIMIT`
- `UPLOAD_INGRESS_CLIENT_RATE_LIMIT`

Worker mode does not check them. A gcp deploy refuses
`EDGE_MODE_ADMISSION_BINDING_MISSING` without them.

## 4. Typed deploys, reconciliation and recovery

### Deploys

Start from the
[guarded typed deployment](./production-operations.md#guarded-deployment-wrapper).
It uses:

- the live inventory and its pinned sha256;
- the reviewed previous source;
- the retained public source and the live manifest sha256, or, for a changed
  site, the candidate flags in
  [Changing the public site](#changing-the-public-site).

E10 adds the flags below. Each flag also accepts the `--name=value` form.

| Mode | Added flags | Typical use |
|---|---|---|
| `worker` | `--edge-mode worker`. After a fence, also `--fence-receipt <verified fence receipt> --fence-receipt-sha256 <its sha256>` | P1, the first edge-entry deploy; any later worker-mode redeploy, including web-only releases before the fence; the abort |
| `fenced` | `--edge-mode fenced` | Starting the fence; the brake from gcp |
| `gcp` | `--edge-mode gcp --edge-plan <private gcp plan> --origin-commit <origin commit> --origin-verifier-account <verifier account>` | The switch, with the privacy-marker candidate site; gcp redeploys, including web-only releases and website rollbacks |

The parser accepts exactly these combinations. It refuses any other
combination before anything runs: the command prints its refusal code and
usage, and exits 2.

**Without `--edge-mode`.** Once the live version carries an
`EDGE_UPSTREAM_MODE` binding (from P1 on), a typed deploy without
`--edge-mode` is refused before any snapshot or journal
(`EDGE_MODE_REQUIRED_FOR_EDGE_LIVE`). Its plain render would install the
checked-in entry in place of the edge entry and skip every edge gate,
including the privacy-page rule. `product:web-release:deploy` has no edge
mode, so from P1 on it is refused in both forms: with its typed pins by this
rule, and without them always (`PRODUCTION_UNTYPED_DEPLOY_REFUSED`). See
[Changing the public site](#changing-the-public-site).

### Changing the public site

A typed deploy pins the public site in one of two closed ways. They never mix.

| Site | Flags | Before the upload | After the upload |
|---|---|---|---|
| Kept | `--retained-public-source <live site's source sha> --expected-live-manifest-sha256 <live manifest sha256>` | The live manifest is the pinned one. The staged site is exactly that manifest, built from the retained source | The live manifest is still the pinned one |
| Changed | `--candidate-public-manifest-sha256 <candidate sha256>`; one of `--web-release-receipt <receipt>`, or `--rollback-web-release-receipt <receipt>` with `--rollback-release-operation <that release's archived journal>`; and `--replaced-public-source <live site's source sha> --replaced-live-manifest-sha256 <live manifest sha256>` | The live manifest is the replaced one, and its source provenance matches the replaced source commit. The staged site is exactly the candidate manifest, built from the receipt's source commit | The live manifest is the candidate |

**Prepare on this line.** Both rows stage the site with this line's
`stage-production-assets.mjs`, and a changed site's receipt is re-verified by
this line's web-only lane. Both allowlists differ from the fast-path line's:
this line stages `feature-value.png` where that line stages
`feature-value.jpg`, and only this line's lane admits the cache-reuse matrix,
feature insights, feature-value image and model performance files. So build P1's retained tree and
prepare every receipt and generated site (the switch's, each web-only
release's, each rollback's) on this line. One prepared on the fast-path line
can fail here.

A changed site needs `--edge-mode worker` or `--edge-mode gcp`, so the
privacy-page rule always runs. The receipt is the one
`product:web-release:prepare` writes
([web-only release lane](./2026-08-17-web-only-release.md)); its path must be
absolute, under the checkout's `.release-build`, and outside the generated
site. Before the inventory is read or anything remote runs, the deploy
re-verifies the receipt with the lane's own checks (scope, catalogue proofs,
and the generated site in `.release-build/public-release-site`), then:

- **A release (`--web-release-receipt`).** The receipt must be fresh: its
  source is the checked-out commit, which becomes the deploy source, and its
  base is `--expected-previous-source`, the live commit the shared lock
  rechecks.
- **A rollback (`--rollback-web-release-receipt`).** The receipt is a
  previously released site, with that release's generated site restored into
  `.release-build/public-release-site`. Its source must be the live commit or
  an ancestor of it. The deploy source stays the checked-out commit, and the
  staged site is pinned to the receipt's source commit, which must also be an
  ancestor of the deploy source. A receipt proves a site's bytes and scope,
  not that the site was ever live, so `--rollback-release-operation` names
  the operation journal of the typed production deploy that left the site
  live: the `journal/` of that release's
  [archive entry](./2026-08-17-web-only-release.md#5-archive-the-release),
  used in place. The journal must be a verified typed production
  deploy whose state still matches its binding digest. The site it left live
  (the candidate it shipped, or the retained site it kept) must be the
  receipt's manifest built from the receipt's source commit, and its deploy
  commit must be on the live line.
- **Either way** the receipt's manifest must be the candidate, and the
  operation journal records the candidate (and, for a rollback, its source
  commit) so typed recovery rechecks the right site.
- **The replaced pair is proven, not trusted.** Before the upload the live
  manifest must be `--replaced-live-manifest-sha256`, `--replaced-public-source`
  must be the live commit or one of its ancestors, and the live manifest's
  source provenance must match that commit's public source files, read from
  Git. The journal therefore records a replaced source that produced the live
  site.

Refusals, all before any upload:

| Code | Cause |
|---|---|
| `PRODUCTION_CANDIDATE_SITE_EDGE_MODE_REQUIRED` | A candidate without `--edge-mode` |
| `PRODUCTION_CANDIDATE_SITE_FENCED` | A candidate with `--edge-mode fenced`. Releases pause while fenced; the brake keeps the live site |
| `PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT` | A candidate with `--retained-public-source` or `--expected-live-manifest-sha256` |
| `PRODUCTION_CANDIDATE_SITE_UNCHANGED` | The candidate equals the replaced live manifest. A deploy that keeps the site uses the retained pair |
| `PRODUCTION_ARGUMENTS_INVALID` | No receipt, both receipts, a relative receipt path, a rollback without an absolute `--rollback-release-operation` or that flag on a release, a missing replaced pin, no inventory, `--confirm-migrations`, or a malformed value |
| `PRODUCTION_CANDIDATE_RECEIPT_INVALID` | The lane refuses the receipt: wrong shape, scope or catalogue proof, or the generated site no longer matches it |
| `PRODUCTION_CANDIDATE_RECEIPT_MISMATCH` | The receipt's manifest is not the candidate |
| `PRODUCTION_CANDIDATE_RECEIPT_STALE` | A release receipt whose source is not the checked-out commit, or whose base is not the live commit |
| `PRODUCTION_ROLLBACK_RECEIPT_NOT_ON_LIVE_LINE` | A rollback receipt whose source is not the live commit or one of its ancestors |
| `PRODUCTION_ROLLBACK_OPERATION_INVALID` | The rollback's journal is missing or unreadable, is not a verified typed production deploy, or its state no longer matches its binding digest |
| `PRODUCTION_ROLLBACK_SITE_NOT_RELEASED` | The journal's deploy did not leave this site live: another manifest, another source commit, or a deploy commit off the live line. A receipt prepared after the fact for a site no deploy shipped ends here |
| `PRODUCTION_REPLACED_PUBLIC_SOURCE_NOT_ON_LIVE_LINE` | `--replaced-public-source` is not the live commit or one of its ancestors |
| `PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN` | The live manifest matched its sha256, but its source provenance does not match `--replaced-public-source` (or that commit cannot be read) |
| `PRODUCTION_CANDIDATE_PUBLIC_SOURCE_NOT_ANCESTOR` | A rollback site's source commit is not in the deploy source |
| `PRODUCTION_PUBLIC_ASSETS_INVALID` | The staged site is not exactly the candidate manifest from its pinned commit |
| `PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_INVALID` | The live manifest is not the replaced one before the upload, or not the candidate after it |

The privacy-page rule then applies to the candidate as to any site:
`EDGE_PRIVACY_PAGE_PREMATURE` for a marked candidate in worker mode or before
the switch, and `EDGE_PRIVACY_PAGE_NOT_CUTOVER` for an unmarked candidate in
gcp mode, including a rollback to a site from before the switch.

The gcp plan is EP-9's closed plan. It holds:

- the Cloud Run origin URL;
- the audience;
- the edge-invoker account;
- an optional headers timeout;
- the release-guard D1's id and name.

It holds identifiers, so keep it owner-private and outside the repository.

**Refusals before any upload.** The deploy refuses:

- `--edge-mode` outside the typed path (`EDGE_MODE_REQUIRES_TYPED`).
- A transition outside EP-9's matrix (`EDGE_MODE_TRANSITION_FORBIDDEN`). The
  allowed transitions are:
  - none → worker
  - worker → worker
  - worker → fenced
  - fenced → fenced
  - fenced → gcp
  - fenced → worker
  - gcp → gcp
  - gcp → fenced

  For fenced → worker, E10 walks the deployment history back to the fenced
  deployment that the verified EP-8 fence receipt names. When it cannot, it
  refuses with `EDGE_MODE_FENCE_HISTORY_INCOMPLETE`.
- A source that does not descend from the live commit
  (`EDGE_MODE_SOURCE_NOT_DESCENDANT`).
- A source without the edge entry (`EDGE_MODE_ENTRY_UNAVAILABLE`).
- For gcp:
  - a missing edge-tier binding (`EDGE_MODE_ADMISSION_BINDING_MISSING`);
  - a missing edge secret (`EDGE_MODE_SECRET_MISSING`);
  - a pending release-guard migration
    (`EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING`);
  - a pre-gcp verifier answer that names another origin commit
    (`EDGE_ORIGIN_COMMIT_MISMATCH`);
  - a contract blob that differs between the edge commit and the origin
    commit (`EDGE_CONTRACT_DRIFT`);
  - a candidate site without the privacy marker
    (`EDGE_PRIVACY_PAGE_NOT_CUTOVER`).
- For worker, fenced and pre-gcp deploys: a candidate site that carries the
  privacy marker (`EDGE_PRIVACY_PAGE_PREMATURE`).

**Verify the mode after the deploy:**

| Mode | Identity | Public surface |
|---|---|---|
| `worker` | Today's health-based checks: `deployment.sourceCommit` is the candidate. One version serves 100%, and its `EDGE_UPSTREAM_MODE` binding is `worker` | Unchanged from the pre-edge Worker |
| `fenced` | One version at 100% whose `DEPLOYMENT_SOURCE_COMMIT` and `EDGE_UPSTREAM_MODE` bindings match | Public `GET /api/health` is barrier health for the commit. `/api/ready`, the API, admin, the Sparkle guard and the Apple paths answer `503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`. `www` asset paths redirect, and `/release-site-manifest.json` answers 200 |
| `gcp` | As for fenced, from the Cloudflare bindings | Public `/api/health` reports status `ok` with the origin commit. A `RETIRED_SECRET_PRESENT` warning is expected until the owner deletes the retired storage secrets |

Every deploy creates a new version. Afterwards, capture the private inventory
again and pin its new sha256 before the next typed operation.

### Read-only reconciliation

Inspect the candidate that an edge deploy would install with
`npm run production:reconcile`. Pass the usual inventory, inventory sha256,
expected previous source and new private output directory, and add:

- `--edge-mode <mode>`;
- for gcp, `--edge-plan <private gcp plan>`.

For example, on the worker-mode baseline:

```bash
npm run production:reconcile -- \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  --expected-previous-source <live source sha> \
  --output-directory <new-private-output-directory> \
  --edge-mode worker
```

A worker-mode baseline must report a compatible candidate whose
`edge.edgeMode` is `worker`. In gcp mode no typed role is bound, so the typed
schema inspection is skipped (`EDGE_MODE_GCP_TYPED_ROLES_UNBOUND`).

### Recovering an uncertain edge deploy

An edge deploy pins its mode, and for gcp its plan, in the operation journal.
Recover an uncertain outcome only with the typed recovery in
[Production service operations](./production-operations.md#guarded-deployment-wrapper):

```bash
npm run production:deploy -- --confirm RECONCILE_TYPED_PRODUCTION_DEPLOYMENT \
  --operation <private-typed-operation-directory> --executor-stopped \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  [--edge-plan <the pinned private gcp plan>]
```

- **Arguments.** Recovery takes no `--edge-mode`, because the mode is already
  pinned. Add `--edge-plan` only for a gcp operation.
- **Plan refusals.** E10 refuses `EDGE_MODE_PLAN_REQUIRED` when a pinned gcp
  operation has no plan, and `EDGE_MODE_PLAN_MISMATCH` when the plan differs
  from the pin.
- **What recovery rechecks.** It re-binds the pinned mode and repeats the
  contract rule. It compares the live configuration with the edge-mode
  fingerprint and rechecks the public surface for that mode.
- **What not to use.** The generic `RECONCILE_PRODUCTION_DEPLOYMENT` refuses
  typed pins. Never retry the deploy, and never use raw Wrangler to work
  around a refusal.

## 5. Edge secrets

### Provisioning

The owner puts two Worker secrets on `app-usagemonitor`, in worker mode,
**after P1 and before the fence**. This is the order of OWN-6b in the owner's
cutover checklist. PROD-5, the worker-mode edge deploy, is complete only after
P1, both puts and the recaptured baseline.

The code also accepts the secrets before P1, and that order is equally inert:

- `d43c8f92`'s Worker and the worker-mode edge never read them.
- The typed render carries every live secret name forward.
- Only a gcp deploy requires them.

If the invoker key is ready before P1, the owner may put the secrets first.
P1 must then use an inventory captured after the puts.

Put each secret through the approved credential mechanism. Run each put from a
directory with no wrangler configuration.

1. **`EDGE_INVOKER_KEY_JSON`.** One JSON key of the edge-invoker service
   account, which holds only `run.invoker` on the production service.
   - If organization policy blocks key creation, request the exception for
     this account only (owner decision, 2026-10-02).
   - Pipe the key into
     `npx wrangler secret put EDGE_INVOKER_KEY_JSON --name app-usagemonitor`.
   - Then delete every local copy.
2. **`EDGE_CLIENT_KEY_SECRET`.** A fresh random value of at least 32
   characters. It is used only at the edge and must never equal the origin's
   `IDENTITY_LINK_SECRET`. Generate it inside the pipe, for example
   `openssl rand -hex 32 | npx wrangler secret put EDGE_CLIENT_KEY_SECRET --name app-usagemonitor`.

Keep `SPARKLE_APPCAST_GUARD_TOKEN` and `DISTRIBUTION_ANALYTICS_API_TOKEN`. The
gcp overlay requires both.

Each put creates and deploys a new version at 100%. After each put:

1. Confirm one version at 100%, unchanged `DEPLOYMENT_SOURCE_COMMIT` and
   `EDGE_UPSTREAM_MODE` bindings, and unchanged public health.
2. Recapture the baseline. Capture the private inventory again and pin its new
   sha256. Compared with the previous inventory, only the version id and the
   new `secret_text` name may differ.
3. Run the read-only worker-mode reconciliation (section 4). It must report a
   compatible candidate.

Two behaviours stay unverified until the staging rehearsal (the staging plan's
U-2):

- that `wrangler secret put` against this Worker copies the active version's
  bindings unchanged;
- that piping a key file through stdin works.

The recapture checks the first.

### Rotation

**`EDGE_INVOKER_KEY_JSON`, every 90 days:**

1. The owner creates a new key for the edge-invoker account.
2. Put it as the secret.
3. In gcp mode, confirm that forwarded requests succeed. For example, public
   `GET /api/health` returns the origin's 200, not
   `503 EDGE_ORIGIN_UNAVAILABLE`.
4. Delete the old key in Google Cloud.
5. Recapture the baseline.

**`EDGE_CLIENT_KEY_SECRET`:**

- Rotating it changes every address rate-limit key, so every per-address
  window resets once.
- Rotate it only on suspected exposure, not on a schedule. Then recapture the
  baseline.

**Retired storage secrets.** After the gcp switch, they stay listed with a
warning until the owner deletes them in a separately authorized step.

## 6. Fence, brake and abort

### Fence

While the fence is up, every API, admin, sign-in and release path answers
`503 MUTATION_BARRIER_ACTIVE` with `retry-after: 300`. Release publishing and
web-only releases pause, because the Sparkle guard is blocked. How long the
fence stays up depends on the export and import, which the cutover runbook
orders.

1. Run the typed fenced deploy and verify it ([section 4](#4-typed-deploys-reconciliation-and-recovery)).
2. Run EP-8 from `apps/worker`. Supply `CLOUDFLARE_API_TOKEN` through the
   approved credential mechanism.

   ```bash
   node scripts/cloudflare-writer-fence.mjs inventory --plan=<private fence plan> --receipts=<private receipts directory>
   node scripts/cloudflare-writer-fence.mjs plan --plan=<private fence plan> --receipts=<private receipts directory>
   node scripts/cloudflare-writer-fence.mjs apply --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256> --analytics-drain-complete
   node scripts/cloudflare-writer-fence.mjs verify --plan=<private fence plan> --receipts=<private receipts directory> \
     --fence=<plan receipt sha256>
   ```

   - `inventory` and `plan` are read-only. Review the writer set. `plan` prints
     the receipt sha256 that `apply` takes as `--confirm`.
   - `--analytics-drain-complete` is the operator's statement that every
     in-flight Cloudflare erasure and analytics-delivery job has finished.
     EP-8 records the statement; it does not prove it.
   - Run `verify` after the plan's quiet window, at least 15 minutes after
     `apply`. Its fence receipt pins the D1 bookmarks and the R2 digest that
     the export must use.

**The fence plan.** It is a closed, owner-private file. It names:

- the account and the production Worker;
- the fenced scripts, each with its expected crons or queue;
- the four D1 databases and the quarantine bucket;
- any out-of-scope scripts, each with a reason;
- the quiet window.

The receipts directory must be private (mode 0700). Keep the plan and the
receipts outside the repository.

### Abort, before any gcp version

1. While the fence is still applied, run the typed worker-mode deploy with
   `--fence-receipt` and `--fence-receipt-sha256`.
   - Fenced → worker is allowed only while no gcp-mode version has been
     deployed since the fence began.
   - E10 proves that from the verified fence receipt. Its reader refuses the
     receipt once the fence is released.
   - The receipt exists only after EP-8's `verify`. Before it, there is no
     typed path back to worker mode.
2. Then release the fence from `apps/worker`:

   ```bash
   node scripts/cloudflare-writer-fence.mjs release --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256> --pre-gcp
   ```

   The release restores the exact prior schedules and queue delivery from the
   apply journal. It is refused once any gcp-mode version has been deployed
   since the fence.

Writes then resume, so any seal or export taken under that fence is no longer
valid. A later attempt needs a fresh fence.

### Brake, after the switch

The only brake is gcp → fenced: a typed fenced deploy with no plan. This is the
owner's rollback decision of 2026-10-02 (OWN-10): brake to fenced, then fix
forward. Gcp → worker is refused.

- Forwarded routes then answer `503 MUTATION_BARRIER_ACTIVE` with
  `retry-after: 300`, and the edge stops forwarding.
- The Cloudflare writers stay fenced.
- The only way out of the brake is fenced → gcp, which runs every gcp check
  again.

## 7. Pre-gcp verifier

Before the gcp deploy, and wherever the cutover runbook asks for origin
readiness, an operator checks the origin through a verifier account. At the
origin, the verifier may only make plain `GET /api/health` and
`GET /api/ready` requests.

- **Owner prerequisites.** The verifier account holds `run.invoker` on the
  production service only (EP-7's optional verifier). The operator may
  impersonate it.
- **Token.** The gcp deploy mints the token itself from
  `--origin-verifier-account`. It runs `gcloud auth print-identity-token` with
  `--impersonate-service-account`, `--audiences` (the plan's audience) and
  `--include-email`, without a shell, and keeps the token in memory. The token
  is never printed, passed as an argument or written.
- **Pass condition.** Both reads return 200 with the origin marker and secure
  JSON headers. The verifier records the origin commit, which becomes the gcp
  deploy's `--origin-commit`.
- **Receipts.** They hold statuses and the origin commit only, never a token,
  an email or a key.

## 8. Releases and deploys in gcp mode

### The switch's site

The switch (EP-10) is the first changed-site deploy in gcp mode: the
privacy-marker site ships in the same deploy as the mode. Build it as a
web-only candidate of the fenced commit:

1. The switch commit differs from the live fenced commit only inside the
   [web-only closure](./2026-08-17-web-only-release.md#1-establish-the-source-boundary):
   the privacy page, the browser localization, the paired i18n catalogue and
   mirror, and their focused tests. Every other change, including edge code
   and repository documentation, lands before P1 or after the switch.
2. Prepare it with `product:web-release:prepare --base <live fenced commit>`,
   on this line: the lane's allowlist and the staged asset set differ between
   the edge-port and fast-path lines, so a receipt or generated site prepared
   on one can fail on the other.
3. Deploy, from `apps/worker` on the switch commit:

   ```bash
   npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
     --expected-previous-source <live fenced commit> \
     --inventory <fresh-private-inventory.json> \
     --inventory-sha256 <fresh-inventory-sha256> \
     --candidate-public-manifest-sha256 <the receipt's site.manifestSha256> \
     --web-release-receipt <absolute path of .release-build/web-release-receipt.json> \
     --replaced-public-source <live site's source sha> \
     --replaced-live-manifest-sha256 <live manifest sha256> \
     --edge-mode gcp \
     --edge-plan <private gcp plan> \
     --origin-commit <origin commit> \
     --origin-verifier-account <verifier account>
   ```

`--replaced-public-source` is the source of the site PROD-5 kept: the commit
it pinned with `--retained-public-source`. Without the candidate the switch is
refused `EDGE_PRIVACY_PAGE_NOT_CUTOVER`; with the retained pair added it is
refused `PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT`.

Once the switch is verified, archive it from `apps/worker` on the switch
checkout with `npm run production:release-archive` ([Archive the
release](./2026-08-17-web-only-release.md#5-archive-the-release)): its
journal, receipt and privacy-marker site are the rollback point for the
switch's site.

### Web-only releases

From P1 on, a web-only release is a changed-site deploy through
`production:deploy` with the live mode (`--edge-mode worker` before the
fence, `--edge-mode gcp` after the switch; the owner's round 12 decision).
`product:web-release:deploy` is refused: with its typed pins
`EDGE_MODE_REQUIRED_FOR_EDGE_LIVE` (it has no edge mode), and without them
`PRODUCTION_UNTYPED_DEPLOY_REFUSED`, which also applies before P1.

1. Prepare the candidate with the
   [web-only release lane](./2026-08-17-web-only-release.md) on this line,
   with the live commit as `--base`.
2. Deploy it as in [the switch's site](#the-switchs-site), with the live
   commit as `--expected-previous-source`. In gcp mode keep the gcp plan,
   `--origin-commit` (the live origin commit) and the verifier account; in
   worker mode use `--edge-mode worker` alone.
3. Once it is verified, archive it with `npm run production:release-archive`
   ([Archive the release](./2026-08-17-web-only-release.md#5-archive-the-release)).

E10 applies the mode's rules. In gcp mode no Cloud Run redeploy is needed;
the predecessor and post-deploy identity come from the Cloudflare bindings,
the contract blob at the release commit must equal the blob at the live
origin commit, and the candidate's privacy page must carry the marker. Before
the switch, a candidate must not carry the marker. While the fence is up,
web-only releases pause.

### Website rollback

Roll the site back by re-deploying a previously released site by its
receipt, not by deploying an old checkout. Only a site that a verified typed
production deploy left live can come back; a receipt prepared later for
another commit is refused (`PRODUCTION_ROLLBACK_SITE_NOT_RELEASED`).

1. Archive every release after it is verified ([Archive the
   release](./2026-08-17-web-only-release.md#5-archive-the-release)): the
   switch, each web-only release and each rollback. The entry keeps the
   deploy's operation journal, private and as the deploy left it, with the
   release's receipt and generated site. Prepare them on this line: a receipt
   or site prepared on the fast-path line can fail here. Never edit an entry.
2. On a clean checkout of the live commit, or a descendant of it, restore the
   entry's `public-release-site` into `.release-build/public-release-site` and
   its `web-release-receipt.json` anywhere under `.release-build` outside that
   directory.
3. Deploy as in [the switch's site](#the-switchs-site), with
   `--rollback-web-release-receipt <restored receipt>` in place of
   `--web-release-receipt`, plus
   `--rollback-release-operation <the entry's journal directory>` (the
   archived journal, used in place), the entry index's `manifestSha256` as
   the candidate, and the live site as the replaced pair. On a checkout of
   the live commit itself, also pass a fresh, absolute private `--operation`
   directory: the default one for that commit holds the earlier deploy's
   journal (`RELEASE_OPERATION_EXISTS_USE_RESUME`).

The site PROD-5 kept has PROD-5's journal as its evidence; archive that
journal with the kept site's web-release receipt and generated site in the
same way. That needs a receipt whose source is the retained source and whose
manifest is the live one, which this line's lane still accepts; find it
before PROD-5. Without one, or if the archive refuses it
(`PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID`,
`PRODUCTION_RELEASE_ARCHIVE_RECEIPT_MISMATCH`), the kept site is not a
rollback target: keep and record the journal, and restore that site, if
needed, with a revert commit
([A deploy that kept the site](./2026-08-17-web-only-release.md#5-archive-the-release)).
A site live only before the typed journals, with no verified typed journal,
cannot be a rollback target either.

In gcp mode a rollback past the switch is refused
(`EDGE_PRIVACY_PAGE_NOT_CUTOVER`): the restored site must carry the marker.
Rolling the edge back is the brake, not a site rollback.

### Cloud Run deploys

Before every origin deploy, check that
`git rev-parse <origin commit>:apps/worker/src/edge-origin-contract.ts` equals
the same blob at the live edge commit. Read the live edge commit from the
Cloudflare `DEPLOYMENT_SOURCE_COMMIT` binding. Refuse the deploy if the blobs
differ. The origin deploy tooling does not implement this check yet.

A contract change has no in-place path:

1. Brake to fenced.
2. Deploy the origin.
3. Run the gcp deploy from an edge commit with the same contract blob.

### Reading edge failures

Edge logs are content-free JSON lines.

| Client sees | Log | Meaning |
|---|---|---|
| `503 EDGE_NOT_CONFIGURED`, `retry-after: 60` | One warn line naming the code | The mode variable is missing or unknown, the gcp configuration is invalid, or the proxy could not be built (for example, the invoker key is unreadable) |
| `503 EDGE_ORIGIN_UNAVAILABLE`, `retry-after: 60` | `edge_upstream_unavailable` with `EDGE_TOKEN_UNAVAILABLE` | The token mint failed. Every forwarded request fails until the ten-second negative cache expires |
| The same | `edge_upstream_unavailable` with `EDGE_UPSTREAM_TIMEOUT` or `EDGE_UPSTREAM_NETWORK` | The origin did not answer in time, or the connection failed |
| The same | `edge_upstream_unavailable` with `EDGE_UPSTREAM_UNMARKED` | The answer had no origin marker. Google's front end refused, Cloud Run was overloaded, or the origin boundary returned its 421 |
| Admin 403 or 503 | `edge_admin_chokepoint_refused` | The Access chokepoint refused a forwarded admin-host request |
| Overview without Cloudflare download figures | `edge_distribution_merge_skipped` | The merge failed, and the origin's bytes were served unchanged |

## 9. After the switch

- **Integration commit.** Moving the checked-in `wrangler.jsonc` `main` to
  `src/edge-entry.ts` is a later integration commit (decision record, section
  16). Until then, only the typed overlay names the edge entry.
- **GCP-line documents.** These documents move to this line with the cutover
  documentation:
  - the cutover runbook;
  - the edge receipt;
  - the address-probe README (`apps/worker/scripts/edge-ip-probe/README.md`
    on the GCP line);
  - the live check (`apps/worker/scripts/edge-live-check.mjs` on the GCP line).

## 10. Local proof

### On this line

`npm run edge:modes:dry-run` renders each mode's candidate the way a typed
`--edge-mode` deploy does. It uses EP-9's synthetic live snapshot and follows
worker → (edge secrets put) → fenced → gcp. It bundles each candidate with
`wrangler deploy --env production --dry-run`:

- Wrangler runs with only PATH and HOME set, so no Cloudflare credential
  reaches it.
- It uses a one-file synthetic site.
- It makes no remote call.

It requires:

- in every mode: the edge entry, the six edge rate-limit bindings and the
  Durable Object;
- in worker and fenced: the four data bindings;
- in gcp: only `RELEASE_GUARD_DB` and `SPARKLE_RELEASES`, and no crons;
- outside gcp: no release-guard D1.

### E12, across the lines

E12 is the local end-to-end check. It lives on the GCP line
(`apps/worker/postgres-test/edge-origin-e2e.spec.mjs` there). It builds the
edge from this tree and runs it in workerd, in every mode. The origin is the
GCP line's fast-path origin on PostgreSQL 17, behind a Google front-end
emulator.

From the GCP line's `apps/worker`, under Node.js 22 (the image runtime), with a
local PostgreSQL 17 cluster:

```bash
node cloud-run/build.mjs
PG_TEST_SOCKET=<local PostgreSQL 17 socket> PG_TEST_PORT=<port> \
  EDGE_E2E_EDGE_TREE=<this line's worktree>/apps/worker \
  node --test --test-concurrency=1 postgres-test/edge-origin-e2e.spec.mjs
```

- **The contract blob.** `EDGE_E2E_EDGE_TREE` refuses unless this tree's
  `src/edge-origin-contract.ts` is byte-identical to the origin's.
- **The S0 fix.** S0 compares worker mode with this tree's own `main` only
  with the harness fix `41bd9702`, which is on branch
  `claude/gcp-edge-e2e-edge-tree`. Until that fix is merged into the GCP
  line, run E12 from a worktree that has it.
- **The golden stage.** Add `EDGE_E2E_GOLDEN=analytics-v2-test/golden` for
  this stage. It seeds through the fast-path rehearsal, so set
  `EDGE_E2E_REHEARSAL_NODE` to a Node.js release that strips types by default.
- **Run time.** A run took about seven minutes here. It drops every schema
  it creates.

**E12 qualifies:**

- the edge bundle in all three modes and the unconfigured state;
- the token-mint and forward path, against a synthetic token issuer;
- the pre-admission guards and address admission, compared with this line's
  Worker at the checked-in production limits;
- shipped-client flows through the edge;
- privacy and transparency assertions on every forwarded exchange;
- worker-mode equality with this tree's `src/index.ts` bundle.

**E12 does not qualify:**

- Google's front end;
- Cloudflare's network and real client addresses (the probe observes those);
- Workers Rate Limiting across locations;
- Access;
- custom domains;
- the production origin composition (CR-6 and CR-7);
- production data;
- that a client disconnect cancels the forward. This stays unproven.

**Cross-line limits.** The reference Worker applies the GCP line's
`migrations/` and its sanitized `env.production` variables.

The optional live check (OD-E3) against the GCP test origin runs from the GCP
line only. Each of its tiers needs the owner's authorization.

## 11. Staging-edge rehearsal

The staging edge is a separate Worker with its own name, hostnames, Access
application, D1 databases, buckets, rate-limit namespaces and release-guard
D1. The staging-edge plan (`design/staging-edge-plan-2026-10-02.md` in the
parity home) owns its design, the owner proposals D-S1 to D-S10 and the
resource names. The owner creates every Cloudflare and Google Cloud resource
and runs every command marked as a write. Nothing here authorizes one.

**What it proves.** The rehearsal qualifies the edge mechanics on a Worker
that can fail without touching production:

- the three modes and their transitions;
- the EP-9 overlay and its isolation guard;
- the EP-8 fence and the abort;
- the edge secrets and their puts;
- the edge-tier limits and the Access chokepoint;
- the release-guard D1;
- forwarding to a real Cloud Run origin.

It does not qualify the production zone, the production Access application,
the production hostnames, production data, the CR-6 and CR-7 origin
composition, Workers Rate Limiting across production locations, or the
signed-release and updater paths. A pre-P run, from a line other than the
deploy line, qualifies only that line's mechanics.

### The driver

`npm run staging-edge -- <subcommand>` runs `scripts/staging-edge-deploy.mjs`
from `apps/worker`. Every subcommand is a dry run unless it is given
`--execute`. It drives the staging Worker through E10's own gates:
`prepareEdgeModeDeployment` runs with EP-9's staging overlay
(`applyEdgeModeStagingOverlay` and `applyEdgeModeStagingSnapshotDelta`), bound
to the production isolation inputs. The transition matrix, the fence-history
rule for the abort, source descent, the entry and contract blobs, the six
edge-tier bindings, the edge secrets, the pre-gcp origin verifier, the
contract-blob identity, the release-guard migration gate and the
privacy-marker rule are therefore production's code paths, aimed at the
staging Worker.

| Subcommand | Dry run (default) | With `--execute` |
|---|---|---|
| `render` | Takes the same production isolation inputs as `deploy` and runs the same refusals, then EP-9's guard on the rendered edge config. Prints the digests of every rendered file. `--write --output-directory <new private dir>` writes the files | Not accepted |
| `deploy` | Runs every pre-upload gate. Writes the candidate config and a content-free `plan.json` into a new private output directory | Also needs `--confirm DEPLOY_STAGING_EDGE` and `--expected-candidate-sha256 <the dry run's candidateConfigSha256>`. It recaptures the predecessor, deploys with Wrangler and verifies the captured live version |
| `reconcile` | Compares a captured private staging inventory with a deploy's plan: `verified`, `not_deployed` or `drift` | Checks the operation's `target.json` names the staging Worker, then captures the inventory itself, read-only |
| `endpoints` | Prints the per-mode public-surface matrix | Reads it, with GET only and no credentials |
| `rehearsal` | Prints the R1 and R2 sequence with each step's expected outcome | Not accepted |

### Inputs and refusals

- **The template.** `apps/worker/ops/staging-edge/staging-edge.template.jsonc`
  is committed with placeholders only. It starts from the checked-in
  `env.staging` vars and changes only what the plan's section 3.2 lists.
  JSON storage mode never reads `TELEMETRY_STORAGE_NAMESPACE`, so the template
  omits it. It holds the two rate-limit profiles, `rehearsal` and `load`, in
  namespaces 4001 to 4008.
- **The inputs.** The owner's private, non-secret inputs file, mode 0600 and
  outside the repository, follows
  `apps/worker/ops/staging-edge/staging-edge-inputs.example.json` (schema
  `staging-edge-inputs-v1`). It holds:
  - the account, which is production's: the staging Custom Domains sit in
    the production zone, so the staging edge shares production's account;
  - the two Worker names;
  - the public hostname (the admin hostname is derived);
  - the Access team domain, AUD and owner email;
  - the five D1 ids and names;
  - the two buckets;
  - the rate-limit profile;
  - the stand-in cron;
  - the fence quiet window;
  - the staging origin, or `null` until it exists.

  It never holds a secret.
- **Production isolation inputs.** Every `render` and every `deploy` takes
  the same owner-private inputs, under the same rules:
  - the production inventory and its sha256 (`--production-inventory`,
    `--production-inventory-sha256`). It must be a capture of
    `app-usagemonitor` in the inputs' account. Another Worker's capture would
    empty the refused set of every live production reference, so it is
    refused (`STAGING_EDGE_PRODUCTION_INVENTORY_NOT_PRODUCTION`), as is
    another account's (`STAGING_EDGE_PRODUCTION_ACCOUNT_MISMATCH`);
  - the production gcp plan (`--production-plan`) from the moment the owner
    creates the production origin and guard D1 (OWN-12), or
    `--production-plan-absent` before then;
  - after the production gcp switch, a pre-gcp production inventory
    (`--production-baseline-inventory` and its sha256), under the same
    identity rule. Without it the data D1s are no longer evidenced, and EP-9
    refuses (`EDGE_MODE_STAGING_INPUT_INVALID`);
  - the production EP-8 fence plan and its sha256 (`--production-fence-plan`,
    `--production-fence-plan-sha256`), the closed file of
    [section 6](#fence). It is the only evidence of the catch-up control D1,
    which only the separate catch-up consumer binds, and of the other
    production scripts. It must pass EP-8's own validator
    (`STAGING_EDGE_PRODUCTION_FENCE_PLAN_INVALID`) and name `app-usagemonitor`
    in the same account. Its ingestion, analytics, deletion-ledger and
    quarantine entries must be what the production captures bind
    (`STAGING_EDGE_PRODUCTION_FENCE_PLAN_MISMATCH`).
- **Refusals.** Every Worker, D1 and bucket name must contain `staging`, and
  the public hostname needs a `staging` label below its zone. Render and
  deploy both refuse, before anything is rendered or written:
  - a production or reserved Worker name (`STAGING_EDGE_PRODUCTION_WORKER`):
    `app-usagemonitor`, the existing `app-usagemonitor-staging`, every name in
    `wrangler.jsonc` and `wrangler.dogfood.jsonc`, and every script the
    production fence plan names;
  - a production hostname (`STAGING_EDGE_PRODUCTION_HOSTNAME`): the five
    production hostnames, every checked-in route and the production
    captures' domains and routes;
  - a production D1 id or name (`STAGING_EDGE_PRODUCTION_DATABASE`): the
    checked-in ones, the production captures' (the baseline's after the
    switch), `tibotattle-release-guard`, the production gcp plan's guard D1
    and the production fence plan's four D1s, including the catch-up control
    D1;
  - a production bucket (`STAGING_EDGE_PRODUCTION_BUCKET`);
  - a production origin, audience or invoker account
    (`STAGING_EDGE_PRODUCTION_ORIGIN`);
  - a checked-in rate-limit namespace (`STAGING_EDGE_PRODUCTION_RATE_LIMIT`);
  - a staging inventory that is not the staging Worker's
    (`STAGING_EDGE_INVENTORY_TARGET_MISMATCH`), such as production's own.

  `render` then runs EP-9's guard on the snapshot the rendered edge config
  declares, as genesis does. EP-9 refuses any production reference on the
  live staging version, the rendered config or the gcp plan
  (`EDGE_MODE_STAGING_PRODUCTION_REFERENCE`).

### Render the resources (plan phases B, C and G)

```bash
npm run staging-edge -- render --inputs <private inputs.json> \
  --production-inventory <private production inventory> --production-inventory-sha256 <sha256> \
  --production-plan-absent \
  --production-fence-plan <private production fence plan> --production-fence-plan-sha256 <sha256> \
  --write --output-directory <new private directory>
```

Use `--production-plan <file>` in place of `--production-plan-absent` once
the production gcp plan exists, and add the baseline pair after the switch.

It writes these files, each mode 0600:

- `staging-edge.tracked.json`: the rendered staging config, for review;
- `standin.wrangler.json`: the stand-in fenced cron Worker;
- one `migrations-<role>.wrangler.json` for each D1;
- `fence-plan.json`: the EP-8 plan, validated by the fence's own validator;
- `gcp-plan.json`: the staging gcp plan, validated by EP-9, once the inputs
  name the origin.

**The stand-in.** `apps/worker/ops/staging-edge/catchup-standin/` is a cron
Worker that binds only `STORAGE_ANALYTICS_CATCHUP_CONTROL_DB`. Each run
inserts one heartbeat row (the scheduled time and the cron). That gives the
fence's quiescence proof real writes and invocations to see stop. Apply its
migration, then deploy it with `wrangler deploy --config
<directory>/standin.wrangler.json --strict`.

**The D1 migrations.** Apply each with `wrangler d1 migrations apply
<database name> --remote --config <directory>/migrations-<role>.wrangler.json`,
then list them to confirm that nothing is pending. Mark the data D1s pre-P
until the owner names P's migration tail.

**The throwaway guard D1 (for R2.5, N2).** Phase B also creates a sixth D1,
for example `tibotattle-staging-release-guard-throwaway`. Never apply a
migration to it:

1. Copy the inputs file, change only `d1.releaseGuard` to the throwaway's id
   and name, and render that copy into its own new private directory.
2. Run `wrangler d1 migrations list <throwaway name> --remote --config
   <that directory>/migrations-release-guard.wrangler.json`. Wrangler 4.114.0
   creates the empty `d1_migrations` ledger before it lists, and applies
   nothing. Confirm that exactly `0001_sparkle_appcast_guard_nonces.sql` is
   listed as pending.

R2.5 then names that copy. The gate reads an empty ledger, so 0001 is
pending. Without step 2 the ledger table does not exist, Wrangler's read fails
with `no such table: d1_migrations`, and the gate refuses
`PRODUCTION_MIGRATION_STATE_UNKNOWN` instead. Delete the throwaway at
teardown.

### Typed deploys

Each `deploy` run needs a new private output directory outside the
repository. It writes these files, each mode 0600:

- `candidate.wrangler.json`, with absolute entry, site and migration paths;
- `plan.json`;
- the baseline and expected snapshots;
- `target.json`.

After an executed run it also writes:

- `operation.json`, saved before Wrangler runs;
- `post-deploy-inventory.json`;
- `receipt.json`.

`plan.json` is content-free. It holds:

- the modes and the transition identity;
- the overlay sha256 and the contract blob;
- the source and previous source;
- the inventory sha256 and the two fingerprints;
- `candidateConfigSha256`;
- the release-guard pending count;
- `typedSchemaInspection: "not_applicable_staging_json_topology"`;
- the exact Wrangler arguments.

| Mode | Flags beyond the common ones |
|---|---|
| Genesis `worker` | `--genesis`. With `--execute`, also `--secrets-file <owner-private 0600 file>` |
| `worker` | The live inventory: `--inventory`, `--inventory-sha256`, `--expected-previous-source`. After a fence, `--fence-receipt` and `--fence-receipt-sha256` |
| `fenced` | The live inventory |
| `gcp` | The live inventory, `--origin-commit` and `--origin-verifier-account`. The plan comes from the inputs' origin and the staging release-guard D1. Add `--candidate-site` when the site is built from the source |

The common flags are `--inputs`, the production isolation inputs
(`--production-inventory` and its sha256, `--production-plan` or
`--production-plan-absent`, `--production-fence-plan` and its sha256, and the
baseline pair after the switch), `--site <candidate site directory>` and
`--output-directory`.

**Two differences from production:**

- **Genesis.** The first deploy has no live predecessor, so source descent
  and the fence history do not apply. It checks null → worker, the entry and
  contract blobs, and the staging overlay and isolation guard on the snapshot
  the rendered config declares. Wrangler refuses to create a Worker with
  required secrets unless `--secrets-file` supplies them. The driver checks
  that file's metadata only (regular, mode 0600, the caller's) and hands it
  to Wrangler by path, so its contents are never read. Delete the file after
  the deploy. Before Wrangler runs, an executed genesis reads the Worker's
  deployments once. Only a positive not-found lets it proceed: HTTP 404 whose
  errors are all Cloudflare's script-not-found code 10007. A successful read
  is refused `STAGING_EDGE_GENESIS_WORKER_EXISTS`, even a split deployment.
  Anything else, such as a 403 from a token without read scope, a 429 or a
  network failure, is refused `STAGING_EDGE_GENESIS_EXISTENCE_UNKNOWN`.
  R1.1, the first worker → worker redeploy, then runs every E10 gate.
- **Typed schema inspection.** It does not apply to the staging edge's JSON
  topology (U-4), so it is skipped, and the plan says so.

**An executed deploy:**

1. Requires a clean checkout at the planned source.
2. Requires the dry run's candidate bytes.
3. Runs the workspace-package guard.
4. Recaptures the live staging version. It refuses
   `STAGING_EDGE_PREDECESSOR_CHANGED` unless the version is the planned
   baseline. Genesis makes the existence read above instead.
5. Saves `operation.json` with outcome `outcome_unknown`.
6. Runs `wrangler deploy --config <candidate> --env production --strict`.
   Wrangler gets only `PATH`, `HOME` and `CLOUDFLARE_API_TOKEN`. An endpoint
   override is refused.
7. Captures the new version. It requires the expected fingerprint (for
   genesis, the candidate config), a new version, and EP-9's live check with
   the staging domains.

`CLOUDFLARE_API_TOKEN` comes from the approved credential mechanism. It is
never printed, written or put in an error. On an uncertain outcome, run
`reconcile`; never retry with raw Wrangler. `reconcile --execute` first checks
the operation's `target.json`: a valid account, a `staging` Worker name that
is not reserved or checked in, and staging domains only. It refuses anything
else before it builds the read-only provider.

### Endpoints

After each deploy, run `npm run staging-edge -- endpoints --edge-mode <mode>
--inputs <private inputs> --expected-source <edge commit> [--origin-commit
<origin commit>] --execute`. It checks the following:

- **Health.** Public health is checked with E10's edge health rule against the
  staging origin. Fenced must be barrier health. Worker must report the edge
  commit and gcp the origin commit.
- **Retained site.** The release manifest answers 200, and the root carries no
  dashboard marker.
- **Fenced.** `/api/ready` answers `503 MUTATION_BARRIER_ACTIVE`.
- **Forbidden paths.** Every forbidden path follows the mode table of
  `check-deployment-endpoints.mjs`.
- **Admin host.** An unauthenticated request to the admin host must redirect
  to the Access team domain in every mode (N10).

The staging Worker has no `www` host, so the `www` redirect is not checked.

### The sequence

`npm run staging-edge -- rehearsal` prints every step with its command and its
expected outcome. Run each deploy step without `--execute` first and compare
the result with the expected outcome. Then rerun only the ok steps with
`--execute`. Never execute a refusal step. Worker → gcp is forbidden, so the
abort and gcp are separated by a fresh fenced step and a fresh fence.

| Steps | Transition | Expected |
|---|---|---|
| R1.0 | Genesis, none → worker | ok |
| R1.1 | worker → worker | ok |
| R1.2 | worker → gcp (N3) | `EDGE_MODE_TRANSITION_FORBIDDEN` |
| R1.3 | worker → fenced | ok; the stand-in's heartbeats still increase |
| R1.4 to R1.7 | EP-8 `inventory`, `plan`, `apply`, `verify` | ok; after the quiet window there are no heartbeat writes and no stand-in invocations |
| R1.8 | fenced → fenced | ok |
| R1.9 | fenced → gcp, inputs with origin `null` | `EDGE_MODE_PLAN_REQUIRED` |
| R1.10 | fenced → gcp before phase F (N1) | `EDGE_MODE_SECRET_MISSING` |
| R1.11 | fenced with a marked site (N4) | `EDGE_PRIVACY_PAGE_PREMATURE` |
| R1.12 | fenced → worker without the fence receipt | `EDGE_MODE_TRANSITION_FORBIDDEN` |
| R1.13 | Abort: fenced → worker with the fence receipt | ok |
| R1.14 | EP-8 `release --pre-gcp` | ok; the exact cron returns |
| R1.15 | EP-8 `verify` on the released fence (N7) | `FENCE_RELEASED` |
| Phase F | The four gcp secrets, in worker mode | Recapture the inventory after each put |
| R2.0 to R2.4 | worker → fenced, then a fresh fence in a new receipts directory | ok |
| R2.5 | fenced → gcp naming the throwaway guard D1, whose ledger phase B initialised empty (N2) | `EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING` |
| R2.6 | fenced → gcp without `--candidate-site` | `EDGE_PRIVACY_PAGE_NOT_CUTOVER` |
| R2.7 | The switch: fenced → gcp | ok, with the stated `RETIRED_SECRET_PRESENT` warning |
| R2.8 | gcp → gcp | ok |
| R2.9 | Brake: gcp → fenced | ok |
| R2.10 | fenced → worker after gcp | `EDGE_MODE_TRANSITION_FORBIDDEN` |
| R2.11 | EP-8 `release --pre-gcp` after gcp (N6) | `FENCE_RELEASE_AFTER_GCP` |
| R2.12, R2.13 | fenced → gcp, then the brake again | ok; the rehearsal ends fenced |

The gcp drills in the plan's section 7 R2 step 5 are manual owner steps
between R2.7 and R2.9:

- the `CLIENT_ATTEMPT_RATE_LIMIT` exhaustion (N9);
- the invoker-key rotation;
- the revoked-key drill (N8).

Record each cycle in a content-free receipt, as the plan's section 10 says.

**Limits:**

- **Rate-limit profiles.** A typed redeploy reproduces the live limits. A
  profile therefore takes effect only at genesis. Moving a live staging edge
  to the `load` profile is not a mode transition and needs its own reviewed
  change.
- **The gcp half.** It needs the staging origin, D-CRB, the staging OPS-2
  apply and the verifier smoke.
- **Remote reads in a dry run.** A dry run still makes the gcp origin
  verifier, the fence-history and the release-guard ledger reads. Each needs
  its credential.

### Local proof

`npm run staging-edge:dry-run` makes no remote call:

1. It renders the template with the synthetic example inputs, against EP-9's
   synthetic production snapshot and a synthetic production fence plan that
   matches it.
2. It walks every deploy step of the sequence through the driver's own dry
   run, and each step must give its expected outcome. The release-guard gate
   is production's own reader over a synthetic Wrangler that answers as
   Wrangler 4.114.0 does: rows for the migrated guard D1, an empty ledger for
   the throwaway, and exit 1 with `no such table: d1_migrations` for a D1
   whose ledger was never created. The fence steps only move the simulated
   fence; `cloudflare-writer-fence.check.mjs` covers EP-8 itself.
3. It bundles four candidates and the stand-in with `wrangler deploy
   --dry-run`, under PATH and HOME only. The candidates are the genesis
   worker, fenced, gcp and the brake.

`npm run staging-edge:scripts-check` runs the driver's checks and then that dry
run.
