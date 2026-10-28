import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const PAGES = ["index.html", "electron-settings.html", "electron-tray-popup.html"];
const sources = new Map(await Promise.all(PAGES.map(async (page) => [
  page,
  await readFile(new URL(`../public/${page}`, import.meta.url), "utf8"),
])));

function idsIn(html) {
  return [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
}

function localReferences(html) {
  return [...html.matchAll(/(?:src|href)="\.\/([^"#]+)"/gu)].map((match) => match[1]);
}

test("every element id in the shipped pages is unique", () => {
  for (const page of PAGES) {
    const ids = idsIn(sources.get(page));
    assert.ok(ids.length > 0, page);
    assert.deepEqual(
      ids.filter((id, index) => ids.indexOf(id) !== index),
      [],
      `${page} repeats an id, which would make a lookup order-dependent`,
    );
  }
});

test("every local asset a page references is a shipped file", async () => {
  // The parent task owns the loopback allowlist; this asserts the pages only
  // point at files that exist beside them, so a removed surface cannot leave a
  // broken reference behind.
  for (const page of PAGES) {
    for (const reference of new Set(localReferences(sources.get(page)))) {
      const file = new URL(`../public/${reference}`, import.meta.url);
      await readFile(file).then(
        () => {},
        () => assert.fail(`${page} references a missing asset: ${reference}`),
      );
    }
  }
});

test("every static translation key resolves in every shipped locale", () => {
  for (const page of PAGES) {
    const html = sources.get(page);
    const keys = new Set(
      [...html.matchAll(/data-i18n(?:-(?:aria-label|alt|title|placeholder))?="([^"]+)"/gu)]
        .map((match) => match[1]),
    );
    for (const key of keys) {
      for (const locale of SUPPORTED_LOCALES) {
        const copy = translate(key, {}, locale);
        assert.ok(copy && copy.trim().length > 0, `${page} ${locale}: ${key}`);
        assert.notEqual(copy, key, `${page} ${locale}: ${key} leaks its key`);
      }
    }
  }
});

test("the dashboard declares no duplicate page or navigation target", () => {
  const html = sources.get("index.html");
  const navs = [...html.matchAll(/data-nav="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(navs)], navs, "navigation repeats a destination");
  // Every navigation target must resolve to a real page region.
  const pages = new Set(
    [...html.matchAll(/data-dashboard-page="([^"]+)"/gu)].map((match) => match[1]),
  );
  for (const target of navs) {
    assert.equal(pages.has(target), true, `navigation target ${target} has no page`);
  }
});

test("the dashboard ships no inline script or remote asset under its CSP", () => {
  const html = sources.get("index.html");
  // loopback CSP is script-src 'self'; an inline or remote script would be
  // refused at runtime, so it must not be present in source either.
  for (const [, attributes] of html.matchAll(/<script\b([^>]*)>/gu)) {
    assert.doesNotMatch(attributes, /\bsrc="(?:https?:)?\/\//u, "remote script");
    assert.match(attributes, /\bsrc="\.\//u, "every script is a bundled module");
  }
  for (const [, url] of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/gu)) {
    assert.fail(`remote asset reference would be blocked and must not ship: ${url}`);
  }
});
