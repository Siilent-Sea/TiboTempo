import { describe, expect, it } from "vitest";

import * as contract from "../src/edge-origin-contract";
import {
  EDGE_ORIGIN_CONTRACT_CHECKS,
  type ContractAssert,
} from "./edge-origin-contract-vectors";

// Production-line port (edge port of d43c8f92). The same vectors run on the
// GCP line (claude/gcp-fastpath-final), whose Node check and source check
// also compare the callback-query rule with cloud-run/request-boundary.mjs.
// This line has no cloud-run/ origin, so here the source check covers the
// contract alone. The contract-blob rule (E10's EDGE_CONTRACT_DRIFT, E12's
// EDGE_BUNDLE_CONTRACT_DRIFT) requires this file to be byte-identical to the
// GCP line's, where the full comparison runs.

// Vite's ?raw query returns a file's text; the specifier is a variable so
// the type checker does not need a module declaration for it.
const CONTRACT_SOURCE_SPECIFIER = "../src/edge-origin-contract.ts?raw";

const RUNTIME_SPECIFIC_SOURCE_PATTERNS: readonly (readonly [label: string, pattern: RegExp])[] = [
  ["static import", /^\s*import\b/mu],
  ["dynamic import", /\bimport\s*\(/u],
  ["re-export", /\bexport\s+(?:\*|\{[^}]*\})\s*from\b/u],
  ["require", /\brequire\s*\(/u],
  ["node: specifier", /["']node:/u],
  ["Buffer", /\bBuffer\b/u],
  ["process", /\bprocess\b/u],
  ["globalThis", /\bglobalThis\b/u],
  ["Workers cache", /\bcaches\b/u],
  ["console", /\bconsole\b/u],
];

async function rawSource(specifier: string): Promise<string> {
  const module: { readonly default?: unknown } = await import(/* @vite-ignore */ specifier);
  if (typeof module.default !== "string") throw new Error("RAW_SOURCE_UNAVAILABLE");
  return module.default;
}

const assert: ContractAssert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toStrictEqual(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
};

describe("edge/origin transport contract (workerd)", () => {
  it("registers the shared contract checks", () => {
    expect(EDGE_ORIGIN_CONTRACT_CHECKS.length).toBeGreaterThanOrEqual(13);
    expect(new Set(EDGE_ORIGIN_CONTRACT_CHECKS.map(({ name }) => name)).size)
      .toBe(EDGE_ORIGIN_CONTRACT_CHECKS.length);
  });

  for (const check of EDGE_ORIGIN_CONTRACT_CHECKS) {
    it(check.name, () => {
      check.run(contract, assert);
    });
  }

  it("keeps the contract source self-contained and runtime-neutral", async () => {
    const code = (await rawSource(CONTRACT_SOURCE_SPECIFIER))
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//u.test(line))
      .join("\n");
    expect(code).toContain("export function parseCloudRunInvokerClaims");
    for (const [label, pattern] of RUNTIME_SPECIFIC_SOURCE_PATTERNS) {
      expect(pattern.test(code), label).toBe(false);
    }
    // No per-address header, derivation or pattern.
    expect([...new Set(code.match(/\w*client\w*/giu) ?? [])])
      .toStrictEqual(["EDGE_MIN_CLIENT_KEY_SECRET_LENGTH"]);
  });

  it("never writes rejected input to the console", () => {
    const calls: unknown[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { calls.push(args); };
    console.warn = console.log;
    console.error = console.log;
    try {
      contract.parseCloudRunInvokerClaims("Bearer a.b.c", 0);
      contract.parseEdgeOriginConfiguration(() => {
        throw new Error("SYNTHETIC_GETTER_FAILURE");
      });
      contract.decodeEdgeAdmission("v2;enrollment;allowed");
    } finally {
      Object.assign(console, original);
    }
    expect(calls).toEqual([]);
  });
});
