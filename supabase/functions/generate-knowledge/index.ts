import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toSchemaDocument } from "../_shared/knowledge-schema.ts";
import { readClaudeStream } from "./claude-stream.ts";
import { resolveGenerationKeys } from "../_shared/generation-keys.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Default values - can be overridden by request
const DEFAULT_MAX_TOKENS = 20000;
const DEFAULT_MIN_NODES = 30;
const DEFAULT_MAX_NODES = 60;
const PEXELS_API_URL = "https://api.pexels.com/v1/search";

// Reference JSON structure to guide generation
const REFERENCE_STRUCTURE = {
  seo: {
    title: "Example Topic: Key Concepts",
    description: "An exploration of the topic",
    prose: "Introduction prose..."
  },
  pageTitle: "Example Topic",
  pageDescription: "A comprehensive exploration",
  knowledgeTree: {
    node: "Root Node",
    weight: 100,
    prose: "Root explanation...",
    widgets: [
      {
        name: "ppt_media_image2.png",
        title: "Widget Title",
        subtitle: "Subtitle",
        notes: "⦿ Point 1\n\n⦿ Point 2",
        prose: "Widget explanation..."
      }
    ],
    children: []
  }
};

/** Collapse a nested tree into the { root, nodes, connections } graph format. */
function treeToGraph(root: any) {
  if (root && root.nodes && root.connections) return root; // already a graph
  const fix = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    const node = n.node ?? n.name ?? n.label ?? n.title;
    const { name: _a, label: _b, title: _c, ...rest } = n;
    return { ...rest, node, children: (Array.isArray(n.children) ? n.children : []).map(fix) };
  };
  root = fix(root);
  if (!root || typeof root.node !== 'string') return root;
  const nodes: Record<string, any> = {};
  const connections: Record<string, string[]> = {};
  const visit = (n: any) => {
    const { children, node, ...rest } = n;
    nodes[node] = { ...(nodes[node] ?? {}), ...rest, name: node };
    const list = connections[node] ?? (connections[node] = []);
    for (const c of children ?? []) {
      if (!c || typeof c.node !== 'string') continue;
      if (!list.includes(c.node)) list.push(c.node);
      visit(c);
    }
  };
  visit(root);
  return { root: root.node, space: "Default", nodes, connections };
}

// ---- Streaming job log (flushed to the job row so the client can show it) ----
let jobLogLines: string[] = [];
let jobLogFlush: (() => Promise<void>) | null = null;
let jobStartMs = Date.now();
function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function jlog(msg: string) {
  const line = `${mmss(Date.now() - jobStartMs)}  ${msg}`;
  console.log(msg);
  jobLogLines.push(line);
  if (jobLogLines.length > 500) jobLogLines = jobLogLines.slice(-500);
}

// Each worker gets a limited wall-clock budget; hand off to a fresh worker before it's killed.
const WORKER_BUDGET_MS = 90_000;
const MAX_PARTS = 8;
class HandOff extends Error {
  constructor(public partial: string) { super('handoff'); }
}

