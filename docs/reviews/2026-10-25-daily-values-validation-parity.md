---
title: Daily-values validation equivalence
date: 2026-10-25
type: review
status: verified-source
---

This records the bounded source and PostgreSQL comparison for PR #300's
`daily-values-closed-shape` vendor patch. It does not qualify an image,
deployment, release, or production performance.

## Change and identity

The validator reads enumerable own keys once. An exact key-set match returns
without sorting; every mismatch uses the historical sorted-delimiter comparison.
This preserves unusual property names, NUL-delimiter collisions, and proxy
descriptor behavior. No arithmetic, schema, price, or timeout changes.

The supported generator retained source commit
`62ad218f1991e1b4fd36cd1938491ae4b5e1ce8a`. The candidate daily-values source SHA-256 is
`4c12cfa2378b522d5832fb24d6b9b0b45c6cbcaebe0c34ff371e8a4c4fcec16e`.
Kernel 20 appends to the immutable registry with compute closure
`1383e2082bdbeb22f3797e67b6ad393889679df74e06bba354058a51a34e3886`
and vendor manifest
`efa67f483a896244b2e829c670dfef4cbc1153e92daa840702bec4d41139cc4e`.

## Retained regression coverage

`vendor-daily-values-shape.spec.ts` compares independently bundled candidate and
Git-blob-verified historical source graphs. Seven tests cover all eight actual key
lists, enumerable/own-property boundaries, malformed nested state, arithmetic
refusals, getters, stateful proxies, delimiter collisions, legacy normalization,
and exact bounded-fold/finalization output. The existing 900-record checked versus
trusted fold test retains every intermediate serialized comparison and its
five-second limit.

## One-time PostgreSQL comparison

Node 26.2.0 and PostgreSQL 17.11 ran the existing active direct-seed fixture through
the real readers, compute pipeline, store, and public route. The baseline was
`e2e4bb47031fd4378daf65863aa1db81cb942e39` with kernel 19; the candidate had the
verified kernel-20 identities above. The private local cluster had TCP disabled.

- Four owners and four owner-days retained ten refusals, one published day and
  two blocked days; this deliberately includes sparse/refused outcomes.
- All 28 dynamically discovered analytics tables were compared after each of two
  complete refreshes: 56 matching canonical table digests, with 16 populated tables.
- Existing clock, UUID and memory-probe injection points fixed operational
  metadata. No value, timing or memory columns were discarded. Only explicitly
  validated kernel IDs, code hashes and the recomputed compatibility stamp were
  substituted between variants; raw digests were also retained.
- Public status, headers and all 1,247 response bytes matched, with SHA-256
  `826c68849b7c4eabf9d79f39a4ee1d9f95f3ef46d4c8f793bafd8fbbb8421237`.
  Each second refresh published nothing and retained those exact response bytes.
- Source identities were checked again after execution. Both temporary schemas
  were removed and the private cluster was stopped.

The temporary comparison harness SHA-256 was
`ae8a0bab874156d6e50c6a9aaa177baafd327e8c081a0dbda7398157bdd2619c`.
This is a bounded equivalence observation, separate from the committed regression
tests and hosted CI results.
