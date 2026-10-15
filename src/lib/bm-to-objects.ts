/**
 * Port of bm_to_objects.py: turn a British Museum CSV export into the object
 * records that ingest-objects.ts attaches to the world-history scaffold.
 */

export interface BMRecord {
  ID: string;
  Title: string;
  Description: string;
  /** epoch years, 0 == 5000 BC, e.g. "3019-3360 (Raw Date: '...')" */
  Year: string;
  "Origin Place": string;
  Region: string;
  Coordinates: string;
  "Image Link": string;
  "Hi-Res Image Link": string;
}

export interface GeoHit {
  lat: number;
  lon: number;
  country: string | null;
}

/** Minimal RFC4180 CSV parser (handles quotes, embedded newlines, BOM). */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

const NOISE =
  /\((?:circa|about|\?|probably|possibly|historic[^)]*|[^)]*?aftercast|issued|buried|reuse|finial|or)\)/gi;
const PREFIX = /^\s*[A-Za-z][A-Za-z/ ]{0,28}?\s*:\s*/;

export function cleanPlace(field: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (field || "").split(";")) {
    let p = part.replace(PREFIX, "");
    p = p.replace(NOISE, "");
    p = p.replace(/\([^)]*\)/g, "");
    p = p.replace(/\s+/g, " ").replace(/^[\s,.;]+|[\s,.;]+$/g, "");
    if (p && !["unknown", "unspecified"].includes(p.toLowerCase()) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** One date atom -> [start, end]. Handles '450 BC', '1470', '16thC', '3rdC BC'. */
function part(tok: string): [number, number] | null {
  const t = tok.trim();
  if (!t) return null;
  const bc = /BCE?\b/i.test(t);
  const cent = t.match(/(\d+)\s*(?:st|nd|rd|th)?\s*C\b/i);
  if (cent && /\d\s*(?:st|nd|rd|th)\s*C\b/i.test(t)) {
    const n = parseInt(cent[1], 10);
    if (bc) return [-(n * 100), -((n - 1) * 100 + 1)];
    return [(n - 1) * 100, n * 100 - 1];
  }
  const num = t.match(/(\d+)/);
  if (!num) return null;
  const y = parseInt(num[1], 10);
  return bc ? [-y, -y] : [y, y];
}

export function parseBmDate(text: string | undefined): [number, number] | null {
  if (!text) return null;
  let s = text.split(";")[0];
  s = s.replace(NOISE, " ");
  s = s.replace(/\((?:early|mid|late|middle)\)/gi, " ");
  s = s.replace(/\b(?:early|mid|late|middle|end of|beginning of)\b/gi, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/[–—]/g, "-");
  const parts = s.split(/\s*-\s*/).filter((p) => p.trim());
  const spans = parts.map(part).filter(Boolean) as [number, number][];
  if (!spans.length) return null;
  return [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))];
}

const CULTURE_COUNTRY: Record<string, string> = {
  attic: "Greece", greek: "Greece", hellenistic: "Greece", minoan: "Greece",
  mycenaean: "Greece", cycladic: "Greece", roman: "Italy", etruscan: "Italy",
  apulian: "Italy", villanovan: "Italy", faliscan: "Italy",
  "anglo-saxon": "United Kingdom", "romano-british": "United Kingdom",
  celtic: "United Kingdom", pictish: "United Kingdom", viking: "Norway",
  norse: "Norway", assyrian: "Iraq", babylonian: "Iraq", sumerian: "Iraq",
  achaemenid: "Iran", sasanian: "Iran", parthian: "Iran",
  merovingian: "France", frankish: "France", gaulish: "France",
  egyptian: "Egypt", nubian: "Sudan", phoenician: "Lebanon",
  edo: "Japan", japanese: "Japan", zhou: "China", han: "China", tang: "China",
  chinese: "China", sikh: "India", mughal: "India", indian: "India",
  byzantine: "Turkey", ottoman: "Turkey", hittite: "Turkey",
  benin: "Nigeria", asante: "Ghana", maya: "Mexico", aztec: "Mexico",
};

/** Bounding boxes per BM department, as [[south, west], [north, east]]. */
export const DEPT_BOX: Record<string, [[number, number], [number, number]]> = {
  "Britain, Europe and Prehistory": [[34.0, -25.0], [72.0, 45.0]],
  "Greek and Roman": [[30.0, -10.0], [48.0, 45.0]],
  "Middle East": [[12.0, 25.0], [45.0, 65.0]],
  Asia: [[0.0, 60.0], [55.0, 150.0]],
  "Egypt and Sudan": [[3.0, 22.0], [32.0, 38.0]],
};

export function cultureCountry(field: string | undefined): string | null {
  const text = (field || "").toLowerCase();
  for (const [key, country] of Object.entries(CULTURE_COUNTRY)) {
    if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)) return country;
  }
  return null;
}

function cleanType(field: string | undefined): string {
  const first = (field || "").split(";")[0].replace(/\((?:object name|object type)\)/gi, "");
  return first.replace(/\s+/g, " ").replace(/^[\s,.;]+|[\s,.;]+$/g, "");
}

