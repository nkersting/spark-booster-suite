import type { KnowledgeNode, Widget } from "@/types";
import { isSchemaDocument, schemaToLegacyDocument, toSchemaDocument } from "../../supabase/functions/_shared/knowledge-schema";

/**
 * Graph (DAG) representation of a knowledge tree.
 *
 * knowledge.json format:
 * {
 *   "seo": {...},
 *   "pageTitle": "Greece",
 *   "knowledgeTree": {
 *     "root": "history of greece",              // optional, defaults to first node
 *     "nodes": { "history of greece": { "name": "history of greece", ... }, ... },
 *     "connections": { "history of greece": ["geology", ...], "geology": [] }
 *   }
 * }
 *
 * Because `connections` is an adjacency list, two different nodes may list the
 * same child. The renderers de-duplicate by node name so a shared child is drawn
 * once with several incoming edges.
 */

export type GraphNodeAttrs = {
  name: string;
  weight?: number;
  icon?: string;
  prose?: string;
  widgets?: Widget[];
  [key: string]: any;
};

export type GraphSpace = "Default" | "Euclidean" | "Earth";

export type KnowledgeGraph = {
  root: string;
  space: GraphSpace;
  nodes: Record<string, GraphNodeAttrs>;
  connections: Record<string, string[]>;
};

export function isGraphFormat(value: any): boolean {
  return !!value && typeof value === "object" && !!value.nodes && !!value.connections;
}

function normalizeCollection<T extends Record<string, any>>(
  value: any,
  keyField: string,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry) continue;
      const key = entry[keyField] ?? entry.name ?? entry.node;
      if (typeof key === "string") out[key] = entry;
    }
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    out[key] = (entry ?? {}) as T;
  }
  return out;
}

/** Parse the `knowledgeTree` value (graph or legacy nested tree) into a graph. */
export function parseKnowledgeGraph(raw: any): KnowledgeGraph | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (!isGraphFormat(raw)) return treeToGraph(raw as KnowledgeNode);

  const nodes = normalizeCollection<GraphNodeAttrs>(raw.nodes, "name");
  const connectionsRaw = raw.connections;
  const connections: Record<string, string[]> = {};

  if (Array.isArray(connectionsRaw)) {
    for (const entry of connectionsRaw) {
      if (!entry) continue;
      const key = entry.name ?? entry.node;
      if (typeof key === "string") connections[key] = [...(entry.children ?? [])];
    }
  } else if (connectionsRaw && typeof connectionsRaw === "object") {
    for (const [key, children] of Object.entries(connectionsRaw)) {
      connections[key] = Array.isArray(children) ? (children as string[]).filter((c) => typeof c === "string") : [];
    }
  }

  // Make sure every referenced node exists and has attributes + an entry.
  for (const [key, children] of Object.entries(connections)) {
    if (!nodes[key]) nodes[key] = { name: key };
    for (const child of children) if (!nodes[child]) nodes[child] = { name: child };
  }
  for (const key of Object.keys(nodes)) {
    if (!nodes[key].name) nodes[key].name = key;
    if (!connections[key]) connections[key] = [];
  }

  const names = Object.keys(nodes);
  if (names.length === 0) return undefined;

  let root: string | undefined = typeof raw.root === "string" ? raw.root : undefined;
  if (!root || !nodes[root]) {
    const childSet = new Set<string>();
    for (const children of Object.values(connections)) children.forEach((c) => childSet.add(c));
    root = names.find((n) => !childSet.has(n)) ?? names[0];
  }

  const space: GraphSpace =
    raw.space === "Euclidean" || raw.space === "Earth" ? raw.space : "Default";

  return { root, space, nodes, connections };
}

/** Expand a graph into the nested tree the UI works with (shared children repeat). */
export function graphToTree(graph: KnowledgeGraph): KnowledgeNode {
  const build = (name: string, ancestors: Set<string>): KnowledgeNode => {
    const attrs = graph.nodes[name] ?? { name };
    const { name: _n, ...rest } = attrs;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(name);
    const children = (graph.connections[name] ?? [])
      // guard against cycles
      .filter((child) => !nextAncestors.has(child))
      .map((child) => build(child, nextAncestors));
    return { ...(rest as any), node: name, children } as KnowledgeNode;
  };
  const tree = build(graph.root, new Set());
  (tree as any).space = graph.space ?? "Default";
  return tree;
}

/** Collapse the nested tree back into the graph format (de-duplicated by name). */
export function treeToGraph(root: KnowledgeNode): KnowledgeGraph | undefined {
  if (!root || typeof root.node !== "string") return undefined;
  const nodes: Record<string, GraphNodeAttrs> = {};
  const connections: Record<string, string[]> = {};

  const visit = (n: KnowledgeNode) => {
    const { children, node, ...rest } = n as any;
    const name = node as string;
    nodes[name] = { ...(nodes[name] ?? {}), ...(rest as any), name };
    const existing = connections[name] ?? (connections[name] = []);
    for (const child of children ?? []) {
      if (!child || typeof child.node !== "string") continue;
      if (!existing.includes(child.node)) existing.push(child.node);
      visit(child);
    }
  };

  visit(root);
  const rootAttrs = nodes[root.node] as any;
  const space: GraphSpace =
    rootAttrs?.space === "Euclidean" || rootAttrs?.space === "Earth" ? rootAttrs.space : "Default";
  if (rootAttrs) delete rootAttrs.space;
  return { root: root.node, space, nodes, connections };
}

