#!/usr/bin/env python3
"""
Migrate a legacy knowledge.json  ->  schema 1.0.

Legacy shape:   { seo, pageTitle, knowledgeTree: { root, space?, nodes{}, connections{}, edges[]? }, pageDescription }
Target shape:   { schemaVersion, document{}, graph{ rootNodeId, nodes[], edges }, extensions{} }

graph.edges is a nested adjacency map: keyed by source node id, then by target
node id, valued by that edge's attributes (weight, plus relation where the
source file supplied one). Target ids are never repeated, so parallel edges
between the same pair cannot be represented.

    "edges": { "<sourceId>": { "<targetId>": { "weight": 1,
                                               "relation": "succeeds" } } }

Works for both "abstract space" documents (no space / no node positions) and
Earth/Euclidean ones (space + per-node position), since position is optional and
`space` is moved into extensions.

Usage
-----
  python3 migrate_schema.py IN.json [-o OUT.json]
  python3 migrate_schema.py IN.json --edge-style objects
  python3 migrate_schema.py IN.json --random-ids
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid

SCHEMA_VERSION = "1.0"
DEFAULT_LANGUAGE = "en-us"

# Fixed namespace so ids are reproducible across runs: the same input key always
# yields the same GUID. Use --random-ids for uuid4 instead.
NAMESPACE = uuid.UUID("6f1b2d7a-6a1e-5a3f-9c42-0b7d9f2a4c18")

# knowledgeTree keys consumed by the graph proper; everything else is renderer config.
GRAPH_KEYS = {"root", "rootNodeId", "nodes", "connections", "edges"}

# node keys consumed by the target schema; everything else is preserved under `hints`.
NODE_KEYS = {"node", "name", "title", "weight", "icon", "prose", "description",
             "position", "widgets", "content", "hints"}

# widget keys consumed by content[]; leftovers are preserved under properties.extra.
WIDGET_KEYS = {"title", "subtitle", "name", "icon", "prose", "notes", "url",
               "source", "source_url", "weight", "type", "id"}


# ---------------------------------------------------------------- ids
class IdFactory:
    def __init__(self, doc_id: str, random: bool = False):
        self.doc_id = doc_id
        self.random = random
        self._seen: dict[str, str] = {}

    def make(self, kind: str, key: str) -> str:
        if self.random:
            return str(uuid.uuid4())
        seed = "%s|%s|%s" % (self.doc_id, kind, key)
        if seed in self._seen:            # identical seed -> identical id, by design
            return self._seen[seed]
        val = str(uuid.uuid5(NAMESPACE, seed))
        self._seen[seed] = val
        return val


# ---------------------------------------------------------------- helpers
def _join(parts, sep):
    """Join non-empty, de-duplicated string parts."""
    out = []
    for p in parts:
        if p is None:
            continue
        s = str(p).strip()
        if s and s not in out:
            out.append(s)
    return sep.join(out)


def _leftovers(src: dict, consumed: set) -> dict:
    return {k: v for k, v in src.items() if k not in consumed}


# ---------------------------------------------------------------- content[]
def map_widget(widget: dict, ids: IdFactory, node_key: str, index: int) -> dict:
    title = widget.get("title") or ""
    subtitle = widget.get("subtitle") or ""

    properties = {
        # legacy widgets abuse `name` to hold the image URL; `icon` wins if present
        "icon": widget.get("icon") or widget.get("name") or "",
        "title": _join([title, subtitle], " — "),
        "notes": _join([widget.get("prose"), widget.get("notes")], "\n\n"),
        "source_url": widget.get("source_url") or widget.get("url") or widget.get("source") or "",
    }
    extra = _leftovers(widget, WIDGET_KEYS)
    if extra:
        properties["extra"] = extra

    return {
        "id": widget.get("id") or ids.make("content", "%s#%d|%s" % (node_key, index, title)),
        "name": title,
        "weight": widget.get("weight", 1),
        "type": widget.get("type", ""),
        "properties": properties,
    }


# ---------------------------------------------------------------- nodes[]
def map_node(key: str, node: dict, ids: IdFactory) -> dict:
    out = {
        "id": ids.make("node", key),
        "name": key,
        "title": key,
        "weight": node.get("weight", 1),
        "description": node.get("prose") or node.get("description") or "",
    }
    if node.get("icon"):
        out["icon"] = node["icon"]
    if node.get("position") is not None:
        out["position"] = node["position"]

    widgets = node.get("widgets") or node.get("content") or []
    out["content"] = [map_widget(w, ids, key, i) for i, w in enumerate(widgets)]

    hints = _leftovers(node, NODE_KEYS)
    hints.pop("node", None)                       # redundant with name
    if node.get("hints"):
        hints.update(node["hints"])
    if hints:
        out["hints"] = hints
    return out


# ---------------------------------------------------------------- edges
def map_edges(legacy: dict, name_to_id: dict, ids: IdFactory, style: str):
    """Returns (edges, stats). `connections` is the primary source; a typed
    `edges` array, when present, supplies relation/weight."""
    connections = legacy.get("connections") or {}
    typed = {}
    for e in legacy.get("edges") or []:
        s, t = e.get("from") or e.get("source"), e.get("to") or e.get("target")
        if s is not None and t is not None:
            typed[(s, t)] = e

    pairs, dangling = [], []
    if connections:
        for src, targets in connections.items():
            for tgt in targets or []:
                if src in name_to_id and tgt in name_to_id:
                    pairs.append((src, tgt))
                else:
                    dangling.append((src, tgt))
    else:                                          # no connections: fall back to edges[]
        for (s, t) in typed:
            if s in name_to_id and t in name_to_id:
                pairs.append((s, t))
            else:
                dangling.append((s, t))

    stats = {"edges": len(pairs), "dangling": len(dangling), "typed": 0}

    if style == "objects":
        out = []
        for src, tgt in pairs:
            meta = typed.get((src, tgt), {})
            ed = {
                "id": ids.make("edge", "%s->%s" % (src, tgt)),
                "source": name_to_id[src],
                "target": name_to_id[tgt],
                "weight": meta.get("weight", 1),
            }
            rel = meta.get("relation") or meta.get("type")
            if rel:
                ed["relation"] = rel
                stats["typed"] += 1
            if meta.get("note"):
                ed["note"] = meta["note"]
            out.append(ed)
        return out, stats

    # default: {sourceId: {targetId: {attrs}}} -- adjacency map, no repeated ids
    out = {}
    collisions = 0
    for src, tgt in pairs:
        meta = typed.get((src, tgt), {})
        attrs = {"weight": meta.get("weight", 1)}
        rel = meta.get("relation") or meta.get("type")
        if rel:
            attrs["relation"] = rel
            stats["typed"] += 1
        if meta.get("note"):
            attrs["note"] = meta["note"]
        bucket = out.setdefault(name_to_id[src], {})
        if name_to_id[tgt] in bucket:
            collisions += 1          # structure cannot hold parallel edges
        bucket[name_to_id[tgt]] = attrs
    stats["collisions"] = collisions
    return out, stats


# ---------------------------------------------------------------- document
def migrate(src: dict, *, source_name: str, language: str,
            schema_version: str, edge_style: str, random_ids: bool):
    seo = src.get("seo") or {}
    page_title = src.get("pageTitle") or ""
    legacy = src.get("knowledgeTree") or src.get("graph") or {}

    doc_title = seo.get("title") or page_title or source_name
    doc_id_seed = "%s|%s" % (source_name, doc_title)
    doc_id = str(uuid.uuid4()) if random_ids else str(uuid.uuid5(NAMESPACE, doc_id_seed))
    ids = IdFactory(doc_id_seed, random=random_ids)

    meta = {"pagetitle": page_title}
    # seo.prose and pageDescription have no home in document.{title,description};
    # keep them rather than drop them.
    if seo.get("prose"):
        meta["seoProse"] = seo["prose"]
    if src.get("pageDescription"):
        meta["pageDescription"] = src["pageDescription"]
    for k, v in (seo.items() if isinstance(seo, dict) else []):
        if k not in ("title", "description", "prose"):
            meta.setdefault("seo_" + k, v)
    meta["migratedFrom"] = source_name

    document = {
        "id": doc_id,
        "title": doc_title,
        "description": seo.get("description") or src.get("pageDescription") or "",
        "language": language,
        "meta": meta,
    }

    # ---- nodes
    raw_nodes = legacy.get("nodes") or {}
    if isinstance(raw_nodes, dict):
        items = list(raw_nodes.items())
    else:                                          # already a list
        items = [((n.get("name") or n.get("node") or n.get("id")), n) for n in raw_nodes]

    nodes, name_to_id = [], {}
    for key, node in items:
        mapped = map_node(key, node, ids)
        nodes.append(mapped)
        name_to_id[key] = mapped["id"]

    # ---- root
    root_name = legacy.get("root") or legacy.get("rootNodeId")
    if root_name not in name_to_id:
        # fall back to the heaviest node, then to a node with no inbound edge
        inbound = set()
        for targets in (legacy.get("connections") or {}).values():
            inbound.update(targets or [])
        cands = [k for k, n in items if k not in inbound]
        if root_name is not None and root_name not in name_to_id:
            print("  ! declared root %r not among nodes; inferring" % root_name, file=sys.stderr)
        root_name = max(items, key=lambda kv: kv[1].get("weight", 0))[0] if not cands else cands[0]

    edges, stats = map_edges(legacy, name_to_id, ids, edge_style)

    extensions = {"rendererSpecificProperties": _leftovers(legacy, GRAPH_KEYS)}

    out = {
        "schemaVersion": schema_version,
        "document": document,
        "graph": {
            "rootNodeId": name_to_id[root_name],
            "nodes": nodes,
            "edges": edges,
        },
        "extensions": extensions,
    }
    stats.update({
        "nodes": len(nodes),
        "content": sum(len(n["content"]) for n in nodes),
        "withPosition": sum(1 for n in nodes if "position" in n),
        "withHints": sum(1 for n in nodes if "hints" in n),
        "root": root_name,
        "space": extensions["rendererSpecificProperties"].get("space"),
    })
    return out, stats


# ---------------------------------------------------------------- validate
def validate(doc: dict, edge_style: str) -> list[str]:
    problems = []
    g = doc["graph"]
    ids = {n["id"] for n in g["nodes"]}
    if len(ids) != len(g["nodes"]):
        problems.append("duplicate node ids")
    if g["rootNodeId"] not in ids:
        problems.append("rootNodeId not present in nodes[]")
    cids = [c["id"] for n in g["nodes"] for c in n["content"]]
    if len(set(cids)) != len(cids):
        problems.append("duplicate content ids")
    if edge_style == "objects":
        for e in g["edges"]:
            if e["source"] not in ids or e["target"] not in ids:
                problems.append("edge references unknown node id"); break
    else:
        for s, targets in g["edges"].items():
            if s not in ids or any(t not in ids for t in targets):
                problems.append("edge references unknown node id"); break
            if any("weight" not in a for a in targets.values()):
                problems.append("edge entry missing weight"); break
    for n in g["nodes"]:
        for c in n["content"]:
            if set(c) < {"id", "name", "weight", "type", "properties"}:
                problems.append("content item missing a required field"); break
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description="Migrate legacy knowledge.json to schema 1.0")
    ap.add_argument("input")
    ap.add_argument("-o", "--output", help="default: <input stem>.v1.json")
    ap.add_argument("--language", default=DEFAULT_LANGUAGE)
    ap.add_argument("--schema-version", default=SCHEMA_VERSION)
    ap.add_argument("--edge-style", choices=["dict", "objects"], default="dict",
                    help="dict (default): {sourceId: {targetId: {weight,relation?}}}. "
                         "objects: flat [{id,source,target,weight,relation}].")
    ap.add_argument("--random-ids", action="store_true",
                    help="uuid4 instead of deterministic uuid5 (ids then change every run)")
    ap.add_argument("--indent", type=int, default=2)
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as fh:
        src = json.load(fh)
    if "knowledgeTree" not in src and "graph" not in src:
        print("error: %s has no knowledgeTree/graph key" % args.input, file=sys.stderr)
        return 2

    out, stats = migrate(
        src,
        source_name=os.path.basename(args.input),
        language=args.language,
        schema_version=args.schema_version,
        edge_style=args.edge_style,
        random_ids=args.random_ids,
    )

    dest = args.output or (os.path.splitext(args.input)[0] + ".v1.json")
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=args.indent, ensure_ascii=False)

    problems = validate(out, args.edge_style)
    print("%s -> %s" % (args.input, dest))
    print("  nodes %d | content %d | edges %d | edge style %s"
          % (stats["nodes"], stats["content"], stats["edges"], args.edge_style))
    print("  root %r" % (stats["root"],))
    print("  space %r -> extensions.rendererSpecificProperties" % (stats["space"],))
    print("  nodes with position %d | with hints %d" % (stats["withPosition"], stats["withHints"]))
    if stats["typed"]:
        print("  typed/relation edges %d -> preserved" % stats["typed"])
    if stats["dangling"]:
        print("  ! %d connection(s) referenced unknown nodes and were skipped" % stats["dangling"])
    if stats.get("collisions"):
        print("  ! %d parallel edge(s) collapsed: same source->target pair seen twice"
              % stats["collisions"])
    print("  validation: %s" % ("OK" if not problems else "; ".join(problems)))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