async function searchPexelsImage(query: string, pexelsKey: string): Promise<string | null> {
  if (!query || !pexelsKey) return null;

  jlog(`Searching images: "${query.slice(0, 60)}"`);
  try {
    const params = new URLSearchParams({
      query: query,
      per_page: "3",
    });

    const response = await fetch(`${PEXELS_API_URL}?${params}`, {
      headers: {
        'Authorization': pexelsKey,
      }
    });
    if (!response.ok) {
      console.error(`Pexels HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data?.photos?.length > 0) {
      jlog(`  found image ${data.photos[0].src.large}`);
      return data.photos[0].src.large;
    }
    return null;
  } catch (error) {
    console.error(`Pexels error: ${error}`);
    return null;
  }
}

// Collect all image placeholders from the tree (widgets + node icon)
function collectImagePlaceholders(node: any): { path: string[]; query: string }[] {
  const results: { path: string[]; query: string }[] = [];

  // Always populate node.icon from prose if not already an image URL
  const existingIcon = node.icon || '';
  if (!/^https?:\/\//i.test(existingIcon) && !/^ppt_/i.test(existingIcon)) {
    const iconQuery = node.prose
      ? (node.prose as string).substring(0, 120).replace(/[^a-zA-Z0-9 ]/g, ' ').trim()
      : (node.node || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    if (iconQuery.length > 3) {
      results.push({ path: ['icon'], query: iconQuery });
    }
  }
  
  if (node.widgets && Array.isArray(node.widgets)) {
    let nodeHasImage = false;
    node.widgets.forEach((widget: any, idx: number) => {
      const widgetName = widget.name || '';
      if (/^ppt_/i.test(widgetName)) {
        nodeHasImage = true;
        return;
      }
      if (/^https?:\/\//i.test(widgetName)) {
        nodeHasImage = true;
        return;
      }
      if (widgetName.toLowerCase().match(/\.(png|jpg|jpeg|gif)$/)) {
        const baseName = widgetName
          .replace(/^.*[\\\/]/, '')
          .replace(/\.[^.]+$/, '')
          .replace(/[_-]/g, ' ');
        results.push({ path: ['widgets', String(idx), 'name'], query: baseName });
        nodeHasImage = true;
      }
    });

    // Always use the node's prose to find a web image for a widget that lacks one
    if (node.prose) {
      const proseQuery = (node.prose as string).substring(0, 120).replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
      if (proseQuery.length > 5) {
        const targetIdx = node.widgets.findIndex((w: any) => {
          const n = w.name || '';
          return !n || (!n.match(/\.(png|jpg|jpeg|gif)$/i) && !/^https?:\/\//i.test(n) && !/youtube\.com|youtu\.be/i.test(n) && !/^ppt_/i.test(n));
        });
        if (targetIdx >= 0) {
          results.push({ path: ['widgets', String(targetIdx), 'name'], query: proseQuery });
        }
      }
    }
  }
  
  if (node.children && Array.isArray(node.children)) {
    node.children.forEach((child: any, idx: number) => {
      const childResults = collectImagePlaceholders(child);
      childResults.forEach(r => {
        results.push({ path: ['children', String(idx), ...r.path], query: r.query });
      });
    });
  }
  
  return results;
}

// Assign node weights based on depth using exponential decay: 100 -> 50 -> 25 -> 12 -> 6 -> 3 -> 2 -> 1
function assignWeightsByDepth(node: any, depth = 0) {
  node.weight = Math.max(1, Math.round(100 / Math.pow(2, depth)));
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      assignWeightsByDepth(child, depth + 1);
    }
  }
}

// Set a value at a path in an object
function setAtPath(obj: any, path: string[], value: any) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]];
  }
  current[path[path.length - 1]] = value;
}

async function processAllMedia(tree: any, pexelsKey: string): Promise<any> {
  const placeholders = collectImagePlaceholders(tree);
  jlog(`Found ${placeholders.length} images to look up`);
  
  // Process in batches of 5 to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < placeholders.length; i += BATCH_SIZE) {
    const batch = placeholders.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (p) => {
        const url = await searchPexelsImage(p.query, pexelsKey);
        return { path: p.path, url };
      })
    );
    
    for (const r of results) {
      if (r.url) {
        setAtPath(tree, r.path, r.url);
      }
    }
  }
  
  console.log('Media processing complete');
  return tree;
}

// ============================================================
// Widget URL validation
// LLMs frequently hallucinate plausible-looking URLs. Before
// returning the tree we HEAD-check each widget.url and strip
// any that don't resolve to a 2xx/3xx so the "Source" button
// never points to a dead link.
// ============================================================
function collectWidgetUrls(node: any, out: { widget: any }[] = []): { widget: any }[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node.widgets)) {
    for (const w of node.widgets) {
      if (w && typeof w.url === 'string' && /^https?:\/\//i.test(w.url)) {
        out.push({ widget: w });
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectWidgetUrls(c, out);
  }
  return out;
}

async function checkUrl(url: string, timeoutMs = 6000): Promise<boolean> {
  const attempt = async (method: 'HEAD' | 'GET') => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DynamicTreeBot/1.0)' },
      });
      // Treat 2xx/3xx as valid. Many sites reject HEAD with 405/403.
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  if (await attempt('HEAD')) return true;
  return attempt('GET');
}

async function validateWidgetUrls(tree: any): Promise<{ checked: number; removed: number }> {
  const entries = collectWidgetUrls(tree);
  let removed = 0;
  const CONCURRENCY = 8;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    batch.forEach(e => jlog(`Checking URL ${e.widget.url}`));
    const results = await Promise.all(batch.map(e => checkUrl(e.widget.url)));
    results.forEach((ok, idx) => {
      if (!ok) {
        jlog(`  broken, removing ${batch[idx].widget.url}`);
        delete batch[idx].widget.url;
        removed++;
      }
    });
  }
  return { checked: entries.length, removed };
}

async function generateKnowledgeJson(
  topic: string,
  anthropicKey: string,
  sourceText: string,
  sourceOnly: boolean,
  maxTokens: number,
  minNodes: number,
  maxNodes: number,
  contextNodes?: any[],
  partial = '',
  deadline = Infinity,
): Promise<any> {
  console.log(`Generating knowledge tree for topic: ${topic}, contextNodes: ${contextNodes?.length ?? 0}`);
  
  const contextSection = contextNodes && contextNodes.length > 0
    ? `\n\nIMPORTANT: The user has selected the following existing nodes as context. Generate up to 5 NEW child nodes that branch off from these selected nodes. Each new node should expand on or relate to the selected nodes. Here are the selected nodes:\n\`\`\`json\n${JSON.stringify(contextNodes, null, 2)}\n\`\`\`\n\nGenerate a partial JSON tree where each selected node appears with its new children appended. Only output the knowledgeTree portion (no seo/page fields). The new nodes should have the same structure (node, weight, prose, widgets, children).`
    : '';

  const prompt = contextNodes && contextNodes.length > 0
    ? `Given an existing knowledge tree about "${topic}", generate additional nodes branching from specific selected nodes.

Reference JSON Structure (use this as a template for new nodes):
\`\`\`json
${JSON.stringify(REFERENCE_STRUCTURE.knowledgeTree, null, 2)}
\`\`\`
${contextSection}

Guidelines for new nodes:
1. Generate up to 5 new nodes total, distributed as children of the selected nodes.
2. Each node has a 'weight' between 1 and 100 for relative importance.
3. Each node should have 1-4 widgets with title, subtitle, notes, prose, and (optionally) url fields.
   For "url": ONLY include a URL if you are highly confident it is a real, canonical, stable page
   you have actually seen (e.g. Wikipedia article, official docs page, well-known paper on arxiv.org,
   major news outlet article, official project homepage). Do NOT guess, do NOT construct plausible-looking
   URLs, do NOT invent slugs or IDs. If you are not sure the exact URL exists, omit the "url" field entirely.
   Prefer stable roots (e.g. https://en.wikipedia.org/wiki/<Exact_Title>) over deep links.
4. The "prose" field is what you'd say to explain it in a live talk.
5. Widget names should be descriptive placeholders like "topic_image.png".
${sourceText ? `6. Use this source material: ${sourceText.substring(0, 15000)}` : ''}

Return ONLY valid JSON as an array of objects, each with: { "parentNode": "<name of selected node>", "newChildren": [<array of new child node objects>] }. No explanations or markdown code blocks.`
    : `Based on the following reference JSON structure and content style, create a similar JSON file for the topic: "${topic}"

Reference JSON Structure (use this as a template):
\`\`\`json
${JSON.stringify(REFERENCE_STRUCTURE, null, 2)}
\`\`\`

Please generate a JSON file with:
1. Similar structure and field types as the reference. In particular, a tree-structure growing from a single root node with branches of various depths.
    a. Each node has a 'weight' between 1 and 100 that speaks to its relative importance, e.g. major nodes typically have 100>weight>50, while minor caveats are 20 or less.
    b. Each node will also have some 'widgets' (between 1 and 8) that give more detail on the node; the widget 'name' field should reference an image filename when one is available, or be a descriptive placeholder like "topic_image.png".
    c. Do NOT use a 'preview' field for images — all image filenames go in the 'name' field only.
    e. Widgets also have a title, subtitle, and notes fields which you should fill with whatever details are relevant and informative (max 200 chars there).
    f. The "prose" field exists on each node and widget and would be what you would typically say to explain it in a real live talk.
    g. Optionally insert a "url" field for each widget pointing to a real source for the prose.
       ONLY include a URL if you are highly confident it exists as a real, canonical, stable page you have
       actually seen (Wikipedia articles, official docs, arxiv.org papers, major news outlets, official
       project sites). Do NOT guess, invent slugs/IDs, or construct plausible-looking URLs. If unsure,
       OMIT the "url" field entirely — a missing url is much better than a broken one.
2. Content relevant to the topic: "${topic}"${sourceText ? `, with source reference material taken from the following text: ${sourceText.substring(0, 15000)}` : ''}. ${sourceOnly ? 'Only use information from the source text provided.' : 'Use your knowledge to create comprehensive content.'}
3. IMPORTANT: If the source text lists "Available Images" with filenames, use those exact filenames as widget 'name' values (NOT as 'preview', and NOT as node 'icon'). Distribute the images across the tree's widgets so each image is used at least once. Match images to widgets based on the slide context they came from.
4. Similar depth and detail level as the reference, i.e. between ${minNodes} and ${maxNodes} nodes with a good variety of widgets.
5. Properly formatted valid JSON

Return ONLY the JSON content, no explanations or markdown code blocks.`;

  if (partial) {
    jlog(`Continuing Claude's answer (${partial.length} chars so far)...`);
  } else {
    jlog(`Asking Claude to write ${minNodes}-${maxNodes} nodes about "${topic}"${sourceText ? ` (with ${Math.min(sourceText.length, 15000)} chars of source)` : ''}...`);
  }
  // Prefill must not end with whitespace
  const prefill = partial.replace(/\s+$/, '');
  const messages: any[] = [{ role: 'user', content: prompt }];
  if (prefill) messages.push({ role: 'assistant', content: prefill });
  const remainingTokens = Math.max(1000, maxTokens - Math.floor(prefill.length / 4));

  const ctrl = new AbortController();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: remainingTokens,
      stream: true,
      messages,
    }),
    signal: ctrl.signal,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    console.error(`Anthropic API error: ${response.status} - ${errorText}`);
    if (response.status === 401 || response.status === 403) {
      throw new Error('Anthropic rejected the API key. Paste a valid key in Settings (gear icon) and try again.');
    }
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  let lastLog = Date.now();
  const { text, stopReason, checkpoint } = await readClaudeStream(response.body, prefill, deadline, text => {
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      jlog(`  Claude is writing... ${text.length} chars received`);
    }
  });
  if (checkpoint) {
    ctrl.abort();
    if (text.length <= prefill.length) throw new Error('Claude stopped responding before producing more content');
    throw new HandOff(text);
  }

  jlog(`Claude finished (${text.length} chars${stopReason ? `, ${stopReason}` : ''}), parsing JSON...`);
  return extractJSON(text);
}

