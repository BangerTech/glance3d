// Bambu Studio filament presets + Bambu Lab color names.
//
// src/data/filaments.json is produced by scripts/fetch-bambu-data.mjs from
// rolottr/bambu-bar's Resources/filaments.json (MIT). Shape:
//   { "presets": { "GFA01": ["Bambu Lab","PLA Matte"], ... },
//     "colors":  { "GFA01-RED": "Red", "A01-G1": "Grass Green", ... } }

import catalog from "./data/filaments.json";

type Catalog = { presets: Record<string, string[]>; colors: Record<string, string> };

const data = catalog as unknown as Catalog;

/** Resolve a `tray_info_idx` preset id to (vendor, product). Null for user presets. */
export function preset(
  id: string
): { vendor: string; product: string } | null {
  if (!id) return null;
  const entry = data.presets[id.toUpperCase()];
  if (!entry || entry.length < 2) return null;
  return { vendor: entry[0], product: entry[1] };
}

/**
 * Bambu's name for the spool's color: from the RFID tag code first
 * ("A01-G1" -> "Grass Green"), otherwise by preset + exact hex.
 */
export function colorName(
  tagCode: string,
  presetId: string | null,
  hex: string
): string | null {
  const parts = (tagCode ?? "").toUpperCase().split("-");
  if (parts.length === 2) {
    const letters = parts[1].match(/^[A-Z]+/)?.[0] ?? "";
    const numberPart = parts[1].slice(letters.length);
    const n = numberPart === "" ? "" : String(parseInt(numberPart, 10) || "");
    const key = `GF${parts[0]}-${letters}${n}`;
    const match = data.colors[key];
    if (match) return match;
  }
  if (!presetId || !hex || hex.length < 6) return null;
  return (
    data.colors[`${presetId.toUpperCase()}-${hex.slice(0, 6).toUpperCase()}`] ??
    null
  );
}
