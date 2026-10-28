import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { writeSyntheticPerformanceFixture } from '../apps/electron/test/personal-fixture.mjs';
import { createParser, digest, METHOD, MAX_STATE_BYTES } from '../src/providers/codex/logs.js';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../src/platform/inference-timing-store.js';

test('compressed concatenated frames yield identical timing rows and deduplicate plain copies', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tempo-zstd-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSyntheticPerformanceFixture(root);
  const plain = join(root, 'sessions', 'sol.jsonl');
  const bytes = await readFile(plain);
  const split = Math.floor(bytes.length / 2);
  const compressed = plain + '.zst';
  await writeFile(compressed, Buffer.concat([zstdCompressSync(bytes.subarray(0, split)), zstdCompressSync(bytes.subarray(split))]), { mode: 0o600 });
  const store = await openTimingStore(join(root, 'timing'), { createParser, digest, METHOD, MAX_STATE_BYTES });
  t.after(() => store.close());
  await ingestTimingFile(store, compressed);
  const compressedRows = readTimingRows(store);
  assert.equal(compressedRows.length, 6);
  assert.deepEqual(await ingestTimingFile(store, compressed), { bytes: 0, unchanged: true });
  await ingestTimingFile(store, plain);
  assert.deepEqual(readTimingRows(store), compressedRows);
});

test('truncated and cancelled archive scans do not commit partial results', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tempo-zstd-error-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSyntheticPerformanceFixture(root);
  const bytes = await readFile(join(root, 'sessions', 'sol.jsonl'));
  const encoded = zstdCompressSync(bytes);
  const bad = join(root, 'bad.jsonl.zst');
  const good = join(root, 'good.jsonl.zst');
  await writeFile(bad, encoded.subarray(0, encoded.length - 1), { mode: 0o600 });
  await writeFile(good, encoded, { mode: 0o600 });
  const store = await openTimingStore(join(root, 'timing'), { createParser, digest, METHOD, MAX_STATE_BYTES });
  t.after(() => store.close());
  await assert.rejects(ingestTimingFile(store, bad));
  assert.equal(readTimingRows(store).length, 0);
  const controller = new AbortController();
  await assert.rejects(ingestTimingFile(store, good, { signal: controller.signal, onReadLine: () => controller.abort() }));
  assert.equal(readTimingRows(store).length, 0);
  await ingestTimingFile(store, good);
  assert.equal(readTimingRows(store).length, 6);
});
