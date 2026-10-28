import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic timings only: no prompts, responses or real account identifiers.
export async function writeSyntheticPerformanceFixture(codexHome, base = Date.now() - 60 * 60_000) {
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const record = (time, type, payload) => ({ timestamp: new Date(time).toISOString(), type, payload });
  const event = (time, type, payload = {}) => record(time, "event_msg", { type, ...payload });
  function turn(start, thread, turnId, model) {
    return [
      event(start, "task_started", { turn_id: turnId }),
      record(start, "turn_context", { turn_id: turnId, model, effort: "high" }),
      event(start + 1000, "item_completed", { thread_id: thread, turn_id: turnId,
        item: { type: "Reasoning" }, started_at_ms: start, completed_at_ms: start + 1000 }),
      record(start + 1000, "token_usage_record", { thread_id: thread, turn_id: turnId,
        response_id: turnId + "-response", usage: { output_tokens: 100, reasoning_output_tokens: 50 },
        turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 } }),
      event(start + 1000, "task_complete", { turn_id: turnId, duration_ms: 1000, time_to_first_token_ms: 200 }),
    ];
  }
  for (const [name, model, forked] of [
    ["sol", "gpt-6.1-sol", false], ["astra", "gpt-6-astra", true],
  ]) {
    const own = "synthetic-" + name;
    const rows = [record(base, "session_meta", forked
      ? { id: own, forked_from_id: "synthetic-parent", history_mode: "paginated" }
      : { id: own })];
    if (forked) {
      rows.push(record(base, "session_meta", { id: "synthetic-parent" }));
      rows.push(event(base - 5000, "thread_settings_applied", { thread_id: "synthetic-parent",
        thread_settings: { service_tier: "default" } }));
      rows.push(...turn(base - 4000, "synthetic-parent", "copied-parent", model));
    }
    rows.push(event(base + 100, "thread_settings_applied", { thread_id: own,
      thread_settings: { service_tier: "default" } }));
    for (let index = 0; index < 6; index++) {
      rows.push(...turn(base + 1000 + index * 5000, own, name + "-turn-" + index, model));
    }
    await writeFile(join(sessions, name + ".jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  }
}
