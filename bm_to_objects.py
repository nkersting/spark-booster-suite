#!/usr/bin/env python3
"""
Convert a British Museum collection CSV export into the text format that
ingest_objects.py reads.

  python3 bm_to_objects.py collections.csv bm_objects.txt

The BM export carries no coordinates, but its place fields are good text
("Made in: Iran", "Found/Acquired: Awadh"). Coordinates are therefore emitted as
a placeholder tagged '[unverified: no country on record]', which is the marker
ingest_objects.py already uses to ignore a coordinate and match on origin text
alone. Pass --geocode if you would rather resolve real coordinates, but note
that BM place strings include historical and compound names ("Urbino, Duchy of
(historic)") that geocode poorly.
"""
import argparse
import collections
import csv
import json
import os
import re
import sys

csv.field_size_limit(10 ** 7)

# Qualifiers the BM appends that say nothing about when or where.
NOISE = re.compile(r"\((?:circa|about|\?|probably|possibly|historic[^)]*|[^)]*?"
                   r"aftercast|issued|buried|reuse|finial|or)\)", re.I)
# The export labels every place with how it relates to the object - "Made in:",
# "Factory in:", "Minted in:", "Decorated in:", "Associated with:" - so strip any
# leading label rather than enumerate them.
PREFIX = re.compile(r"^\s*[A-Za-z][A-Za-z/ ]{0,28}?\s*:\s*")


def clean_place(field):
    """'Made in: Iran (?);  Made in: Pesaro' -> ['Iran', 'Pesaro']"""
    out = []
    for part in (field or "").split(";"):
        p = PREFIX.sub("", part)
        p = NOISE.sub("", p)
        p = re.sub(r"\([^)]*\)", "", p)          # any remaining parenthetical
        p = re.sub(r"\s+", " ", p).strip(" ,.;")
        if p and p.lower() not in {"unknown", "unspecified"} and p not in out:
            out.append(p)
    return out


def _part(tok):
    """One date atom -> (start, end). Handles '450 BC', '1470', '16thC', '3rdC BC'."""
    tok = tok.strip()
    if not tok:
        return None
    # No leading \b: "380BC" has no boundary between "0" and "B", which would
    # silently drop the sign on the commonest BC form in this export.
    bc = bool(re.search(r"BCE?\b", tok, re.I))
    cent = re.search(r"(\d+)\s*(?:st|nd|rd|th)?\s*C\b", tok, re.I)
    if cent and re.search(r"\d\s*(?:st|nd|rd|th)\s*C\b", tok, re.I):
        n = int(cent.group(1))
        if bc:
            return -(n * 100), -((n - 1) * 100 + 1)
        return (n - 1) * 100, n * 100 - 1
    num = re.search(r"(\d+)", tok)
    if not num:
        return None
    y = int(num.group(1))
    return (-y, -y) if bc else (y, y)


def parse_bm_date(text):
    """BM 'Production date' -> (earliest, latest) as signed years, or None."""
    if not text:
        return None
    s = text.split(";")[0]                        # first date phrase only
    s = NOISE.sub(" ", s)
    s = re.sub(r"\((?:early|mid|late|middle)\)", " ", s, flags=re.I)
    s = re.sub(r"\b(?:early|mid|late|middle|end of|beginning of)\b", " ", s, flags=re.I)
    s = re.sub(r"\([^)]*\)", " ", s)
    s = s.replace("–", "-").replace("—", "-")
    parts = [p for p in re.split(r"\s*-\s*", s) if p.strip()]
    spans = [x for x in (_part(p) for p in parts) if x]
    if not spans:
        return None
    return min(s[0] for s in spans), max(s[1] for s in spans)



# A bare site name geocodes to whichever modern town shares it: "Attica"
# resolves to Attica, New York and "Uig" to Uige in Angola, which put Greek
# amphorae on a Native American culture and the Lewis Chessmen in Botswana.
# The export's Culture field is the tiebreaker: where it names a place, the
# culture wins and the contradicting coordinate is distrusted.
CULTURE_COUNTRY = {
    "attic": "Greece", "greek": "Greece", "hellenistic": "Greece",
    "minoan": "Greece", "mycenaean": "Greece", "cycladic": "Greece",
    "roman": "Italy", "etruscan": "Italy", "apulian": "Italy",
    "villanovan": "Italy", "faliscan": "Italy",
    "anglo-saxon": "United Kingdom", "romano-british": "United Kingdom",
    "celtic": "United Kingdom", "pictish": "United Kingdom",
    "viking": "Norway", "norse": "Norway",
    "assyrian": "Iraq", "babylonian": "Iraq", "sumerian": "Iraq",
    "achaemenid": "Iran", "sasanian": "Iran", "parthian": "Iran",
    "merovingian": "France", "frankish": "France", "gaulish": "France",
    "egyptian": "Egypt", "nubian": "Sudan", "phoenician": "Lebanon",
    "edo": "Japan", "japanese": "Japan",
    "zhou": "China", "han": "China", "tang": "China", "chinese": "China",
    "sikh": "India", "mughal": "India", "indian": "India",
    "byzantine": "Turkey", "ottoman": "Turkey", "hittite": "Turkey",
    "benin": "Nigeria", "asante": "Ghana", "maya": "Mexico", "aztec": "Mexico",
}

