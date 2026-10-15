"""
Attach museum objects from an extract_met.py dump onto the period nodes of a
world-history scaffold, following that file's own ingestNote: match each
object's place and date against tStart/tEnd and lat/lon, then append it to the
best-matching node's widgets array.

  python3 ingest_objects.py <scaffold.json> <objects.txt> <output.json>
"""
import argparse, json, math, re, sys, collections

KEYS = ["ID", "Title", "Description", "Year Scale (5000 BC=0)", "Origin Place",
        "Region", "Matched on", "Coordinates", "Image Link", "Hi-Res Image Link"]

# The node vocabulary is modern countries; object records use some historical
# names. Only needed as a scoring bonus - placement really rides on lat/lon.
ALIASES = {
    "mesopotamia": {"Iraq"}, "anatolia": {"Turkey"},
    "levant": {"Israel", "Lebanon", "Syria", "Jordan"},
    "nubia": {"Sudan", "Egypt"}, "persia": {"Iran"}, "babylonia": {"Iraq"},
    "assyria": {"Iraq"}, "phoenicia": {"Lebanon"}, "canaan": {"Israel"},
    "upper egypt": {"Egypt"}, "lower egypt": {"Egypt"}, "memphite": {"Egypt"},
    "byblos": {"Lebanon"}, "elam": {"Iran"}, "sumer": {"Iraq"},
    "black sea": {"Turkey", "Georgia"}, "aegean": {"Greece", "Turkey"},
}

def parse_records(path):
    text = open(path, encoding="utf-8").read()
    blocks = [b for b in re.split(r"^-{20,}\s*$", text, flags=re.M) if "ID:" in b]
    out = []
    for block in blocks:
        f, cur = {}, None
        for line in block.splitlines():
            k = next((k for k in KEYS if line.startswith(k + ":")), None)
            if k:
                cur = k; f[cur] = line[len(k) + 1:].strip()
            elif cur and line.strip():
                f[cur] += " " + line.strip()
        if "ID" in f:
            out.append(f)
    return out

def coords(v):
    m = re.search(r"Lat\s+(-?[\d.]+),\s*Lon\s+(-?[\d.]+)", v or "")
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)

def years(v):
    """'3019-3360' epoch (0 == 5000 BC) -> real year range."""
    m = re.match(r"\s*(-?\d+)(?:-(-?\d+))?", v or "")
    if not m:
        return None, None
    a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else a
    return min(a, b) - 5000, max(a, b) - 5000

def haversine(a, b, c, d):
    R = 6371.0
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = p2 - p1, math.radians(d - b)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))

def place_tokens(rec):
    """
    Modern country names implied by the record's origin TEXT. This is the
    trustworthy signal: several records carry coordinates geocoded from a bare
    historical name and land on the wrong continent - 'Upper Egypt, Thebes'
    resolves into Turkey, 'Southern Mesopotamia' onto the Russian Black Sea
    coast - while their origin text stays correct.
    """
    text = f"{rec.get('Origin Place','')} {rec.get('Region','')}".lower()
    found = set()
    for hist, moderns in ALIASES.items():
        if hist in text:
            found |= moderns
    for part in re.split(r"[,;]| or | and ", rec.get("Origin Place", "")):
        p = part.strip()
        if p and len(p) > 3:
            found.add(p)
    return found


def coords_trustworthy(rec):
    """Records flagged unverified were placed from a historical name alone."""
    return "unverified" not in (rec.get("Coordinates") or "")

ap = argparse.ArgumentParser(
    description="Attach extract_met objects to world-history period nodes.",
    epilog="example: python3 ingest_objects.py knowledge-world-history.json "
           "world1000.txt knowledge.json")
ap.add_argument("scaffold", help="world-history JSON with period nodes")
ap.add_argument("objects", help="extract_met.py text dump")
ap.add_argument("output", help="where to write the merged JSON")
ap.add_argument("--max-km", type=float, default=2000,
                help="reject a coordinate-only match beyond this distance (default 2000)")
ap.add_argument("--report", default=None,
                help="write unattached objects to this file for review")
args = ap.parse_args()
HISTORY, OBJECTS, OUT = args.scaffold, args.objects, args.output

doc = json.load(open(HISTORY, encoding="utf-8"))
kt = doc["knowledgeTree"]
nodes = kt["nodes"]
periods = [(k, v) for k, v in nodes.items() if v.get("kind") == "period"
           and isinstance(v.get("lat"), (int, float))]

records = parse_records(OBJECTS)
matched, unmatched = 0, []
per_node = collections.Counter()

for rec in records:
    lat, lon = coords(rec.get("Coordinates"))
    t0, t1 = years(rec.get("Year Scale (5000 BC=0)"))
    if lat is None or t0 is None:
        unmatched.append((rec["ID"], rec.get("Title", "")[:40], "no position or date"))
        continue

    tokens = place_tokens(rec)
    trusted = coords_trustworthy(rec)
    best = None
    for name, nd in periods:
        # hard requirement: the object's date must fall inside the period's span
        if nd["tEnd"] < t0 or nd["tStart"] > t1:
            continue
        dist = haversine(lat, lon, nd["lat"], nd["lon"])
        names = set(nd.get("places") or []) | {nd.get("primaryPlace")}
        if tokens & {nd.get("primaryPlace")}:
            bonus = 3            # the period's own country is the object's
        elif tokens & names:
            bonus = 2            # the object's country is within the period's reach
        else:
            bonus = 0
        # Name agreement is required unless the coordinate can be trusted.
        if bonus == 0 and (not trusted or dist > args.max_km):
            continue
        span = nd["tEnd"] - nd["tStart"]
        key = (-bonus, round(dist / 250) if trusted else 0, span, name)
        if best is None or key < best[0]:
            best = (key, name, dist, bonus)

    if best is None:
        why = "no period matches its place" if not trusted else "no period overlaps"
        unmatched.append((rec["ID"], rec.get("Title", "")[:40], why))
        continue

    _, name, dist, bonus = best
    img = (rec.get("Image Link") or "").strip()
    nodes[name]["widgets"].append({
        "url": img,
        "name": img,
        # Larger rendering of the same asset, when the source supplies one.
        "detailed_url": (rec.get("Hi-Res Image Link") or "").strip(),
        "notes": rec.get("Origin Place", ""),
        "prose": rec.get("Description", ""),
        "title": rec.get("Title") or "Untitled",
        "subtitle": re.search(r"\(Raw Date:\s*'(.*)'\)", rec.get("Year Scale (5000 BC=0)", "") or "").group(1)
                    if re.search(r"\(Raw Date:", rec.get("Year Scale (5000 BC=0)", "") or "") else "",
    })
    per_node[name] += 1
    matched += 1

json.dump(doc, open(OUT, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

print(f"objects in world200.txt : {len(records)}")
print(f"attached as widgets     : {matched}")
print(f"unattached              : {len(unmatched)}")
print(f"nodes receiving objects : {len(per_node)}")
print()
print("busiest nodes:")
for name, c in per_node.most_common(10):
    print(f"  {c:3}  {name[:66]}")
if unmatched:
    print("\nunattached (first 10):")
    for u in unmatched[:10]:
        print(f"  {u[0]}  {u[1][:40]:42} {u[2]}")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            for oid, title, why in unmatched:
                fh.write(f"{oid}\t{title}\t{why}\n")
        print(f"full list written to {args.report}")
print(f"\nwrote {OUT}")
