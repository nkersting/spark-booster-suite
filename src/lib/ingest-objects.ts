/**
 * Port of ingest_objects.py: attach museum objects onto the period nodes of a
 * world-history scaffold by matching place and date, appending each object to
 * the best-matching node's widgets array.
 */
import type { BMRecord } from "@/lib/bm-to-objects";

const ALIASES: Record<string, string[]> = {
  mesopotamia: ["Iraq"], anatolia: ["Turkey"],
  levant: ["Israel", "Lebanon", "Syria", "Jordan"],
  nubia: ["Sudan", "Egypt"], persia: ["Iran"], babylonia: ["Iraq"],
  assyria: ["Iraq"], phoenicia: ["Lebanon"], canaan: ["Israel"],
  "upper egypt": ["Egypt"], "lower egypt": ["Egypt"], memphite: ["Egypt"],
  byblos: ["Lebanon"], elam: ["Iran"], sumer: ["Iraq"],
  "black sea": ["Turkey", "Georgia"], aegean: ["Greece", "Turkey"],
};

function coords(v: string | undefined): [number | null, number | null] {
  const m = (v || "").match(/Lat\s+(-?[\d.]+),\s*Lon\s+(-?[\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [null, null];
}

function years(v: string | undefined): [number | null, number | null] {
  const m = (v || "").match(/^\s*(-?\d+)(?:-(-?\d+))?/);
  if (!m) return [null, null];
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return [Math.min(a, b) - 5000, Math.max(a, b) - 5000];
}

function haversine(a: number, b: number, c: number, d: number): number {
  const R = 6371;
  const p1 = (a * Math.PI) / 180;
  const p2 = (c * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((d - b) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function placeTokens(rec: BMRecord): Set<string> {
  const text = `${rec["Origin Place"] || ""} ${rec.Region || ""}`.toLowerCase();
  const found = new Set<string>();
  for (const [hist, moderns] of Object.entries(ALIASES)) {
    if (text.includes(hist)) moderns.forEach((m) => found.add(m));
  }
  for (const raw of (rec["Origin Place"] || "").split(/[,;]| or | and /)) {
    const p = raw.trim();
    if (p && p.length > 3) found.add(p);
  }
  return found;
}

const trustworthy = (rec: BMRecord) => !(rec.Coordinates || "").includes("unverified");

export interface IngestResult {
  doc: any;
  matched: number;
  unmatched: number;
  nodesTouched: number;
}

export function ingestObjects(scaffold: any, records: BMRecord[], maxKm = 2000): IngestResult {
  const doc = scaffold;
  const nodes = doc.knowledgeTree.nodes as Record<string, any>;
  const periods = Object.entries(nodes).filter(
    ([, v]: [string, any]) => v?.kind === "period" && typeof v.lat === "number",
  ) as [string, any][];

  let matched = 0;
  let unmatched = 0;
  const touched = new Set<string>();

  for (const rec of records) {
    const [lat, lon] = coords(rec.Coordinates);
    const [t0, t1] = years(rec.Year);
    if (lat === null || t0 === null) {
      unmatched++;
      continue;
    }
    const tokens = placeTokens(rec);
    const trusted = trustworthy(rec);
    let best: { key: (number | string)[]; name: string } | null = null;

    for (const [name, nd] of periods) {
      if (nd.tEnd < t0 || nd.tStart > (t1 as number)) continue;
      const dist = haversine(lat, lon as number, nd.lat, nd.lon);
      const names = new Set<string>([...(nd.places || []), nd.primaryPlace].filter(Boolean));
      let bonus = 0;
      if (nd.primaryPlace && tokens.has(nd.primaryPlace)) bonus = 3;
      else if ([...tokens].some((t) => names.has(t))) bonus = 2;
      if (bonus === 0 && (!trusted || dist > maxKm)) continue;
      const span = nd.tEnd - nd.tStart;
      const key = [-bonus, trusted ? Math.round(dist / 250) : 0, span, name];
      if (best === null || compareKeys(key, best.key) < 0) best = { key, name };
    }

    if (!best) {
      unmatched++;
      continue;
    }

    const img = (rec["Image Link"] || "").trim();
    const raw = (rec.Year || "").match(/\(Raw Date:\s*'(.*)'\)/);
    const node = nodes[best.name];
    if (!Array.isArray(node.widgets)) node.widgets = [];
    node.widgets.push({
      url: img,
      name: img,
      detailed_url: (rec["Hi-Res Image Link"] || "").trim(),
      notes: rec["Origin Place"] || "",
      prose: rec.Description || "",
      title: rec.Title || "Untitled",
      subtitle: raw ? raw[1] : "",
    });
    touched.add(best.name);
    matched++;
  }

  return { doc, matched, unmatched, nodesTouched: touched.size };
}

function compareKeys(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
