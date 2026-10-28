import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

// These are hard safety ceilings, independent of each consumer's narrower
// line, source, and runtime budgets. No decompressed content is written to disk.
export const COMPRESSED_ROLLOUT_LIMITS = Object.freeze({
  maximumCompressedBytes: 2 * 1024 ** 3,
  maximumDecompressedBytes: 16 * 1024 ** 3,
  maximumExpansionRatio: 4096,
  minimumExpansionAllowance: 64 * 1024 ** 2,
  maximumRuntimeMs: 120_000,
  maximumWindowLog: 27,
});

export function supportsCompressedRollouts() {
  // Namespace access keeps import compatible with Node 22.13, whose zlib
  // module predates Zstd. Unsupported runtimes retain explicit partial coverage.
  return typeof zlib.createZstdDecompress === "function";
}

export function isCompressedRolloutSource(source) {
  return typeof source === "string"
    ? source.endsWith(".jsonl.zst")
    : source?.compression === "zstd";
}

export function compressedRolloutHandle(handle) {
  return Object.freeze({
    compression: "zstd",
    fd: handle.fd,
    read: (...args) => handle.read(...args),
    stat: (...args) => handle.stat(...args),
    close: () => handle.close(),
  });
}

function readError(code) {
  const error = new Error("Compressed Codex rollout could not be read safely");
  error.name = "CompressedRolloutReadError";
  error.code = code;
  if (code === "codex_rollout_source_changed") error.retryable = true;
  return error;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Compressed Codex rollout read aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function samePhysicalState(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

// A source this module opened itself must be a single-link regular file so a
// replaced name can never be read twice. A caller-owned descriptor was already
// validated by its owner (`openSource`); requiring nlink===1 there would reject
// legitimate hard-linked duplicate archives instead of deduplicating them.
function assertRegularOwned(stats, owned) {
  if (!stats.isFile() || stats.isSymbolicLink()
      || (owned === true && stats.nlink !== 1)
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    throw readError("codex_rollout_source_changed");
  }
}

// Zstandard magic values from the public format specification.
const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MINIMUM = 0x184d2a50;
const SKIPPABLE_MAXIMUM = 0x184d2a5f;
const MAXIMUM_BLOCK_BYTES = 128 * 1024;
const FRAME_HEADER_BYTES = 18;

// Pull-based cursor over the physical compressed byte stream. Views alias a
// freshly allocated read buffer per physical read, so they stay valid while a
// downstream decoder holds them; nothing beyond one read chunk is retained.
class CompressedByteStream {
  constructor(chunks) {
    this.chunks = chunks;
    this.chunk = null;
    this.offset = 0;
  }

  async fill() {
    for (;;) {
      if (this.chunk !== null && this.offset < this.chunk.length) return true;
      const next = await this.chunks.next();
      if (next.done === true) {
        this.chunk = null;
        this.offset = 0;
        return false;
      }
      this.chunk = next.value;
      this.offset = 0;
      if (this.chunk.length > 0) return true;
    }
  }

  async view(maximum) {
    if (!(await this.fill())) return null;
    const take = Math.min(maximum, this.chunk.length - this.offset);
    const view = this.chunk.subarray(this.offset, this.offset + take);
    this.offset += take;
    return view;
  }

  async exact(length) {
    if (length === 0) return Buffer.alloc(0);
    const parts = [];
    let remaining = length;
    while (remaining > 0) {
      const view = await this.view(remaining);
      if (view === null) return null;
      parts.push(view);
      remaining -= view.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      const view = await this.view(remaining);
      if (view === null) return false;
      remaining -= view.length;
    }
    return true;
  }

  release() {
    try {
      this.chunks.return?.();
    } catch { /* The outer read already owns failure reporting. */ }
  }
}

// Walk exactly one frame's physical bytes so a decoder instance can be given a
// single complete frame. Node's native Zstd stream does not reliably emit every
// frame of concatenated input: measured on Node 26.0.0 one buffered chunk
// produced only the first frame while the same bytes delivered in 3-byte chunks
// failed with ZSTD_error_prefix_unknown, and the outcome depended on where the
// chunk boundaries fell. Electron's Node 24.22 does emit all frames. Validating
// and decoding frame by frame is deterministic on both.
//
// The walk validates header/block structure, window-log and content-size
// ceilings before any byte is decompressed, and never retains a block body.
async function* frameBytes(stream, magic, {
  maximumWindowBytes, maximumOutputBytes, createLimitError, check,
}) {
  yield magic;
  const descriptorBytes = await stream.exact(1);
  if (descriptorBytes === null) throw readError("codex_rollout_content_invalid");
  const descriptor = descriptorBytes[0];
  // Bit 3 is reserved; bit 4 must be zero in every supported revision.
  if ((descriptor & 8) !== 0) throw readError("codex_rollout_content_invalid");
  const checksum = (descriptor & 4) !== 0;
  const singleSegment = (descriptor & 32) !== 0;
  const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 3];
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
  yield descriptorBytes;

  if (!singleSegment) {
    const window = await stream.exact(1);
    if (window === null) throw readError("codex_rollout_content_invalid");
    const base = 2 ** (10 + (window[0] >> 3));
    if (base + (base / 8) * (window[0] & 7) > maximumWindowBytes) {
      throw createLimitError("source_bytes");
    }
    yield window;
  }
  if (dictionaryIdBytes > 0) {
    const dictionaryId = await stream.exact(dictionaryIdBytes);
    if (dictionaryId === null) throw readError("codex_rollout_content_invalid");
    yield dictionaryId;
  }
  if (contentSizeBytes > 0) {
    const contentSize = await stream.exact(contentSizeBytes);
    if (contentSize === null) throw readError("codex_rollout_content_invalid");
    let size = 0n;
    for (let index = contentSizeBytes - 1; index >= 0; index -= 1) {
      size = size * 256n + BigInt(contentSize[index]);
    }
    if (contentSizeBytes === 2) size += 256n;
    if (size > BigInt(maximumOutputBytes)
        || (singleSegment && size > BigInt(maximumWindowBytes))) {
      throw createLimitError("source_bytes");
    }
    yield contentSize;
  }

  for (;;) {
    check();
    const header = await stream.exact(3);
    if (header === null) throw readError("codex_rollout_content_invalid");
    const value = header.readUIntLE(0, 3);
    const type = (value >> 1) & 3;
    const size = value >>> 3;
    const last = (value & 1) !== 0;
    if (type === 3 || size > MAXIMUM_BLOCK_BYTES) {
      throw readError("codex_rollout_content_invalid");
    }
    yield header;
    // An RLE block stores one byte that the decoder expands `size` times.
    let remaining = type === 1 ? 1 : size;
    while (remaining > 0) {
      const view = await stream.view(Math.min(remaining, 64 * 1024));
      if (view === null) throw readError("codex_rollout_content_invalid");
      remaining -= view.length;
      yield view;
    }
    if (last) break;
  }
  if (checksum) {
    const trailer = await stream.exact(4);
    if (trailer === null) throw readError("codex_rollout_content_invalid");
    yield trailer;
  }
}

/** Yield decompressed bytes at logical offsets; descriptor ownership is retained.
 * Bounded prefix readers may stop early. A reader consumed to EOF validates every
 * frame, checksum and the immutable physical source before it succeeds, and
 * decodes each concatenated frame with its own decoder instance.
 */
export async function* readCompressedRolloutBytes(source, {
  start = 0,
  end = Number.POSITIVE_INFINITY,
  highWaterMark = 256 * 1024,
  signal = null,
  resourceGuard = null,
  limits = COMPRESSED_ROLLOUT_LIMITS,
  createLimitError = (code) => readError(`export_resource_${code}`),
} = {}) {
  if (!Number.isSafeInteger(start) || start < 0
      || (end !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(end) || end < start))
      || !Number.isSafeInteger(highWaterMark) || highWaterMark < 1
      || highWaterMark > 1024 * 1024) {
    throw new TypeError("Compressed rollout byte range is invalid");
  }
  if (typeof createLimitError !== "function") throw new TypeError("Compressed rollout error factory is invalid");
  for (const key of Object.keys(COMPRESSED_ROLLOUT_LIMITS)) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1
        || limits[key] > COMPRESSED_ROLLOUT_LIMITS[key]) {
      throw new TypeError("Compressed rollout limits are invalid");
    }
  }
  abortIfNeeded(signal);
  if (!supportsCompressedRollouts()) throw readError("codex_rollout_compression_unsupported");
  const owned = typeof source === "string";
  let handle = null;
  let stream = null;
  const startedAt = performance.now();
  function check() {
    abortIfNeeded(signal);
    resourceGuard?.checkRuntime();
    if (performance.now() - startedAt > limits.maximumRuntimeMs) {
      throw createLimitError("elapsed_time");
    }
  }
  try {
    handle = owned
      ? await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      : source;
    const before = await handle.stat();
    assertRegularOwned(before, owned);
    if (owned && !samePhysicalState(before, await lstat(source))) {
      throw readError("codex_rollout_source_changed");
    }
    if (before.size > limits.maximumCompressedBytes) throw createLimitError("source_bytes");
    const expansionBound = Math.min(limits.maximumDecompressedBytes,
      Math.max(limits.minimumExpansionAllowance, before.size * limits.maximumExpansionRatio));
    stream = new CompressedByteStream((async function* () {
      let position = 0;
      while (position < before.size) {
        check();
        // A decoder may retain the chunk after write(), so unlike positional
        // line readers this buffer must not be reused for the next read.
        const buffer = Buffer.allocUnsafe(Math.min(highWaterMark, before.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead !== buffer.length) throw readError("codex_rollout_source_changed");
        position += bytesRead;
        yield buffer;
      }
    })());

    let offset = 0;
    let frames = 0;
    for (;;) {
      check();
      const magicBytes = await stream.exact(4);
      if (magicBytes === null) break;
      const magic = magicBytes.readUInt32LE(0);
      if (magic >= SKIPPABLE_MINIMUM && magic <= SKIPPABLE_MAXIMUM) {
        // A skippable frame carries only a length and opaque payload.
        const header = await stream.exact(4);
        if (header === null) throw readError("codex_rollout_content_invalid");
        if (!(await stream.skip(header.readUInt32LE(0)))) throw readError("codex_rollout_content_invalid");
        continue;
      }
      if (magic !== FRAME_MAGIC) throw readError("codex_rollout_content_invalid");
      frames += 1;
      const decoder = zlib.createZstdDecompress({
        chunkSize: Math.max(64, highWaterMark),
        highWaterMark,
        params: { [zlib.constants.ZSTD_d_windowLogMax]: limits.maximumWindowLog },
      });
      let failure = null;
      // Capture immediately: malformed input can reject while the consumer is
      // paused at a yielded chunk. Never emit unhandled rejections.
      const pumping = pipeline(Readable.from(frameBytes(stream, magicBytes, {
        maximumWindowBytes: 2 ** limits.maximumWindowLog,
        maximumOutputBytes: expansionBound,
        createLimitError,
        check,
      }), { highWaterMark: 1, objectMode: false }), decoder, ...(signal ? [{ signal }] : []))
        .catch((error) => { failure = error; });
      try {
        for await (const chunk of decoder) {
          check();
          const next = offset + chunk.length;
          if (next > expansionBound) throw createLimitError("source_bytes");
          if (next > start && offset < end) {
            yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset));
          }
          offset = next;
        }
      } catch (error) {
        if (failure === null) failure = error;
      }
      await pumping;
      decoder.destroy();
      if (failure !== null) throw failure;
    }
    if (frames < 1) throw readError("codex_rollout_content_invalid");
    check();
    const after = await handle.stat();
    assertRegularOwned(after, owned);
    if (!samePhysicalState(before, after)
        || (owned && !samePhysicalState(after, await lstat(source)))) {
      throw readError("codex_rollout_source_changed");
    }
  } catch (error) {
    if (error?.name === "AbortError"
        || error?.name === "CompressedRolloutReadError"
        || (typeof error?.code === "string" && error.code.startsWith("export_resource_"))) throw error;
    throw readError("codex_rollout_content_invalid");
  } finally {
    stream?.release();
    if (owned) await handle?.close().catch(() => {});
  }
}

export async function inspectCompressedRollout(source, {
  maximumPrefixBytes = 1024 * 1024,
  ...options
} = {}) {
  if (!Number.isSafeInteger(maximumPrefixBytes) || maximumPrefixBytes < 1
      || maximumPrefixBytes > 1024 * 1024) throw new TypeError("Compressed rollout prefix limit is invalid");
  const digest = createHash("sha256");
  const prefix = [];
  let size = 0;
  let prefixBytes = 0;
  let lastByte = null;
  for await (const chunk of readCompressedRolloutBytes(source, options)) {
    digest.update(chunk);
    size += chunk.length;
    lastByte = chunk[chunk.length - 1] ?? lastByte;
    if (prefixBytes < maximumPrefixBytes) {
      const part = chunk.subarray(0, maximumPrefixBytes - prefixBytes);
      prefix.push(Buffer.from(part));
      prefixBytes += part.length;
    }
  }
  return { size, sha256: digest.digest("hex"), lastByte,
    prefix: Buffer.concat(prefix, prefixBytes) };
}
