import assert from "node:assert/strict";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createParser, digest, METHOD, MAX_STATE_BYTES, INFERENCE_TIMING_PARSER_VERSION } from "../src/providers/codex/inference-timing.js";
import { ingestTimingFile, openTimingStore, readTimingRows } from "../src/platform/inference-timing-store.js";

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const KEY = Buffer.alloc(32, 17);
const event = (at, type, payload = {}) => ({
  timestamp: new Date(BASE + at).toISOString(),
  type: "event_msg",
  payload: { type, ...payload },
});
const record = (at, type, payload) => ({
  timestamp: new Date(BASE + at).toISOString(), type, payload,
});
const meta = (extra = {}, at = 0) => record(at, "session_meta", {
  id: "synthetic-child", forked_from_id: "synthetic-parent", ...extra,
});
const setting = (at, thread, value = "priority") => event(at, "thread_settings_applied", {
  thread_id: thread, thread_settings: { service_tier: value },
});
function turn(start, thread, turnId, model = "gpt-6.1-sol") {
  const finish = start + 2000;
  return [
    record(start, "turn_context", { turn_id: turnId, model, effort: "high" }),
    event(start, "task_started", { turn_id: turnId }),
    event(start + 1500, "item_completed", {
      thread_id: thread, turn_id: turnId, item: { type: "Reasoning" },
      started_at_ms: BASE + start + 500, completed_at_ms: BASE + start + 1500,
    }),
    record(start + 1500, "token_usage_record", {
      thread_id: thread, turn_id: turnId, response_id: turnId + "-response",
      usage: { output_tokens: 100, reasoning_output_tokens: 50 },
      turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 },
    }),
    event(finish, "task_complete", {
      turn_id: turnId, duration_ms: 2000, time_to_first_token_ms: 500,
    }),
  ];
}
function parse(rows, saved = null, offset = 0) {
  const result = [];
  const parser = createParser(KEY, saved, (value) => result.push(value));
  rows.forEach((row, index) => parser.line(Buffer.from(JSON.stringify(row)), offset + index + 1, false));
  return { result, parser };
}

test("a paginated fork records its own new turn with matching session evidence", () => {
  const rows = [
    meta({ history_mode: "paginated" }),
    setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn"),
  ];
  const expected = parse(rows).result;
  assert.equal(expected.length, 1);
  assert.equal(expected[0].model, "gpt-6.1-sol");
  assert.equal(expected[0].speed_mode, "fast");
  assert.equal(expected[0].ttft, 500);
  assert.equal(expected[0].sample_tokens, 100);
  for (let split = 1; split < rows.length; split++) {
    const prefix = parse(rows.slice(0, split));
    const saved = JSON.parse(JSON.stringify(prefix.parser.state()));
    const suffix = parse(rows.slice(split), saved, split);
    assert.deepEqual([...prefix.result, ...suffix.result], expected, "checkpoint " + split);
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-child|synthetic-parent|child-turn/u);
  }
});