function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^\s*```json\s*/i, '')
    .replace(/^\s*```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Slice from first { or [ to matching last } or ]
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');
    const isArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const start = isArray ? arrStart : objStart;
    const end = isArray ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  } else {
    const end = cleaned.startsWith('[') ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
    if (end > 0) cleaned = cleaned.slice(0, end + 1);
  }

  const attempts = [
    (s: string) => s,
    (s: string) => s
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''),
    (s: string) => repairTruncatedJSON(s),
    (s: string) => repairTruncatedJSON(
      s.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    ),
  ];

  let lastErr: unknown;
  for (const fn of attempts) {
    try {
      return JSON.parse(fn(cleaned));
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('JSON parse failed. Head:', cleaned.slice(0, 300));
  console.error('Tail:', cleaned.slice(-300));
  console.error('Last error:', (lastErr as Error)?.message);
  throw new Error('Generated content is not valid JSON');
}

// Best-effort repair: walk the string honoring strings/escapes, truncate at the
// last complete top-level value, and close any still-open arrays/objects.
function repairTruncatedJSON(input: string): string {
  const s = input;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafe = -1; // index of last char that leaves us at a valid boundary

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      lastSafe = i;
      continue;
    }
    if (c === ',' && stack.length > 0) {
      lastSafe = i - 1; // safe to cut just before a comma
    }
  }

  let out = s;
  if (inString) {
    // Truncated mid-string: drop everything from the opening quote onward,
    // then trim any dangling comma/colon.
    const lastQuote = out.lastIndexOf('"', lastSafe >= 0 ? lastSafe : out.length);
    if (lastQuote > 0) out = out.slice(0, lastQuote).replace(/[\s,:]+$/, '');
  } else if (lastSafe >= 0 && lastSafe < out.length - 1) {
    out = out.slice(0, lastSafe + 1);
  }

  // Recompute open containers on the trimmed string and close them.
  const stack2: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack2.push(c);
    else if (c === '}' || c === ']') stack2.pop();
  }
  out = out.replace(/[\s,]+$/, '');
  while (stack2.length) {
    const open = stack2.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

// Background task that runs the actual generation
async function runGenerationJob(jobId: string, userKey?: string, userPexelsKey?: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  const { anthropicKey, pexelsKey } = resolveGenerationKeys(
    { anthropicKey: userKey, pexelsKey: userPexelsKey },
    { anthropicKey: Deno.env.get('ANTHROPIC_API_KEY'), pexelsKey: Deno.env.get('PEXELS_API_KEY') },
  );
  
  if (!anthropicKey) {
    await supabase.from('knowledge_generation_jobs').update({
      status: 'failed',
      error: 'No Anthropic API key: add one in Settings'
    }).eq('id', jobId);
    return;
  }
  
  const workerStart = Date.now();
  // Fetch job details first so a continuing worker keeps earlier log lines
  const { data: job, error: fetchError } = await supabase
    .from('knowledge_generation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (fetchError || !job) {
    console.error('Failed to fetch job:', fetchError);
    return;
  }
  const prevResult = (job.result as any) ?? {};
  const part: number = prevResult.part ?? 1;
  jobStartMs = new Date(job.created_at).getTime();
  jobLogLines = Array.isArray((job as any).logs) ? [...(job as any).logs] : [];
  let lastFlushed = jobLogLines.length;
  jobLogFlush = async () => {
    if (jobLogLines.length === lastFlushed) return;
    lastFlushed = jobLogLines.length;
    await supabase.from('knowledge_generation_jobs').update({ logs: jobLogLines } as any).eq('id', jobId);
  };
  const flushTimer = setInterval(() => { jobLogFlush?.().catch(() => {}); }, 1500);
  try {
    jlog(part === 1 ? 'Job started' : `Worker ${part} picked up the job`);
    await supabase.from('knowledge_generation_jobs').update({
      status: 'processing'
    }).eq('id', jobId);

    console.log(`Processing job ${jobId} (part ${part}) for topic: ${job.topic}`);

    // Generate the knowledge tree
    const contextNodes = prevResult.contextNodes;
    let generatedJson: any;
    try {
      generatedJson = await generateKnowledgeJson(
        job.topic,
        anthropicKey,
        job.source_text || '',
        job.source_only,
        job.max_tokens,
        job.min_nodes,
        job.max_nodes,
        contextNodes,
        prevResult.partial || '',
        workerStart + WORKER_BUDGET_MS,
      );
    } catch (e) {
      if (!(e instanceof HandOff)) throw e;
      if (part >= MAX_PARTS) throw new Error('Generation took too long; try fewer nodes');
      jlog(`Time limit for this worker reached; handing off to worker ${part + 1}...`);
      clearInterval(flushTimer);
      await jobLogFlush();
      const resumeToken = crypto.randomUUID();
      const { error: checkpointError } = await supabase.from('knowledge_generation_jobs').update({
        result: { ...prevResult, partial: e.partial, part: part + 1, resumeToken },
      }).eq('id', jobId);
      if (checkpointError) throw new Error(`Could not checkpoint generation: ${checkpointError.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const continuation = await fetch(`${supabaseUrl}/functions/v1/generate-knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}` },
        body: JSON.stringify({ continueJobId: jobId, resumeToken, ...resolveGenerationKeys({ anthropicKey: userKey, pexelsKey: userPexelsKey }) }),
      });
      if (!continuation.ok) throw new Error(`Generation continuation failed: HTTP ${continuation.status}`);
      return;
    }
    
    jlog('JSON parsed successfully');

    // Assign weights based on depth
    if (generatedJson.knowledgeTree) {
      assignWeightsByDepth(generatedJson.knowledgeTree, 0);
      jlog('Assigned node weights by depth');
    } else if (Array.isArray(generatedJson)) {
      // Context-based generation: assign weights to new children
      for (const entry of generatedJson) {
        if (entry.newChildren && Array.isArray(entry.newChildren)) {
          for (const child of entry.newChildren) {
            // These are children of existing nodes, so start at a reasonable depth
            assignWeightsByDepth(child, 3);
          }
        }
      }
      console.log('Depth-based weights assigned to new branches');
    }
    
    // Process media if pexels key is available
    if (pexelsKey) {
      jlog('Looking up images...');
      if (generatedJson.knowledgeTree) {
        // Full tree generation
        generatedJson.knowledgeTree = await processAllMedia(generatedJson.knowledgeTree, pexelsKey);
      } else if (Array.isArray(generatedJson)) {
        // Context-based generation: array of { parentNode, newChildren }
        for (const entry of generatedJson) {
          if (entry.newChildren && Array.isArray(entry.newChildren)) {
            for (let i = 0; i < entry.newChildren.length; i++) {
              entry.newChildren[i] = await processAllMedia(entry.newChildren[i], pexelsKey);
            }
          }
        }
      }
      jlog('Image lookup complete');
    }

    // Emit the graph (nodes + connections) format expected by the app
    if (generatedJson.knowledgeTree) {
      generatedJson.knowledgeTree = treeToGraph(generatedJson.knowledgeTree);
      generatedJson = toSchemaDocument(generatedJson);
      jlog('Converted to knowledge schema 1.0');
    }

    jlog('Saving result');
    clearInterval(flushTimer);
    await jobLogFlush();
    // Save result
    const { error: saveError } = await supabase.from('knowledge_generation_jobs').update({
      status: 'completed',
      result: generatedJson
    }).eq('id', jobId);
    if (saveError) throw new Error(`Could not save generated output: ${saveError.message}`);

    
    console.log(`Job ${jobId} completed successfully`);
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    jlog(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    clearInterval(flushTimer);
    await jobLogFlush?.().catch(() => {});
    await supabase.from('knowledge_generation_jobs').update({
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    }).eq('id', jobId);
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Authentication is optional - extract user ID if available
  const authHeader = req.headers.get('Authorization');
  let userId: string | null = null;
  
  if (authHeader?.startsWith('Bearer ')) {
    const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    
    const { data: userData } = await userSupabase.auth.getUser();
    if (userData?.user?.id) {
      userId = userData.user.id;
      console.log('Authenticated user:', userId);
    }
  }
  
  console.log('Processing request, user:', userId || 'anonymous');

  try {
    const body = await req.json();
    const { jobId } = body;

    // Internal hand-off: continue a long-running job in a fresh worker
    if (typeof body.continueJobId === 'string' && typeof body.resumeToken === 'string') {
      const { data: cj } = await supabase
        .from('knowledge_generation_jobs')
        .select('id, status, result')
        .eq('id', body.continueJobId)
        .single();
      if (!cj || cj.status !== 'processing' || (cj.result as any)?.resumeToken !== body.resumeToken) {
        return new Response(JSON.stringify({ error: 'Invalid continuation' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // Burn the token so it can't be replayed
      const { data: claimed, error: claimError } = await supabase.from('knowledge_generation_jobs')
        .update({ result: { ...(cj.result as any), resumeToken: null } })
        .eq('id', cj.id).eq('status', 'processing').contains('result', { resumeToken: body.resumeToken })
        .select('id').maybeSingle();
      if (claimError || !claimed) return new Response(JSON.stringify({ error: 'Continuation already claimed' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const keys = resolveGenerationKeys(body);
      (globalThis as any).EdgeRuntime?.waitUntil?.(runGenerationJob(cj.id, keys.anthropicKey, keys.pexelsKey));
      return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // If jobId is provided, return job status
    if (jobId) {
      const { data: job, error } = await supabase
        .from('knowledge_generation_jobs')
        .select('id, status, result, error, user_id, logs, updated_at')
        .eq('id', jobId)
        .single();
      
      if (error || !job) {
        return new Response(
          JSON.stringify({ error: 'Job not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Verify user owns this job (or is admin) - skip check for anonymous jobs or anonymous requests
      if (job.user_id && userId && job.user_id !== userId) {
        // Check if admin
        const { data: isAdmin } = await supabase.rpc('has_role', { _user_id: userId, _role: 'admin' });
        if (!isAdmin) {
          return new Response(
            JSON.stringify({ error: 'Access denied' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
      
      if ((job.status === 'processing' || job.status === 'queued') && Date.now() - new Date(job.updated_at).getTime() > 5 * 60_000) {
        return new Response(JSON.stringify({ id: job.id, status: 'failed', result: null, error: 'Generation worker stopped before saving. Please start a new generation.', logs: job.logs ?? [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({ id: job.id, status: job.status, result: job.status === 'completed' ? job.result : null, error: job.error, logs: (job as any).logs ?? [] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // =============== INPUT VALIDATION FOR NEW JOB CREATION ===============
    const { 
      topic, 
      sourceText = '', 
      sourceOnly = false,
      maxTokens,
      minNodes,
      maxNodes,
      contextNodes
    } = body;
    
    // Validate topic - required and must be string
    if (!topic || typeof topic !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Topic is required and must be a string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Validate topic length
    const trimmedTopic = topic.trim();
    if (trimmedTopic.length < 3 || trimmedTopic.length > 10000) {
      return new Response(
        JSON.stringify({ error: 'Topic must be between 3 and 10000 characters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Sanitize topic - remove control characters but preserve quotes for natural language
    const sanitizedTopic = trimmedTopic.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim();
    
    // Validate sourceText
    if (sourceText && typeof sourceText !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Source text must be a string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Limit sourceText size to prevent memory/storage issues
    const MAX_SOURCE_TEXT_LENGTH = 200000;
    if (sourceText.length > MAX_SOURCE_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Source text must not exceed ${MAX_SOURCE_TEXT_LENGTH} characters` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Sanitize sourceText - remove control characters
    const sanitizedSourceText = sourceText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    
    // Validate and clamp maxTokens to prevent excessive API costs
    const MIN_TOKENS = 1000;
    const MAX_TOKENS_LIMIT = 50000;
    const validatedMaxTokens = Math.min(
      Math.max(typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS, MIN_TOKENS), 
      MAX_TOKENS_LIMIT
    );
    
    // Validate and clamp node counts
    const MIN_NODES_LIMIT = 10;
    const MAX_NODES_LIMIT = 200;
    const validatedMinNodes = Math.min(
      Math.max(typeof minNodes === 'number' ? minNodes : DEFAULT_MIN_NODES, MIN_NODES_LIMIT), 
      MAX_NODES_LIMIT
    );
    const validatedMaxNodes = Math.min(
      Math.max(typeof maxNodes === 'number' ? maxNodes : DEFAULT_MAX_NODES, validatedMinNodes), 
      MAX_NODES_LIMIT
    );
    
    // Ensure minNodes <= maxNodes
    if (validatedMinNodes > validatedMaxNodes) {
      return new Response(
        JSON.stringify({ error: 'minNodes must be less than or equal to maxNodes' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Creating job for topic: ${sanitizedTopic} by user: ${userId}`);
    console.log(`Source only: ${sourceOnly}, Source text length: ${sanitizedSourceText.length}`);
    console.log(`Generation params: maxTokens=${validatedMaxTokens}, minNodes=${validatedMinNodes}, maxNodes=${validatedMaxNodes}`);

    // Insert job into database (rate limiting enforced by database trigger)
    // Use sanitized/validated values
    const { data: newJob, error: insertError } = await supabase
      .from('knowledge_generation_jobs')
      .insert({
        topic: sanitizedTopic,
        source_text: sanitizedSourceText || null,
        source_only: Boolean(sourceOnly),
        max_tokens: validatedMaxTokens,
        min_nodes: validatedMinNodes,
        max_nodes: validatedMaxNodes,
        user_id: userId,
        status: 'queued',
        // Store contextNodes temporarily in result field so the background worker can access them
        result: contextNodes ? { contextNodes } : null,
      })
      .select('id')
      .single();
    
    if (insertError || !newJob) {
      console.error('Failed to create job:', insertError);
      
      // Check if rate limit error
      if (insertError?.message?.includes('Rate limit exceeded')) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later (max 10 jobs per hour).' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      return new Response(
        JSON.stringify({ error: 'Failed to create job' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`Created job ${newJob.id}`);
    
    // Use EdgeRuntime.waitUntil to run generation in background
    // This allows us to return immediately while processing continues
    const keys = resolveGenerationKeys(body);
    (globalThis as any).EdgeRuntime?.waitUntil?.(runGenerationJob(newJob.id, keys.anthropicKey, keys.pexelsKey));
    
    // Return job ID immediately - client will poll for results
    return new Response(
      JSON.stringify({ jobId: newJob.id, status: 'queued' }),
      { 
        status: 202, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('Request error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
