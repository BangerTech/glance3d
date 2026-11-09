#!/usr/bin/env node
/*
 * Fetches the MIT-licensed Bambu Lab data files from rolottr/bambu-bar and
 * writes them under `src/data/` so the widget can ship them with no runtime
 * network dependency.
 *
 *   - hms_de.json / hms_en.json (HMS codes + print_error texts; upstream is
 *     ha-bambulab via bambu-bar's scripts/make-hms.py)
 *   - filaments.json (Bambu Studio filament presets + color names, via
 *     bambu-bar's scripts/make-filaments.py)
 *
 * The HMS files on disk are `*.json.deflate` (raw DEFLATE). We inflate them
 * here with Node's `zlib.inflateRawSync` (Apple's COMPRESSION_ZLIB in
 * bambu-bar is RFC 1951 raw DEFLATE, not RFC 1950 zlib-with-header).
 *
 * Usage:
 *   node scripts/fetch-bambu-data.mjs [--ref <git-ref>]
 *
 * Commit the resulting JSON; no need to re-run on every build.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", "src", "data");
const ref = process.argv.includes("--ref")
  ? process.argv[process.argv.indexOf("--ref") + 1]
  : "main";
const base = `https://raw.githubusercontent.com/rolottr/bambu-bar/${ref}/Resources`;

const langs = ["de", "en"]; // bundle German + English; English is the fallback.

mkdirSync(outDir, { recursive: true });

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

for (const lang of langs) {
  const url = `${base}/HMS/hms_${lang}.json.deflate`;
  console.log(`-> ${url}`);
  const deflated = await fetchBytes(url);
  const inflated = inflateRawSync(deflated);
  const json = JSON.parse(inflated.toString("utf8"));
  // Normalize to { hms: {...}, error: {...} } shape (upstream already does).
  writeFileSync(
    resolve(outDir, `hms_${lang}.json`),
    JSON.stringify(json),
    "utf8"
  );
}

{
  const url = `${base}/filaments.json`;
  console.log(`-> ${url}`);
  const bytes = await fetchBytes(url);
  // Round-trip through JSON.parse to strip any BOM / normalise.
  const json = JSON.parse(bytes.toString("utf8"));
  writeFileSync(
    resolve(outDir, "filaments.json"),
    JSON.stringify(json),
    "utf8"
  );
}

console.log(`done. wrote to ${outDir}`);