# The Dept column is coarse but geographic, and Nominatim can be bounded to a
# box. Searching "Nola" inside Europe returns Nola in Campania instead of New
# Orleans, and it rescues rows whose Culture field is empty.
DEPT_BOX = {
    "Britain, Europe and Prehistory": [(34.0, -25.0), (72.0, 45.0)],
    "Greek and Roman":                [(30.0, -10.0), (48.0, 45.0)],
    "Middle East":                    [(12.0, 25.0), (45.0, 65.0)],
    "Asia":                           [(0.0, 60.0), (55.0, 150.0)],
    "Egypt and Sudan":                [(3.0, 22.0), (32.0, 38.0)],
}

GEO_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".bm_geocache.json")


def culture_country(field):
    """Modern country implied by the BM Culture field, if any."""
    text = (field or "").lower()
    for key, country in CULTURE_COUNTRY.items():
        if re.search(rf"\b{re.escape(key)}", text):
            return country
    return None


def _save_cache(cache):
    try:
        json.dump(cache, open(GEO_CACHE, "w", encoding="utf-8"))
    except OSError:
        pass


def clean_type(field):
    """'standard (object name); alam (object name)' -> 'standard'"""
    first = (field or "").split(";")[0]
    first = re.sub(r"\((?:object name|object type)\)", "", first, flags=re.I)
    return re.sub(r"\s+", " ", first).strip(" ,.;")


def museum_number(field):
    """The export wraps these as 'No: Optional[1885,0508.21]'."""
    m = re.search(r"\[([^\]]+)\]", field or "")
    return (m.group(1) if m else (field or "")).strip() or "unknown"


def hi_res(url):
    """
    The export links the preview rendering; the same asset is served at a larger
    size under a 'mid_' prefix. Only the final path segment is rewritten - the
    directory names contain unrelated text that must not be touched.
    """
    if not url or "/" not in url:
        return ""
    head, _, name = url.rpartition("/")
    if not name.startswith("preview_"):
        return ""            # 21 rows use a different filename scheme entirely
    return f"{head}/mid_{name[len('preview_'):]}"


def one_line(text, limit=1200):
    t = re.sub(r"\s+", " ", (text or "")).strip()
    return t[:limit]


