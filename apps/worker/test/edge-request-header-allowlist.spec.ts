import { describe, expect, it } from "vitest";

import {
  ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  EDGE_CONTRACT_REQUEST_HEADERS,
  EDGE_HEADERS,
  EDGE_LOCAL_ONLY_REQUEST_HEADERS,
  FORWARDED_REQUEST_HEADERS,
} from "../src/edge-origin-contract";

/**
 * Request-header ratchet for the thin edge.
 *
 * In gcp mode the origin sees only the headers the edge forwards
 * (FORWARDED_REQUEST_HEADERS, plus ADMIN_ONLY_FORWARDED_REQUEST_HEADERS on the
 * admin host) and the contract headers. A Worker module that starts reading
 * any other request header would silently see it absent behind the edge. So
 * every header name read in src/**\/*.ts (headers.get/has, headers["x"],
 * req.headers.x) must be classified below, and a new unclassified read fails
 * naming its file.
 *
 * Production-line port (edge port of d43c8f92): this line has no cloud-run/
 * origin, so the scan covers src/ only. The cloud-run/ half of the ratchet,
 * with its origin-side response reads and dynamic reads, stays on the GCP
 * line (claude/gcp-fastpath-final), which scans both trees.
 */

// Vite's import.meta.glob hands the ratchet the raw text of every module. It
// is untyped on purpose: a program-wide `vite/client` reference would give
// src/** Vite-only ambient types the deployed Worker bundle does not provide.
// @ts-expect-error -- test-only Vite import.meta.glob, checked by sourceTexts below.
const GLOBBED_SOURCES: unknown = import.meta.glob(
  [
    "../src/**/*.ts",
    "!**/*.spec.*",
    "!**/node_modules/**",
    "!**/vendor/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

function sourceTexts(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("expected the import.meta.glob ?raw record");
  }
  const result: Record<string, string> = {};
  for (const [path, text] of Object.entries(value)) {
    if (typeof text !== "string") throw new TypeError(`expected raw text for ${path}`);
    result[path] = text;
  }
  return Object.freeze(result);
}

const SOURCES = sourceTexts(GLOBBED_SOURCES);

// ---------------------------------------------------------------------------
// Classification

/**
 * Read by the origin's transport, never copied from the client by the edge.
 */
const ORIGIN_TRANSPORT_REQUEST_HEADERS = Object.freeze([
  // Cloud Run's IAM front end delivers the verified invoker claims here; the
  // edge sets it from its own ID token (EP-2) and EP-6 consumes it.
  EDGE_HEADERS.invokerToken,
  // The origin host's own authority check; the edge's fetch sets it for the
  // upstream.
  "host",
  // Message framing chosen by the HTTP connection, not a forwarded value.
  "transfer-encoding",
]);

/**
 * Header names these files read from a RESPONSE (an upstream API, the
 * metadata server, a served page), never from a client request. Each name is
 * accepted only in the files listed for it, so the same name read anywhere
 * else is still a failure.
 */
const RESPONSE_HEADER_READS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // GitHub REST pagination on the release-inventory response.
  link: ["../src/github-distribution-history.ts"],
  // The edge checks the origin marker on the upstream response.
  [EDGE_HEADERS.originMarker]: ["../src/edge-origin-proxy.ts"],
});

/**
 * Reads whose header name is computed at run time. Each is reviewed here; the
 * expression must match the source text exactly, and a stale entry fails.
 */
const DYNAMIC_HEADER_READS: readonly Readonly<{
  file: string;
  expression: string;
  reason: string;
}>[] = Object.freeze([
  {
    file: "../src/edge-origin-proxy.ts",
    expression: "headers.get(name)",
    reason: "copies FORWARDED_REQUEST_HEADERS (plus the admin-only list) to the upstream request",
  },
  {
    file: "../src/storage-effective-history.ts",
    expression: "headers[family]",
    reason: "indexes the effective-history header rows by telemetry family, not an HTTP header",
  },
]);

const REQUEST_HEADER_CLASSES: ReadonlySet<string> = new Set<string>([
  ...FORWARDED_REQUEST_HEADERS,
  ...ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  ...EDGE_LOCAL_ONLY_REQUEST_HEADERS,
  ...EDGE_CONTRACT_REQUEST_HEADERS,
  ...ORIGIN_TRANSPORT_REQUEST_HEADERS,
]);

// ---------------------------------------------------------------------------
// Scanner

interface HeaderRead {
  readonly file: string;
  /** Lowercase header name, or null when the name is computed at run time. */
  readonly name: string | null;
  /** The matched source text, used to key reviewed dynamic reads. */
  readonly expression: string;
}

