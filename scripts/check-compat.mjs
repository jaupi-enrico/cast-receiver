#!/usr/bin/env node
// Fails the build on anything a 1st/2nd-gen Chromecast can't run.
//
// Those devices are Chrome 70 (CrKey/1.36). A syntax they don't know is not a
// degraded feature — the receiver HTML loads, the inline script never runs, and
// casting "silently does nothing" with no error anywhere. This script is the
// only thing standing between that and a green deploy, so it runs in CI on
// every push.
//
// Three passes, in order of how badly each failure hurts:
//   1. Parse the inline JS as ES2019. Chrome 70 implements all of ES2019
//      (optional catch binding is Chrome 66, and the file uses it) and none of
//      ES2020 — so ES2019 is exactly the line, not an approximation. This is
//      what catches `?.` and `??`.
//   2. Grep for runtime methods a parser can't see: `Object.fromEntries` is
//      valid ES5 syntax and a TypeError on the device.
//   3. Grep the CSS. A too-new property degrades rather than explodes, but a
//      receiver whose layout collapses on the exact devices you can't debug is
//      barely better.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "index.html";
const source = readFileSync(join(root, FILE), "utf8");

const failures = [];
const fail = (index, message) => {
  failures.push({ line: source.slice(0, index).split("\n").length, message });
};

// Blank out everything except the given regions, keeping newlines so every
// offset — acorn's included — stays a real index.html offset.
function maskTo(regions) {
  const masked = source.replace(/[^\n]/g, " ").split("");
  for (const [start, end] of regions) {
    for (let i = start; i < end; i++) masked[i] = source[i];
  }
  return masked.join("");
}

// Inverse of maskTo: blank out the given regions, keep the rest.
function blank(text, regions) {
  const out = text.split("");
  for (const [start, end] of regions) {
    for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

function blocks(tag) {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  const found = [];
  let m;
  while ((m = open.exec(source)) !== null) {
    const attrs = m[1];
    const start = m.index + m[0].length;
    const end = source.indexOf(`</${tag}`, start);
    if (end === -1) continue;
    found.push({ attrs, start, end });
    open.lastIndex = end;
  }
  return found;
}

// ── 1. JS syntax ──────────────────────────────────────────────────────────
// Only inline scripts: the one <script src> is the CAF SDK, served by Google.
const scripts = blocks("script").filter((b) => !/\bsrc\s*=/i.test(b.attrs));
if (!scripts.length) {
  console.error(`${FILE}: no inline <script> found — did the file move?`);
  process.exit(1);
}

let js = maskTo(scripts.map((b) => [b.start, b.end]));
const comments = [];
let parsed = true;
try {
  acorn.parse(js, {
    ecmaVersion: 2019,
    sourceType: "script",
    locations: true,
    onComment: (block, text, start, end) => comments.push([start, end]),
  });
} catch (err) {
  parsed = false;
  const line = err.loc ? err.loc.line : "?";
  failures.push({
    line,
    message: `ES2019 parse error (Chrome 70 would fail the same way): ${err.message.replace(/\s*\(\d+:\d+\)$/, "")}`,
  });
}

// ── 2. JS runtime methods ─────────────────────────────────────────────────
// The ban list is written out in full inside index.html's own comments, so
// scanning them would report every banned API as present. Blanking them needs
// acorn's comment ranges, i.e. a successful parse — so on a parse error this
// pass is skipped entirely rather than run against the comments and made to
// print a screenful of noise under the one error that matters.
const BANNED_JS = [
  [/\bObject\.fromEntries\b/g, "Object.fromEntries (Chrome 73)"],
  [/\bObject\.hasOwn\b/g, "Object.hasOwn (Chrome 93)"],
  [/\.matchAll\s*\(/g, "String.prototype.matchAll (Chrome 73)"],
  [/\bPromise\.allSettled\b/g, "Promise.allSettled (Chrome 76)"],
  [/\bPromise\.any\b/g, "Promise.any (Chrome 85)"],
  [/\.replaceAll\s*\(/g, "String.prototype.replaceAll (Chrome 85)"],
  [/\.at\s*\(/g, "Array/String.prototype.at (Chrome 92)"],
  [/\.findLast(Index)?\s*\(/g, "Array.prototype.findLast (Chrome 97)"],
  [/\bglobalThis\b/g, "globalThis (Chrome 71)"],
  [/\bqueueMicrotask\b/g, "queueMicrotask (Chrome 71)"],
  [/\bstructuredClone\b/g, "structuredClone (Chrome 98)"],
  [/\bBigInt\b/g, "BigInt (Chrome 67 — but its literals are ES2020 syntax)"],
];
// `typeof Object.fromEntries` is a capability probe, not a use — the receiver
// logs which of these the device it woke up on actually has. Guarding the
// probes themselves would be circular.
const isProbe = (text, index) => /\btypeof\s+$/.test(text.slice(Math.max(0, index - 12), index));

if (parsed) {
  js = blank(js, comments);
  for (const [re, label] of BANNED_JS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(js)) !== null) {
      if (isProbe(js, m.index)) continue;
      fail(m.index, `banned JS: ${label}`);
    }
  }
}

// ── 3. CSS ────────────────────────────────────────────────────────────────
// Same as the JS pass: the CSS ban list is spelled out in a comment at the top
// of the <style> block, so comments come out first.
const css = maskTo(blocks("style").map((b) => [b.start, b.end])).replace(
  /\/\*[\s\S]*?\*\//g,
  (c) => c.replace(/[^\n]/g, " "),
);
const BANNED_CSS = [
  // Banned outright rather than only inside flex containers: this receiver has
  // no grid layout, so a `gap` here is always the flex one (Chrome 84).
  [/(^|[\s;{])(row-|column-)?gap\s*:/gm, "gap (Chrome 84 in flex) — use margins"],
  [
    // `box-shadow: inset …` has no colon after `inset`, so it isn't matched.
    /(^|[\s;{])inset\s*:/gm,
    "the `inset` shorthand (Chrome 87) — use top/right/bottom/left",
  ],
  [/[\s:,(]clamp\s*\(/g, "clamp() (Chrome 79)"],
  [/[\s:,(](min|max)\s*\(/g, "CSS min()/max() (Chrome 79)"],
  [/:(is|where)\s*\(/g, ":is()/:where() (Chrome 88)"],
  [/(^|[\s;{])aspect-ratio\s*:/gm, "aspect-ratio (Chrome 88)"],
  [/(^|[\s;{])backdrop-filter\s*:/gm, "backdrop-filter (Chrome 76)"],
  [
    /(^|[\s;{])(margin|padding|border|inset)-(inline|block)[\w-]*\s*:/gm,
    "logical properties (Chrome 87)",
  ],
  [/(^|[\s;{])(block|inline)-size\s*:/gm, "logical sizing (Chrome 57+/87)"],
];
for (const [re, label] of BANNED_CSS) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(css)) !== null) fail(m.index, `banned CSS: ${label}`);
}

// ── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  failures.sort((a, b) => a.line - b.line);
  for (const f of failures) console.error(`${FILE}:${f.line}: ${f.message}`);
  console.error(
    `\n${failures.length} incompatibilit${failures.length === 1 ? "y" : "ies"} with Chrome 70 (gen-1/2 Chromecast).`,
  );
  process.exit(1);
}

console.log(`${FILE}: Chrome 70 compatible (ES2019 syntax, no banned APIs or CSS).`);