def convert(rows, geocode=False, retry_misses=False):
    """BM rows -> records in the text shape ingest_objects.py parses."""
    out, skipped = [], []
    coder, cache = None, {}
    if geocode:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import extract_met
        coder = extract_met
        # Nominatim is rate limited and was flaky across this dataset, so keep
        # every lookup on disk: a re-run costs nothing and retries only misses.
        if os.path.exists(GEO_CACHE):
            try:
                cache = json.load(open(GEO_CACHE, encoding="utf-8"))
            except (OSError, ValueError):
                cache = {}
        if retry_misses:
            # Cached nulls are often timeouts rather than genuine misses, so
            # allow them to be re-queried without discarding good lookups.
            dropped = [k for k, v in cache.items() if not v]
            for k in dropped:
                del cache[k]
            print(f"retrying {len(dropped)} cached misses")

    def lookup(place, dept=None):
        box = DEPT_BOX.get((dept or "").strip())
        key = f"{place}@{dept}" if box else place
        if key in cache:
            return cache[key]
        kw = {"addressdetails": True, "language": "en"}   # en, or countries come
        if box:                                           # back as Norge / Italia
            kw.update(viewbox=box, bounded=True)
        try:
            loc = coder.geocode(place, **kw)
        except Exception:
            loc = None
        if loc:
            addr = (getattr(loc, "raw", {}) or {}).get("address") or {}
            cache[key] = {"lat": loc.latitude, "lon": loc.longitude,
                          "country": addr.get("country")}
        else:
            cache[key] = None        # misses cached too; delete the file to retry
        return cache[key]

    for row in rows:
        span = parse_bm_date(row.get("Production date"))
        if not span:
            skipped.append((museum_number(row.get("Museum number")),
                            clean_type(row.get("Object type")), "no usable production date"))
            continue

        places = clean_place(row.get("Production place")) + clean_place(row.get("Find spot"))
        seen, ordered = set(), []
        for p in places:
            if p.lower() not in seen:
                seen.add(p.lower()); ordered.append(p)
        if not ordered:
            skipped.append((museum_number(row.get("Museum number")),
                            clean_type(row.get("Object type")), "no production place or find spot"))
            continue

        title = one_line(row.get("Title")) or clean_type(row.get("Object type")) \
                or one_line(row.get("Description"), 60) or "Untitled"

        bits = []
        if clean_type(row.get("Object type")):
            bits.append(f"Type: {clean_type(row.get('Object type'))}")
        if one_line(row.get("Materials")):
            bits.append(f"Medium: {one_line(row.get('Materials'), 120)}")
        if one_line(row.get("Dimensions")):
            bits.append(f"Dimensions: {one_line(row.get('Dimensions'), 160)}")
        if one_line(row.get("Culture")):
            bits.append(f"Culture: {one_line(row.get('Culture'), 120)}")
        desc = one_line(row.get("Description"))
        description = (desc + " | " if desc else "") + " | ".join(bits)

        lat, lon, note = 0.0, 0.0, "no coordinates in British Museum export"
        trusted = False
        if coder:
            # The scaffold's place vocabulary is modern countries, but the BM
            # names sites and cities - Attica, Sutton Hoo, Somme-Bionne. Resolve
            # each to its country and add that to the origin text, or nothing
            # downstream can match it.
            expected = culture_country(row.get("Culture"))
            dept = row.get("Dept")
            for place in ordered[:3]:
                hit = lookup(place, dept)
                if not hit:
                    continue
                country = hit.get("country")
                if expected and country and country != expected:
                    continue          # culture contradicts it; trust the culture
                if not trusted:
                    lat, lon, note, trusted = (hit["lat"], hit["lon"],
                                               f"geocoded '{place}'", True)
                if country and country not in ordered:
                    ordered.append(country)
            if expected and expected not in ordered:
                ordered.append(expected)

        t0, t1 = span
        out.append({
            "ID": museum_number(row.get("Museum number")),
            "Title": title,
            "Description": description,
            # epoch years, matching extract_met: 0 == 5000 BC
            "Year": f"{t0 + 5000}-{t1 + 5000} (Raw Date: '{one_line(row.get('Production date'), 80)}')",
            "Origin Place": ", ".join(ordered),
            "Region": ordered[0],
            "Coordinates": f"Lat {lat}, Lon {lon} ({note})"
                           + ("" if trusted else " [unverified: no country on record]"),
            "Image Link": one_line(row.get("Image")),
            "Hi-Res Image Link": hi_res(one_line(row.get("Image"))),
        })
    if coder:
        _save_cache(cache)
    return out, skipped


def write_records(records, path):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"Converted {len(records)} British Museum records.\n\n")
        fh.write("=" * 60 + "\n")
        for r in records:
            fh.write(f"ID: {r['ID']}\n")
            fh.write(f"Title: {r['Title']}\n")
            fh.write(f"Description: {r['Description']}\n")
            fh.write(f"Year Scale (5000 BC=0): {r['Year']}\n")
            fh.write(f"Origin Place: {r['Origin Place']}\n")
            fh.write(f"Region: {r['Region']}\n")
            fh.write(f"Matched on: region='{r['Region']}' [british-museum]\n")
            fh.write(f"Coordinates: {r['Coordinates']}\n")
            fh.write(f"Image Link: {r['Image Link']}\n")
            fh.write(f"Hi-Res Image Link: {r['Hi-Res Image Link']}\n")
            fh.write("-" * 60 + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="British Museum CSV export")
    ap.add_argument("output", nargs="?", help="text file for ingest_objects.py")
    ap.add_argument("--geocode", action="store_true",
                    help="resolve real coordinates via extract_met's geocoder (slow, "
                         "and BM place strings geocode poorly)")
    ap.add_argument("--retry-misses", action="store_true",
                    help="re-query places cached as unresolved (usually timeouts)")
    ap.add_argument("--report", default=None, help="write skipped rows here")
    ap.add_argument("--test", action="store_true", help="check date parsing only")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.csv, encoding="utf-8-sig")))

    if args.test:
        dates = sorted({(r.get("Production date") or "").strip() for r in rows} - {""})
        bad = [d for d in dates if parse_bm_date(d) is None]
        print(f"distinct date strings: {len(dates)}   parsed: {len(dates)-len(bad)}   failed: {len(bad)}")
        for d in bad[:10]:
            print("   failed:", d)
        return

    if not args.output:
        ap.error("give an output path (or use --test)")

    records, skipped = convert(rows, geocode=args.geocode,
                               retry_misses=args.retry_misses)
    write_records(records, args.output)

    print(f"rows in CSV      : {len(rows)}")
    print(f"converted        : {len(records)}")
    print(f"skipped          : {len(skipped)}")
    why = collections.Counter(w for _, _, w in skipped)
    for k, v in why.most_common():
        print(f"   {v:5}  {k}")
    if args.report and skipped:
        with open(args.report, "w", encoding="utf-8") as fh:
            for oid, t, w in skipped:
                fh.write(f"{oid}\t{t}\t{w}\n")
        print(f"skipped rows written to {args.report}")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
