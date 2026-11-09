// HMS and print_error catalog (German primary, English fallback).
//
// The JSON files under src/data/ are produced by scripts/fetch-bambu-data.mjs
// from rolottr/bambu-bar's Resources/HMS (MIT; originally from ha-bambulab's
// catalogues, also MIT). Shape: { hms: { "AABB...CCDD": "text" }, error: {...} }.
//
// `hmsText(key)` looks up a packed HMS key ("0300010000010007"), `errorText`
// a packed print_error key ("0700800C"). Both return null when unknown so the
// parser can fall back to a generic "The printer reported X." message.

import hmsDe from "./data/hms_de.json";
import hmsEn from "./data/hms_en.json";

type Table = { hms: Record<string, string>; error: Record<string, string> };

const de = hmsDe as Table;
const en = hmsEn as Table;

/** Localized text for an HMS key like "0300010000010007". */
export function hmsText(key: string): string | null {
  const k = key.toUpperCase();
  return de.hms[k] ?? en.hms[k] ?? null;
}

/** Localized text for a print_error key like "0300400C". */
export function errorText(key: string): string | null {
  const k = key.toUpperCase();
  return de.error[k] ?? en.error[k] ?? null;
}

/** Bambu Lab's HMS wiki URL (generic index; they don't deep-link per code). */
export function wikiURL(_prettyCode: string): string {
  return "https://wiki.bambulab.com/en/hms/home";
}