/** Serialize a knowledge.json document, always writing the graph format. */
export function serializeKnowledgeData(data: any): string {
  if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
  const tree = data.knowledgeTree;
  if (!tree) return JSON.stringify(toSchemaDocument(data), null, 2);
  const graph = isGraphFormat(tree) ? parseKnowledgeGraph(tree) : treeToGraph(tree as KnowledgeNode);
  if (!graph) return JSON.stringify(data, null, 2);
  return JSON.stringify(toSchemaDocument({ ...data, knowledgeTree: graph }), null, 2);
}

/** Normalize a loaded knowledge.json document so `knowledgeTree` is a nested tree. */
export function normalizeKnowledgeData<T extends Record<string, any>>(data: T): T {
  if (isSchemaDocument(data) && !(data as any).knowledgeTree) {
    return normalizeKnowledgeData(schemaToLegacyDocument(data)) as T;
  }
  if (!data || typeof data !== "object" || !isGraphFormat((data as any).knowledgeTree)) return data;
  const graph = parseKnowledgeGraph((data as any).knowledgeTree);
  if (!graph) return data;
  return { ...(data as any), knowledgeTree: graphToTree(graph) };
}

/** Fix up a nested node whose label lives under name/label/title instead of `node`. */
function fixNestedNode(n: any): KnowledgeNode | undefined {
  if (!n || typeof n !== "object") return undefined;
  const label = n.node ?? n.name ?? n.label ?? n.title;
  if (typeof label !== "string" || !label.trim()) return undefined;
  const { name: _a, label: _b, title: _c, ...rest } = n;
  const children = (Array.isArray(n.children) ? n.children : [])
    .map(fixNestedNode)
    .filter(Boolean) as KnowledgeNode[];
  return {
    ...rest,
    node: label,
    widgets: Array.isArray(n.widgets) ? n.widgets : [],
    children,
  } as KnowledgeNode;
}

/**
 * Normalize a freshly generated document (from the Generate button) into the
 * nested-tree shape the UI uses, whatever shape the generator returned.
 */
export function coerceGeneratedDocument(data: any): any {
  if (!data) return data;
  let doc = data;
  if (typeof doc === "string") {
    try { doc = JSON.parse(doc); } catch { return data; }
  }
  // Some responses nest the document one level deeper.
  if (!doc.knowledgeTree && (doc.result?.knowledgeTree || isSchemaDocument(doc.result))) doc = doc.result;
  if (isSchemaDocument(doc) && !doc.knowledgeTree) return normalizeKnowledgeData(doc);
  let tree = doc.knowledgeTree;
  if (!tree) return doc;
  if (isGraphFormat(tree)) {
    const graph = parseKnowledgeGraph(tree);
    return graph ? { ...doc, knowledgeTree: graphToTree(graph) } : doc;
  }
  if (Array.isArray(tree)) tree = tree.length === 1 ? tree[0] : { node: doc.pageTitle || "root", children: tree };
  const fixed = fixNestedNode(tree);
  return fixed ? { ...doc, knowledgeTree: fixed } : doc;
}

/** Empty document used when creating a new knowledge.json (graph format). */
export function emptyKnowledgeDocument() {
  return toSchemaDocument({
    seo: { title: "", description: "", prose: "" },
    pageTitle: "",
    pageDescription: "",
    knowledgeTree: {
      root: "root",
      space: "Default",
      nodes: { root: { name: "root", weight: 100, prose: "" } },
      connections: { root: [] as string[] },
    },
  });
}

/**
 * Parse a knowledge.json file. Only the nodes/connections graph format is
 * supported — legacy nested trees are rejected.
 */
export function parseKnowledgeFile<T extends Record<string, any>>(data: T): T {
  if ((data as any)?.schemaVersion !== undefined) {
    return normalizeKnowledgeData(schemaToLegacyDocument(data)) as T;
  }
  if (!data || typeof data !== "object" || !isGraphFormat((data as any).knowledgeTree)) {
    throw new Error(
      'knowledge.json must use the graph format: "knowledgeTree": { "nodes": {...}, "connections": {...} }',
    );
  }
  const graph = parseKnowledgeGraph((data as any).knowledgeTree);
  if (!graph) throw new Error("knowledge.json contains an empty knowledgeTree graph");
  return { ...(data as any), knowledgeTree: graphToTree(graph) };
}

/**
 * Keep only nodes whose name contains `term`, plus their direct children and
 * the path of ancestors that connects them to the root.
 */
export function filterTreeByText(root: KnowledgeNode, term: string): KnowledgeNode {
  const q = term.trim().toLowerCase();
  if (!q || !root) return root;
  const visit = (n: KnowledgeNode, parentMatched: boolean): KnowledgeNode | null => {
    const matched = typeof n.node === "string" && n.node.toLowerCase().includes(q);
    const kids = (n.children ?? [])
      .map((c) => visit(c, matched))
      .filter(Boolean) as KnowledgeNode[];
    if (matched || parentMatched || kids.length) return { ...n, children: kids };
    return null;
  };
  return visit(root, false) ?? { ...root, children: [] };
}