const HEADERS_METHODS: ReadonlySet<string> = new Set([
  "append", "delete", "entries", "forEach", "get", "getAll", "getSetCookie", "has",
  "keys", "set", "values",
]);

const RECEIVER = "([A-Za-z_$][\\w$]*)";
// receiver?.get( / receiver.has( ; the argument runs to the matching paren.
const CALL_READ = new RegExp(`\\b${RECEIVER}(\\?)?\\.(get|has)\\(`, "gu");
// receiver["name"] or receiver?.[expression], never an assignment target
const BRACKET_READ = new RegExp(`\\b${RECEIVER}(\\?\\.)?\\[\\s*([^\\]\\n]+?)\\s*\\](?!\\s*=(?!=))`, "gu");
// .headers.name (Node incoming headers), never an assignment target
const PROPERTY_READ = /\.headers(\?)?\.([A-Za-z_$][\w$]*)\b(?!\s*=(?!=))(?!\s*\()/gu;
const STRING_LITERAL = /^(["'])([^"'\\]+)\1$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const EDGE_HEADERS_MEMBER = /^EDGE_HEADERS\.([A-Za-z_$][\w$]*)$/u;

function isHeadersReceiver(name: string): boolean {
  return /headers$/iu.test(name);
}

/** `const NAME = "literal"` declarations in one module, by name. */
function stringConstants(text: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(["'])([^"'\\]+)\2/gu,
  )) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) constants.set(name, value);
  }
  return constants;
}

function resolvedName(argument: string, constants: ReadonlyMap<string, string>): string | null {
  const literal = STRING_LITERAL.exec(argument);
  if (literal?.[2] !== undefined) return literal[2].toLowerCase();
  const member = EDGE_HEADERS_MEMBER.exec(argument);
  if (member?.[1] !== undefined && Object.hasOwn(EDGE_HEADERS, member[1])) {
    return (EDGE_HEADERS as Readonly<Record<string, string>>)[member[1]]!.toLowerCase();
  }
  if (IDENTIFIER.test(argument)) {
    const value = constants.get(argument);
    if (value !== undefined) return value.toLowerCase();
  }
  return null;
}

/** The text up to the parenthesis closing the one before `start`, or null. */
function callArgument(text: string, start: number): string | null {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  return null;
}

function headerReads(file: string, text: string): HeaderRead[] {
  const constants = stringConstants(text);
  const reads: HeaderRead[] = [];
  for (const match of text.matchAll(CALL_READ)) {
    const [opening, receiver] = match;
    if (receiver === undefined || !isHeadersReceiver(receiver)) continue;
    const argumentStart = match.index + opening.length;
    const argument = callArgument(text, argumentStart);
    if (argument === null) {
      reads.push({ file, name: null, expression: opening });
      continue;
    }
    // A nested call or any computed argument stays unresolved (dynamic).
    reads.push({
      file,
      name: resolvedName(argument.trim(), constants),
      expression: `${opening}${argument})`,
    });
  }
  for (const match of text.matchAll(BRACKET_READ)) {
    const [expression, receiver, , argument] = match;
    if (receiver === undefined || argument === undefined || !isHeadersReceiver(receiver)) continue;
    reads.push({ file, name: resolvedName(argument, constants), expression });
  }
  for (const match of text.matchAll(PROPERTY_READ)) {
    const [expression, , property] = match;
    if (property === undefined || HEADERS_METHODS.has(property)) continue;
    reads.push({ file, name: property.toLowerCase(), expression });
  }
  return reads;
}

function allHeaderReads(sources: Readonly<Record<string, string>>): HeaderRead[] {
  return Object.entries(sources).flatMap(([file, text]) => headerReads(file, text));
}

function isReviewedDynamicRead(read: HeaderRead): boolean {
  return DYNAMIC_HEADER_READS.some((entry) =>
    entry.file === read.file && entry.expression === read.expression);
}

function violations(sources: Readonly<Record<string, string>>): string[] {
  const found: string[] = [];
  for (const read of allHeaderReads(sources)) {
    if (read.name === null) {
      if (!isReviewedDynamicRead(read)) {
        found.push(`${read.file}: unreviewed dynamic header read ${read.expression}`);
      }
      continue;
    }
    if (REQUEST_HEADER_CLASSES.has(read.name)) continue;
    const responseFiles = Object.hasOwn(RESPONSE_HEADER_READS, read.name)
      ? RESPONSE_HEADER_READS[read.name]!
      : [];
    if (responseFiles.includes(read.file)) continue;
    found.push(`${read.file}: unclassified header read '${read.name}'`);
  }
  return [...new Set(found)].sort();
}

function withInjected(file: string, snippet: string): Readonly<Record<string, string>> {
  const original = SOURCES[file];
  if (original === undefined) throw new Error(`missing source ${file}`);
  return { ...SOURCES, [file]: `${original}\n${snippet}\n` };
}

// ---------------------------------------------------------------------------

describe("edge request-header ratchet", () => {
  it("reads every src/**/*.ts module, recursively, and nothing excluded", () => {
    const files = Object.keys(SOURCES);
    for (const required of [
      "../src/admission.ts",
      "../src/admin-access.ts",
      "../src/edge-origin-proxy.ts",
      "../src/index.ts",
      "../src/session.ts",
    ]) {
      expect(files, required).toContain(required);
    }
    // src/ at d43c8f92 has no subdirectory; the glob is recursive, so a
    // nested module added later is scanned without a change here.
    for (const file of files) {
      expect(file).toMatch(/^\.\.\/src\/.+\.ts$/u);
      expect(file).not.toMatch(/node_modules|\.spec\./u);
    }
  });

  it("finds the known request-header reads, so the scan is not vacuous", () => {
    const reads = allHeaderReads(SOURCES);
    const has = (file: string, name: string) =>
      reads.some((read) => read.file === file && read.name === name);
    expect(has("../src/admission.ts", "cf-connecting-ip")).toBe(true);
    expect(has("../src/session.ts", "x-usage-monitor-admin")).toBe(true);
    // Resolved through `const ACCESS_JWT_HEADER = "cf-access-jwt-assertion"`.
    expect(has("../src/admin-access.ts", "cf-access-jwt-assertion")).toBe(true);
    // Resolved through an EDGE_HEADERS member.
    expect(has("../src/edge-origin-proxy.ts", "x-tibotattle-origin")).toBe(true);
  });

  it("classifies every request-header name read in src", () => {
    expect(violations(SOURCES)).toStrictEqual([]);
  });

  it("keeps no stale reviewed entry", () => {
    const reads = allHeaderReads(SOURCES);
    for (const entry of DYNAMIC_HEADER_READS) {
      expect(reads.some((read) => read.name === null && read.file === entry.file
        && read.expression === entry.expression), `${entry.file} ${entry.expression}`).toBe(true);
    }
    for (const [name, files] of Object.entries(RESPONSE_HEADER_READS)) {
      expect(REQUEST_HEADER_CLASSES.has(name), `${name} is already a request class`).toBe(false);
      for (const file of files) {
        expect(reads.some((read) => read.file === file && read.name === name), `${file} ${name}`)
          .toBe(true);
      }
    }
  });

  it("fails an injected unclassified read in a src module, naming the file and header", () => {
    expect(violations(withInjected(
      "../src/index.ts",
      "const probe = request.headers.get(\"x-unclassified-probe\");",
    ))).toStrictEqual(["../src/index.ts: unclassified header read 'x-unclassified-probe'"]);
  });

  it("fails an unreviewed dynamic read, a constant-named read and a misplaced response-only name", () => {
    expect(violations(withInjected(
      "../src/session.ts",
      "const probe = request.headers.get(headerName);",
    ))).toStrictEqual([
      "../src/session.ts: unreviewed dynamic header read headers.get(headerName)",
    ]);
    expect(violations(withInjected(
      "../src/session.ts",
      "const PROBE_HEADER = \"x-forwarded-for\";\nconst probe = request.headers.get(PROBE_HEADER);",
    ))).toStrictEqual(["../src/session.ts: unclassified header read 'x-forwarded-for'"]);
    // 'link' is accepted only where it is a response read.
    expect(violations(withInjected(
      "../src/index.ts",
      "const probe = request.headers.get(\"link\");",
    ))).toStrictEqual(["../src/index.ts: unclassified header read 'link'"]);
  });

  it("ignores header writes", () => {
    expect(violations(withInjected(
      "../src/index.ts",
      "headers[\"x-unclassified-probe\"] = \"1\";\nreq.headers.via = \"1\";",
    ))).toStrictEqual([]);
  });

  it("fails an injected unclassified Node property or bracket read in a src module", () => {
    expect(violations(withInjected(
      "../src/index.ts",
      "const probe = req.headers.via;",
    ))).toStrictEqual(["../src/index.ts: unclassified header read 'via'"]);
    expect(violations(withInjected(
      "../src/session.ts",
      "const probe = request.headers[\"x-unclassified-probe\"];",
    ))).toStrictEqual(["../src/session.ts: unclassified header read 'x-unclassified-probe'"]);
  });
});