test("a paginated fork can carry one parent header before its own work", () => {
  const parentHeader = record(0, "session_meta", { id: "synthetic-parent" });
  const rows = [meta({ history_mode: "paginated" }), parentHeader,
    setting(500, "synthetic-child"), ...turn(1000, "synthetic-child", "child-turn")];
  const expected = parse(rows).result;
  assert.equal(expected.length, 1);
  assert.equal(expected[0].speed_mode, "fast");
  for (let split = 1; split < rows.length; split++) {
    const prefix = parse(rows.slice(0, split));
    const suffix = parse(rows.slice(split), JSON.parse(JSON.stringify(prefix.parser.state())), split);
    assert.deepEqual([...prefix.result, ...suffix.result], expected, "checkpoint " + split);
  }
  assert.equal(parse([rows[0], parentHeader, parentHeader]).parser.state().blocked, true);
  const lateHeader = [rows[0], setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn"), parentHeader];
  assert.equal(parse(lateHeader).parser.state().blocked, true);
});

test("an inline fork skips copied parent turns but retains later identified child work", () => {
  const rows = [
    meta(),
    setting(-7000, "synthetic-parent"),
    ...turn(-6000, "synthetic-parent", "parent-turn"),
    setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn"),
  ];
  const expected = parse(rows).result;
  assert.equal(expected.length, 1);
  assert.equal(expected[0].model, "gpt-6.1-sol");
  assert.equal(expected[0].speed_mode, "fast");
  for (let split = 1; split < rows.length; split++) {
    const prefix = parse(rows.slice(0, split));
    const suffix = parse(rows.slice(split), JSON.parse(JSON.stringify(prefix.parser.state())), split);
    assert.deepEqual([...prefix.result, ...suffix.result], expected, "checkpoint " + split);
  }
});

test("ambiguous or contradictory fork lineage is not reported as valid new work", () => {
  const noParentProof = [meta(), setting(500, "synthetic-child"), ...turn(1000, "synthetic-child", "child-turn")];
  assert.equal(parse(noParentProof).result.length, 0);

  const lateParent = [
    meta(),
    setting(-7000, "synthetic-parent"),
    ...turn(-6000, "synthetic-parent", "parent-one"),
    setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn"),
    ...turn(4000, "synthetic-parent", "parent-late"),
  ];
  assert.equal(parse(lateParent).parser.state().blocked, true);
});

test("a fork requires a usable creation boundary and parent evidence across restart", () => {
  const missingTime = { ...meta({ history_mode: "paginated" }), timestamp: null };
  const rows = [missingTime, setting(500, "synthetic-child"), ...turn(1000, "synthetic-child", "child-turn")];
  assert.equal(parse(rows).result.length, 0);

  const copiedBeforeFork = [
    meta({ history_mode: "paginated" }),
    setting(-6000, "synthetic-child"),
    ...turn(-5000, "synthetic-child", "copied-turn"),
  ];
  assert.equal(parse(copiedBeforeFork).result.length, 0);
  const nearBoundaryCopy = [
    meta({ history_mode: "paginated" }),
    setting(-500, "synthetic-child"),
    ...turn(-1, "synthetic-child", "near-boundary-copy"),
  ];
  assert.equal(parse(nearBoundaryCopy).result.length, 0);

  const valid = [meta({ history_mode: "paginated" }), setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn")];
  const prefix = parse(valid.slice(0, 4));
  const corrupted = JSON.parse(JSON.stringify(prefix.parser.state()));
  corrupted.parent = null;
  assert.equal(parse(valid.slice(4), corrupted, 4).result.length, 0);
});

test("a real mid-turn speed change remains mixed in an identified fork", () => {
  const child = turn(1000, "synthetic-child", "child-turn");
  child.splice(2, 0, setting(1600, "synthetic-child", "default"));
  const result = parse([meta({ history_mode: "paginated" }), setting(500, "synthetic-child"), ...child]).result;
  assert.equal(result.length, 1);
  assert.equal(result[0].speed_mode, "mixed");
});

test("a late contradictory parent record invalidates prior child measurements after restart", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotempo-fork-test-"));
  const file = join(root, "synthetic.jsonl");
  const directory = join(root, "timing");
  const first = [
    meta(),
    setting(-7000, "synthetic-parent"),
    ...turn(-6000, "synthetic-parent", "parent-one"),
    setting(500, "synthetic-child"),
    ...turn(1000, "synthetic-child", "child-turn"),
  ];
  const openStore = () => openTimingStore(directory, {
    createParser, digest, METHOD, MAX_STATE_BYTES, parserVersion: INFERENCE_TIMING_PARSER_VERSION,
  });
  let store;
  try {
    await writeFile(file, first.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    store = await openStore();
    await ingestTimingFile(store, file);
    const before = readTimingRows(store);
    assert.equal(before.length, 1);
    assert.equal(before[0].model, "gpt-6.1-sol");
    assert.equal(before[0].speed_mode, "fast");
    store.close();
    store = null;
    await appendFile(file, turn(4000, "synthetic-parent", "parent-late").map((row) => JSON.stringify(row)).join("\n") + "\n");
    store = await openStore();
    await ingestTimingFile(store, file);
    const after = readTimingRows(store);
    assert.equal(after.length, 1);
    assert.equal(after[0].quality, "blocked_source");
    assert.equal(after[0].model, null);
    assert.equal(after[0].ttft, null);
    assert.equal(after[0].sample_duration, null);
    const saved = store.db.prepare("SELECT state FROM source").get().state;
    assert.doesNotMatch(saved, /synthetic-child|synthetic-parent|child-turn/u);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
