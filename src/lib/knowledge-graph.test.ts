import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { coerceGeneratedDocument, emptyKnowledgeDocument, parseKnowledgeFile, serializeKnowledgeData } from './knowledge-graph';
import { schemaToLegacyDocument, toSchemaDocument } from '../../supabase/functions/_shared/knowledge-schema';

const legacy = {
  seo: { title: 'Test', description: 'Description', prose: 'Intro', custom: 'value' },
  pageTitle: 'Page', pageDescription: 'Page description',
  knowledgeTree: {
    root: 'A', space: 'Euclidean', customSetting: 42,
    nodes: {
      A: { name: 'A', weight: 100, prose: 'Node A', position: [1, 2, 3], customHint: true,
        widgets: [{ name: 'image.png', title: 'Slide', subtitle: 'Subtitle', prose: 'Prose', notes: 'Notes', url: 'https://example.org', custom: 7 }] },
      B: { name: 'B', weight: 50, widgets: [] },
      C: { name: 'C', weight: 25, widgets: [] },
    },
    connections: { A: ['B', 'C'], B: ['C'], C: [] },
    edges: [{ from: 'B', to: 'C', weight: 3, relation: 'succeeds', note: 'Shared child' }],
  },
};

describe('migrate_schema.py schema 1.0 standard', () => {
  test('writes document, graph, extensions and UUID node IDs', () => {
    const doc = toSchemaDocument(legacy);
    expect(Object.keys(doc).sort()).toEqual(['document', 'extensions', 'graph', 'schemaVersion']);
    expect(doc.schemaVersion).toBe('1.0');
    expect(doc.document.language).toBe('en-us');
    expect(doc.graph.nodes[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.graph.rootNodeId).toBe(doc.graph.nodes[0].id);
  });
  test('maps widgets into content and properties exactly as the conversion script', () => {
    const item = toSchemaDocument(legacy).graph.nodes[0].content[0];
    expect(item.name).toBe('Slide');
    expect(item.weight).toBe(1);
    expect(item.type).toBe('');
    expect(item.properties).toEqual({ icon: 'image.png', title: 'Slide — Subtitle', notes: 'Prose\n\nNotes', source_url: 'https://example.org', extra: { custom: 7 } });
  });
  test('preserves positions, hints and renderer settings', () => {
    const doc = toSchemaDocument(legacy);
    expect(doc.graph.nodes[0].position).toEqual([1, 2, 3]);
    expect(doc.graph.nodes[0].hints).toEqual({ customHint: true });
    expect(doc.extensions.rendererSpecificProperties).toEqual({ space: 'Euclidean', customSetting: 42 });
  });
  test('uses ID adjacency maps with typed edge attributes and shared children', () => {
    const doc = toSchemaDocument(legacy);
    const [a, b, c] = doc.graph.nodes;
    expect(doc.graph.edges[a.id][c.id]).toEqual({ weight: 1 });
    expect(doc.graph.edges[b.id][c.id]).toEqual({ weight: 3, relation: 'succeeds', note: 'Shared child' });
    const loaded = parseKnowledgeFile(doc);
    expect(loaded.knowledgeTree.children[0].children[0].node).toBe('C');
    expect(loaded.knowledgeTree.children[1].node).toBe('C');
  });
  test('load/edit/save keeps document, node/content IDs and edge metadata', () => {
    const original = toSchemaDocument(legacy);
    const loaded = parseKnowledgeFile(original);
    loaded.knowledgeTree.prose = 'Edited';
    const saved = JSON.parse(serializeKnowledgeData(loaded));
    expect(saved.document).toEqual(original.document);
    expect(saved.graph.nodes.map((n: any) => n.id)).toEqual(original.graph.nodes.map((n: any) => n.id));
    expect(saved.graph.nodes[0].content).toEqual(original.graph.nodes[0].content);
    expect(saved.graph.nodes[0].description).toBe('Edited');
    expect(saved.graph.edges).toEqual(original.graph.edges);
  });
  test('generation and new documents use the standard', () => {
    const empty = emptyKnowledgeDocument();
    expect(empty.schemaVersion).toBe('1.0');
    expect(parseKnowledgeFile(empty).knowledgeTree.node).toBe('root');
    const generated = coerceGeneratedDocument(JSON.stringify(toSchemaDocument(legacy)));
    expect(generated.knowledgeTree.node).toBe('A');
    expect(JSON.parse(serializeKnowledgeData(generated)).schemaVersion).toBe('1.0');
  });
  test('rejects unknown node references', () => {
    const doc = toSchemaDocument(legacy);
    doc.graph.edges[doc.graph.rootNodeId].missing = { weight: 1 };
    expect(() => schemaToLegacyDocument(doc)).toThrow('unknown node ID');
  });
  test('converted sample loads with matching root and content', () => {
    const doc = JSON.parse(readFileSync('public/data/knowledge.json', 'utf8'));
    expect(doc.schemaVersion).toBe('1.0');
    const root = doc.graph.nodes.find((n: any) => n.id === doc.graph.rootNodeId);
    const loaded = parseKnowledgeFile(doc);
    expect(loaded.knowledgeTree.node).toBe(root.name);
    expect(loaded.knowledgeTree.widgets.length).toBe(root.content.length);
  });
});