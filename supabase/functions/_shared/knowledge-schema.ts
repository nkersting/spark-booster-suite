/** Schema 1.0 boundary matching migrate_schema.py's default adjacency-map output.
 * Pure module shared by the browser and generation worker. */
type RecordValue = Record<string, any>;
const uuid = () => crypto.randomUUID();
const join = (parts: any[], separator: string) => [...new Set(parts.filter(p => p != null).map(p => String(p).trim()).filter(Boolean))].join(separator);
const leftovers = (value: RecordValue, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const nodeKeys = ['node', 'name', 'title', 'weight', 'icon', 'prose', 'description', 'position', 'widgets', 'content', 'hints', '__schemaNode'];
const widgetKeys = ['title', 'subtitle', 'name', 'icon', 'prose', 'notes', 'url', 'source', 'source_url', 'weight', 'type', 'id', '__schemaContent'];

export function isSchemaDocument(data: any): boolean {
  return data?.schemaVersion === '1.0' && !!data.document && Array.isArray(data.graph?.nodes);
}

export function schemaToLegacyDocument(data: RecordValue): RecordValue {
  if (!isSchemaDocument(data)) throw new Error('Unsupported knowledge.json schema; expected schemaVersion 1.0');
  const { graph, document } = data;
  const byId = new Map<string, any>();
  const names = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || byId.has(node.id)) throw new Error('Knowledge graph has missing or duplicate node IDs');
    if (!node.name || names.has(node.name)) throw new Error('Knowledge graph requires unique non-empty node names');
    byId.set(node.id, node);
    names.add(node.name);
  }
  if (!byId.has(graph.rootNodeId)) throw new Error('rootNodeId is not present in graph.nodes');
  const nodes: RecordValue = {};
  const connections: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    nodes[node.name] = {
      ...node.hints, name: node.name, weight: node.weight, prose: node.description,
      icon: node.icon, position: node.position, __schemaNode: node,
      widgets: (node.content ?? []).map((content: any) => ({
        ...content.properties?.extra, id: content.id, name: content.properties?.icon ?? '',
        title: content.properties?.title ?? content.name, notes: content.properties?.notes ?? '',
        url: content.properties?.source_url ?? '', weight: content.weight, type: content.type,
        __schemaContent: content,
      })),
    };
    connections[node.name] = [];
  }
  const add = (source: string, target: string) => {
    const s = byId.get(source), t = byId.get(target);
    if (!s || !t) throw new Error('Knowledge graph edge references an unknown node ID');
    if (!connections[s.name].includes(t.name)) connections[s.name].push(t.name);
  };
  if (Array.isArray(graph.edges)) {
    for (const edge of graph.edges) add(edge.source, edge.target);
  } else {
    for (const [source, targets] of Object.entries(graph.edges ?? {})) {
      for (const target of Object.keys(targets as RecordValue)) add(source, target);
    }
  }
  return {
    ...data,
    seo: { title: document.title, description: document.description, prose: document.meta?.seoProse ?? '',
      ...Object.fromEntries(Object.entries(document.meta ?? {}).filter(([k]) => k.startsWith('seo_')).map(([k, v]) => [k.slice(4), v])) },
    pageTitle: document.meta?.pagetitle ?? document.title,
    pageDescription: document.meta?.pageDescription ?? document.description,
    knowledgeTree: { ...data.extensions?.rendererSpecificProperties, root: byId.get(graph.rootNodeId).name, nodes, connections },
  };
}

/** Accept the internal/legacy adjacency graph; emit only standard schema fields. */
export function toSchemaDocument(data: RecordValue): RecordValue {
  if (isSchemaDocument(data) && !data.knowledgeTree) return data;
  const legacy = data.knowledgeTree;
  if (!legacy?.nodes || !legacy.connections) throw new Error('Cannot serialize an empty knowledge graph');
  const oldNodes = new Map<string, any>((data.graph?.nodes ?? []).map((n: any) => [n.name, n]));
  const ids = new Map<string, string>();
  const nodes = Object.entries(legacy.nodes).map(([key, raw]) => {
    const node = raw as RecordValue;
    const original = node.__schemaNode ?? oldNodes.get(key);
    const id = original?.id ?? uuid();
    ids.set(key, id);
    const hints = { ...original?.hints, ...leftovers(node, nodeKeys), ...node.hints };
    const content = (node.widgets ?? node.content ?? []).map((w: RecordValue) => {
      const old = w.__schemaContent;
      const extra = { ...old?.properties?.extra, ...leftovers(w, widgetKeys) };
      return {
        ...old, id: w.id || old?.id || uuid(), name: old?.name ?? w.title ?? '',
        weight: w.weight ?? 1, type: w.type ?? '',
        properties: { ...old?.properties,
          icon: w.icon || w.name || '', title: join([w.title, w.subtitle], ' — '),
          notes: join([w.prose, w.notes], '\n\n'), source_url: w.source_url || w.url || w.source || '',
          ...(Object.keys(extra).length ? { extra } : {}),
        },
      };
    });
    return {
      ...original, id, name: key, title: original?.title ?? key, weight: node.weight ?? 1,
      description: node.prose || node.description || '', content,
      ...(node.icon ? { icon: node.icon } : { icon: undefined }),
      ...(node.position != null ? { position: node.position } : { position: undefined }),
      ...(Object.keys(hints).length ? { hints } : {}),
    };
  });
  const edges: RecordValue = {};
  for (const [source, targets] of Object.entries(legacy.connections)) {
    const sourceId = ids.get(source);
    if (!sourceId) continue;
    for (const target of targets as string[]) {
      const targetId = ids.get(target);
      if (!targetId) continue;
      const oldEdges = data.graph?.edges;
      const old = Array.isArray(oldEdges) ? oldEdges.find((e: any) => e.source === sourceId && e.target === targetId) : oldEdges?.[sourceId]?.[targetId];
      const typed = legacy.edges?.find((e: any) => (e.from ?? e.source) === source && (e.to ?? e.target) === target);
      const attributes = old ? leftovers(old, ['id', 'source', 'target']) : {
        weight: typed?.weight ?? 1,
        ...(typed?.relation || typed?.type ? { relation: typed.relation || typed.type } : {}),
        ...(typed?.note ? { note: typed.note } : {}),
      };
      (edges[sourceId] ??= {})[targetId] = { weight: 1, ...attributes };
    }
  }
  const seo = data.seo ?? {};
  const meta = { ...data.document?.meta, pagetitle: data.pageTitle ?? '',
    ...(seo.prose ? { seoProse: seo.prose } : {}),
    ...(data.pageDescription ? { pageDescription: data.pageDescription } : {}),
    ...Object.fromEntries(Object.entries(seo).filter(([k]) => !['title', 'description', 'prose'].includes(k)).map(([k, v]) => [`seo_${k}`, v])),
  };
  return {
    schemaVersion: '1.0',
    document: { ...data.document, id: data.document?.id ?? uuid(), title: seo.title || data.pageTitle || 'knowledge.json',
      description: seo.description || data.pageDescription || '', language: data.document?.language ?? 'en-us', meta },
    graph: { ...data.graph, rootNodeId: ids.get(legacy.root), nodes, edges },
    extensions: { ...data.extensions, rendererSpecificProperties: {
      ...data.extensions?.rendererSpecificProperties, ...leftovers(legacy, ['root', 'rootNodeId', 'nodes', 'connections', 'edges']),
    } },
  };
}