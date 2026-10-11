---
title: GCP admin processing and reconstruction progress
date: 2026-10-11
type: plan
status: in-progress
---

Implement against origin base `2fd6d050d29e15db69de91effeb7355592136294`
in an isolated branch. No production reads, pushes, migrations or rollout.

- Map journal head, delivery cursor/backlog, queued publication days, published
  heads and the last recorded refresh to bounded aggregate reads in one
  REPEATABLE READ READ ONLY snapshot. Use statement and lock timeouts.
- Preserve unavailable evidence: missing/invalid cursor, active execution,
  incremental lanes, checkpoints and per-owner graph/history counters.
  `analytics_v2_runs` records completed work atomically; an in-flight refresh
  is invisible, and automatic failures leave no row. Never infer either state.
- V3 requires exact graph/history counters that GCP cannot provide. Add a closed
  version 4 for the full refresh evidence. The Worker serves the embedded admin
  assets in GCP mode, so this requires an edge deploy separately from the origin.
- Derive the next nominal 03:00 UTC slot from the owner-specified cadence;
  explicitly leave scheduler enablement unavailable. It is not an execution ETA.
- Validate synthetic PostgreSQL 17 fixtures (normal, uncommitted in-flight,
  recorded failure, queued days, missing/invalid cursor), route composition,
  browser projection/rendering, regenerated embedded assets and rebuilt origin.
- Keep the reader outside the analytics kernel closure. Merge forward from the
  named origin line if its local tip advances, and revalidate affected gates.

Owner post-roll acceptance: both panels render recorded aggregate evidence;
the queued-days count equals the overview's publication rebuild count for the
same cursor/journal snapshot. Verify unavailable counters remain labelled and
the new edge client accepts the origin response. Local tests do not qualify
production behavior.