function museumNumber(field: string | undefined): string {
  const m = (field || "").match(/\[([^\]]+)\]/);
  return ((m ? m[1] : field || "").trim()) || "unknown";
}

function hiRes(url: string): string {
  if (!url || !url.includes("/")) return "";
  const idx = url.lastIndexOf("/");
  const head = url.slice(0, idx);
  const name = url.slice(idx + 1);
  if (!name.startsWith("preview_")) return "";
  return `${head}/mid_${name.slice("preview_".length)}`;
}

function oneLine(text: string | undefined, limit = 1200): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Every place that may need geocoding, with the department that bounds it. */
export function placesToGeocode(rows: Record<string, string>[]): { place: string; dept: string }[] {
  const seen = new Set<string>();
  const out: { place: string; dept: string }[] = [];
  for (const row of rows) {
    if (!parseBmDate(row["Production date"])) continue;
    const places = [...cleanPlace(row["Production place"]), ...cleanPlace(row["Find spot"])];
    const ordered: string[] = [];
    const lower = new Set<string>();
    for (const p of places) {
      if (!lower.has(p.toLowerCase())) {
        lower.add(p.toLowerCase());
        ordered.push(p);
      }
    }
    const dept = (row["Dept"] || "").trim();
    for (const p of ordered.slice(0, 3)) {
      const key = `${p}@${DEPT_BOX[dept] ? dept : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ place: p, dept });
    }
  }
  return out;
}

export function geoKey(place: string, dept: string): string {
  return `${place}@${DEPT_BOX[(dept || "").trim()] ? dept.trim() : ""}`;
}

export interface ConvertResult {
  records: BMRecord[];
  skipped: { id: string; type: string; why: string }[];
}

/** BM rows -> object records. `geo` maps geoKey() to a hit (or null for a miss). */
export function convertBmRows(
  rows: Record<string, string>[],
  geo: Record<string, GeoHit | null> = {},
): ConvertResult {
  const records: BMRecord[] = [];
  const skipped: { id: string; type: string; why: string }[] = [];
  const useGeo = Object.keys(geo).length > 0;

  for (const row of rows) {
    const span = parseBmDate(row["Production date"]);
    if (!span) {
      skipped.push({ id: museumNumber(row["Museum number"]), type: cleanType(row["Object type"]), why: "no usable production date" });
      continue;
    }
    const places = [...cleanPlace(row["Production place"]), ...cleanPlace(row["Find spot"])];
    const ordered: string[] = [];
    const lower = new Set<string>();
    for (const p of places) {
      if (!lower.has(p.toLowerCase())) {
        lower.add(p.toLowerCase());
        ordered.push(p);
      }
    }
    if (!ordered.length) {
      skipped.push({ id: museumNumber(row["Museum number"]), type: cleanType(row["Object type"]), why: "no production place or find spot" });
      continue;
    }

    const title =
      oneLine(row["Title"]) || cleanType(row["Object type"]) || oneLine(row["Description"], 60) || "Untitled";

    const bits: string[] = [];
    if (cleanType(row["Object type"])) bits.push(`Type: ${cleanType(row["Object type"])}`);
    if (oneLine(row["Materials"])) bits.push(`Medium: ${oneLine(row["Materials"], 120)}`);
    if (oneLine(row["Dimensions"])) bits.push(`Dimensions: ${oneLine(row["Dimensions"], 160)}`);
    if (oneLine(row["Culture"])) bits.push(`Culture: ${oneLine(row["Culture"], 120)}`);
    const desc = oneLine(row["Description"]);
    const description = (desc ? desc + " | " : "") + bits.join(" | ");

    let lat = 0;
    let lon = 0;
    let note = "no coordinates in British Museum export";
    let trusted = false;

    if (useGeo) {
      const expected = cultureCountry(row["Culture"]);
      const dept = row["Dept"] || "";
      for (const place of ordered.slice(0, 3)) {
        const hit = geo[geoKey(place, dept)];
        if (!hit) continue;
        const country = hit.country;
        if (expected && country && country !== expected) continue;
        if (!trusted) {
          lat = hit.lat;
          lon = hit.lon;
          note = `geocoded '${place}'`;
          trusted = true;
        }
        if (country && !ordered.includes(country)) ordered.push(country);
      }
      if (expected && !ordered.includes(expected)) ordered.push(expected);
    }

    const [t0, t1] = span;
    const image = oneLine(row["Image"]);
    records.push({
      ID: museumNumber(row["Museum number"]),
      Title: title,
      Description: description,
      Year: `${t0 + 5000}-${t1 + 5000} (Raw Date: '${oneLine(row["Production date"], 80)}')`,
      "Origin Place": ordered.join(", "),
      Region: ordered[0],
      Coordinates:
        `Lat ${lat}, Lon ${lon} (${note})` + (trusted ? "" : " [unverified: no country on record]"),
      "Image Link": image,
      "Hi-Res Image Link": hiRes(image),
    });
  }
  return { records, skipped };
}
