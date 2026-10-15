import { useCallback, useMemo, useEffect, useState, useRef } from "react";
import { 
  ReactFlow, 
  Node, 
  Edge, 
  useNodesState, 
  useEdgesState, 
  Background, 
  Controls,
  NodeTypes,
  Handle,
  Position,
  NodeChange,
  useReactFlow,
  useStore
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Crosshair, Filter } from "lucide-react";
import { useFocus } from '../contexts/FocusContext';
import TaperedEdge from './TaperedEdge';
import { useTouchGestures, type TouchedTarget } from "@/hooks/useTouchGestures";
import { treeToGraph } from "@/lib/knowledge-graph";

export type KnowledgeNode = {
  node: string;
  weight?: number;
  children?: KnowledgeNode[];
};

type PositionedNode = KnowledgeNode & {
  x: number;
  y: number;
  depth: number;
  radius: number;
};

// Custom node component with handles
function KnowledgeNodeComponent({ data }: { data: any }) {
  const radius = data.radius || 20;
  const { focusedNodeLabel, setFocusedNodeLabel, focusSource, setFocusSource, setDfsIndexByLabel } = useFocus();

  const isFocused = focusedNodeLabel === data.label;
  const isSearchMatch = data.searchTerm && data.label.toLowerCase().includes(data.searchTerm.toLowerCase());
  // Screen-invariant orange glow ball for search matches (~1/20 of the canvas width).
  const zoom = useStore((s) => s.transform[2]);
  const paneWidth = useStore((s) => s.width);
  const glowSize = ((paneWidth || 800) / 20) / Math.max(zoom, 0.0001);
  const isSelected = data.isSelected === true;
  
  // Handle click on the node
  const handleNodeClick = (e: React.MouseEvent) => {
    // Shift+Click in edit mode = toggle selection
    if (e.shiftKey && data.editMode && data.onToggleSelect) {
      e.stopPropagation();
      data.onToggleSelect(data.label);
      return;
    }
    
    if (focusedNodeLabel === data.label) {
      setFocusedNodeLabel(null);
      setFocusSource(null);
    } else {
      setFocusedNodeLabel(data.label);
      setFocusSource('graph2d');
      setDfsIndexByLabel(data.label);
    }
  };
  
  return (
    <>
      {isSearchMatch && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 animate-[pulse_1.6s_ease-in-out_infinite]"
          style={{
            width: glowSize,
            height: glowSize,
            marginLeft: -glowSize / 2,
            marginTop: -glowSize / 2,
            borderRadius: "9999px",
            background:
              "radial-gradient(circle, rgba(249,115,22,0.85) 0%, rgba(249,115,22,0.45) 45%, rgba(249,115,22,0) 70%)",
            zIndex: 0,
          }}
        />
      )}
      {/* Input handle (top) */}
      <Handle
        type="target"
        position={Position.Bottom}
        style={{ 
          background: '#1f2937', 
          border: '2px solid #f5f5f5',
          width: '8px',
          height: '8px'
        }}
      />
      
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            // Updated styling for focused node with THICKER light blue border and yellow highlight for search matches
            className={`rounded-full transition-transform duration-400 hover:scale-105 cursor-move flex items-center justify-center text-xs font-medium text-center leading-tight p-1 ${
              isFocused 
              ? 'scale-210 animate-[pulse_2s_ease-in-out_infinite]' 
              : isSelected
              ? 'ring-4 ring-blue-500 scale-110'
              : isSearchMatch
              ? 'ring-4 ring-orange-500 scale-110'
              : ''
            }`}
            style={{
              position: 'relative',
              zIndex: 1,
              backgroundColor: isFocused ? '#f97316' : isSelected ? '#3b82f6' : '#1f2937',
              color: '#ffffff',
              border: isFocused ? 'none' : isSelected ? '2px solid #2563eb' : '1px solid #374151',
              boxShadow: isFocused ? '0 0 0 12px rgba(251,146,60,0.85), 0 0 40px 16px rgba(249,115,22,0.6)' : isSelected ? '0 0 0 12px rgba(59,130,246,0.8), 0 0 40px 16px rgba(59,130,246,0.55)' : '0 2px 4px rgba(0,0,0,0.1)',
              ...{
                width: radius * 2,
                height: radius * 2,
                fontSize: Math.max(8, radius / 3)
              }
            }}
            title={data.label}
            data-node-label={data.label}

            onClick={handleNodeClick}
          >
            {data.label}
          </div>
        </TooltipTrigger>
        <TooltipContent>{data.label}</TooltipContent>
      </Tooltip>
      
      {/* Output handle (bottom) */}
      <Handle
        type="source"
        position={Position.Top}
        style={{ 
          background: '#1f2937', 
          border: '2px solid #f5f5f5',
          width: '8px',
          height: '8px'
        }}
      />
    </>
  );
}

const nodeTypes: NodeTypes = {
  knowledge: KnowledgeNodeComponent,
};

const edgeTypes = {
  tapered: TaperedEdge,
};

function convertTreeToReactFlow(root: KnowledgeNode, hideEmptyNodes = false) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const graph = treeToGraph(root as any);
  if (!graph) return { nodes, edges };

  const { nodes: attrs, connections } = graph;
  // In focus levels that hide widget-less nodes, drop them (and their links) here too.
  const hasWidgets = (name: string) => {
    const w = (attrs[name] as any)?.widgets;
    return Array.isArray(w) && w.length > 0;
  };
  const isVisible = (name: string) => !hideEmptyNodes || hasWidgets(name);
  // When widget-less nodes are hidden, link through them: a visible node connects to the
  // nearest visible descendants so the hierarchy keeps its levels instead of flattening.
  const childCache = new Map<string, string[]>();
  const childrenOf = (name: string): string[] => {
    const cached = childCache.get(name);
    if (cached) return cached;
    const out: string[] = [];
    const seenLocal = new Set<string>([name]);
    const walk = (n: string) => {
      for (const c of connections[n] ?? []) {
        if (seenLocal.has(c)) continue;
        seenLocal.add(c);
        if (isVisible(c)) out.push(c);
        else walk(c);
      }
    };
    walk(name);
    childCache.set(name, out);
    return out;
  };
  const visibleNames = Object.keys(attrs).filter(isVisible);
  if (visibleNames.length === 0) return { nodes, edges };
  // Start from the root when visible, otherwise from the nearest visible descendants' ancestor.
  const startNode = isVisible(graph.root) ? graph.root : visibleNames[0];
  const rootChildren = isVisible(graph.root) ? [] : childrenOf(graph.root);


  function weightToRadius(w?: number) {
    if (w === undefined || Number.isNaN(w)) return 25;
    const clamped = Math.max(1, Math.min(100, w));
    const t = (clamped - 1) / 99;
    return 15 + t * 95;
  }

  // --- depth = longest path from root (DAG safe) ---
  const depthByLabel = new Map<string, number>();
  const scan = (name: string, d: number, stack: Set<string>) => {
    if (stack.has(name)) return;
    if ((depthByLabel.get(name) ?? -1) >= d) return;
    depthByLabel.set(name, d);
    const next = new Set(stack);
    next.add(name);
    for (const c of childrenOf(name)) scan(c, d + 1, next);
  };
  if (rootChildren.length) {
    for (const c of rootChildren) scan(c, 0, new Set());
  } else {
    scan(startNode, 0, new Set());
  }


  // Any node not reachable from the root still gets drawn.
  for (const name of visibleNames) if (!depthByLabel.has(name)) depthByLabel.set(name, 0);

  // In Euclidean/Earth space, vertical placement follows the z coordinate:
  // nodes are ranked by z so the row order matches their height above the root.
  const space = (graph as any).space;
  if (space === "Euclidean" || space === "Earth") {
    const zOf = (name: string) => {
      const p = (attrs[name] as any)?.position;
      const z = Array.isArray(p) ? Number(p[2]) : NaN;
      return Number.isFinite(z) ? z : 0;
    };
    const rootZ = zOf(graph.root);
    const uniqueZ = [...new Set(visibleNames.map((n) => zOf(n) - rootZ))].sort((a, b) => a - b);
    const rankOf = new Map(uniqueZ.map((z, i) => [z, i]));
    for (const name of visibleNames) {
      depthByLabel.set(name, rankOf.get(zOf(name) - rootZ) ?? 0);
    }
  }

  const maxDepth = Math.max(...depthByLabel.values(), 0);


  // --- radii up-front so layout can avoid visual overlap ---
  const radiusByLabel = new Map<string, number>();
  const weightByLabel = new Map<string, number>();
  for (const [name, a] of Object.entries(attrs)) {
    if (!isVisible(name)) continue;
    radiusByLabel.set(name, weightToRadius((a as any)?.weight));
    const w = (a as any)?.weight;
    weightByLabel.set(name, typeof w === "number" && !Number.isNaN(w) ? w : 50);
  }
  const radiusOf = (name: string) => radiusByLabel.get(name) ?? 25;

  // --- horizontal placement: tidy tree layout ---
  // Each node reserves a slot as wide as its whole subtree; children are spread
  // evenly beneath their parent and the parent sits exactly over the middle.
  // xByLabel stores CENTER x.
  const xByLabel = new Map<string, number>();
  const orderedLabels: string[] = [];
  const visited = new Set<string>();
  const primaryKids = new Map<string, string[]>();
  const hPadding = 50;
  const gap = 30;

  const place = (name: string) => {
    visited.add(name);
    orderedLabels.push(name);
    const own: string[] = [];
    for (const c of childrenOf(name)) {
      if (visited.has(c)) continue;
      own.push(c);
      place(c);
    }
    primaryKids.set(name, own);
  };
  const tops: string[] = [];
  const startList = rootChildren.length ? rootChildren : [startNode];
  for (const s of startList) if (!visited.has(s)) { tops.push(s); place(s); }
  for (const name of visibleNames) if (!visited.has(name)) { tops.push(name); place(name); }

  // Contour-based tidy tree (Reingold–Tilford style): each subtree keeps its
  // per-depth [left,right] extents relative to its root's center. Sibling
  // subtrees are packed as tightly as possible without overlap at any depth,
  // and each parent is centered exactly over its children.
  type Contour = Map<number, [number, number]>;
  const offsets = new Map<string, number>(); // child center relative to parent center
  const mergeInto = (acc: Contour, c: Contour, shift: number) => {
    for (const [d, [l, r]] of c) {
      const e = acc.get(d);
      if (e) acc.set(d, [Math.min(e[0], l + shift), Math.max(e[1], r + shift)]);
      else acc.set(d, [l + shift, r + shift]);
    }
  };
  const packSiblings = (list: string[], contours: Contour[]) => {
    const acc: Contour = new Map();
    const pos: number[] = [];
    list.forEach((_, i) => {
      const c = contours[i];
      let off = 0;
      if (i > 0) {
        off = -Infinity;
        for (const [d, [l]] of c) {
          const e = acc.get(d);
          if (e) off = Math.max(off, e[1] - l + gap);
        }
        if (off === -Infinity) off = pos[i - 1];
      }
      pos.push(off);
      mergeInto(acc, c, off);
    });
    const mid = list.length ? (pos[0] + pos[pos.length - 1]) / 2 : 0;
    return { pos: pos.map((p) => p - mid), acc };
  };
  const layout = (name: string): Contour => {
    const kids = primaryKids.get(name) ?? [];
    const kc = kids.map(layout);
    const { pos } = packSiblings(kids, kc);
    const contour: Contour = new Map();
    const r = radiusOf(name);
    contour.set(depthByLabel.get(name) ?? 0, [-r, r]);
    kids.forEach((k, i) => {
      offsets.set(k, pos[i]);
      mergeInto(contour, kc[i], pos[i]);
    });
    return contour;
  };
  const topContours = tops.map(layout);
  const topPack = packSiblings(tops, topContours);
  const assign = (name: string, x: number) => {
    xByLabel.set(name, x);
    for (const k of primaryKids.get(name) ?? []) assign(k, x + (offsets.get(k) ?? 0));
  };
  tops.forEach((t, i) => assign(t, topPack.pos[i]));
  let minLeft = Infinity;
  for (const [n, x] of xByLabel) minLeft = Math.min(minLeft, x - radiusOf(n));
  for (const [n, x] of xByLabel) xByLabel.set(n, x - minLeft + hPadding);

  // --- separation pass: no two nodes on the same row may visually overlap ---
  const rows = new Map<number, string[]>();
  for (const name of orderedLabels) {
    const d = depthByLabel.get(name) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d)!.push(name);
  }
  // In Earth space, left-right order follows longitude (second position coordinate).
  const lonOf = (name: string) => {
    const p = (attrs[name] as any)?.position;
    const lon = Array.isArray(p) ? Number(p[1]) : NaN;
    return Number.isFinite(lon) ? lon : 0;
  };
  for (const row of rows.values()) {
    if (space === "Earth") {
      row.sort((a, b) => lonOf(a) - lonOf(b));
      const oldCenter =
        row.reduce((s, n) => s + (xByLabel.get(n) ?? 0), 0) / Math.max(1, row.length);
      let c = 0;
      for (let i = 0; i < row.length; i++) {
        const r = radiusOf(row[i]);
        if (i > 0) c += radiusOf(row[i - 1]) + r + gap;
        xByLabel.set(row[i], c);
      }
      const newCenter =
        row.reduce((s, n) => s + (xByLabel.get(n) ?? 0), 0) / Math.max(1, row.length);
      const shift = oldCenter - newCenter;
      for (const n of row) xByLabel.set(n, (xByLabel.get(n) ?? 0) + shift);
    } else {
      row.sort((a, b) => (xByLabel.get(a) ?? 0) - (xByLabel.get(b) ?? 0));
      const before =
        row.reduce((s, n) => s + (xByLabel.get(n) ?? 0), 0) / Math.max(1, row.length);
      let moved = false;
      for (let i = 1; i < row.length; i++) {
        const prev = row[i - 1];
        const cur = row[i];
        const minCenterDist = radiusOf(prev) + radiusOf(cur) + gap;
        const prevX = xByLabel.get(prev) ?? 0;
        const curX = xByLabel.get(cur) ?? 0;
        if (curX - prevX < minCenterDist) { xByLabel.set(cur, prevX + minCenterDist); moved = true; }
      }
      // Keep the row balanced around where it was, rather than drifting right.
      if (moved) {
        const after =
          row.reduce((s, n) => s + (xByLabel.get(n) ?? 0), 0) / Math.max(1, row.length);
        for (const n of row) xByLabel.set(n, (xByLabel.get(n) ?? 0) + before - after);
      }
    }
  }


  // --- build react-flow nodes ---
  const vGap = 120;
  const idByLabel = new Map<string, string>();

  orderedLabels.forEach((name, i) => {
    const a = attrs[name] ?? { name };
    const radius = radiusOf(name);
    const id = `node-${i}`;
    idByLabel.set(name, id);

    const depth = depthByLabel.get(name) ?? 0;
    nodes.push({
      id,
      type: "knowledge",
      position: {
        x: (xByLabel.get(name) ?? hPadding) - radius,
        y: 3 * (maxDepth - depth) * vGap + vGap / 2 - radius,
      },
      data: {
        label: name,
        icon: (a as any).icon,
        weight: a.weight,
        radius,
        childrenCount: childrenOf(name).length,
      },
      draggable: true,
    });
  });






  // --- enforce a square layout: stretch the shorter axis so total width == total height ---
  if (nodes.length > 1) {
    const xs = nodes.map((n) => n.position.x);
    const ys = nodes.map((n) => n.position.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w > 0 && h > 0 && Math.abs(w - h) > 1) {
      const sx = w < h ? h / w : 1;
      const sy = h < w ? w / h : 1;
      for (const n of nodes) {
        n.position = { x: minX + (n.position.x - minX) * sx, y: minY + (n.position.y - minY) * sy };
      }
    }
  }

  // --- build every edge from the adjacency list (shared children keep all parents) ---
  const seen = new Set<string>();
  for (const parent of Object.keys(connections)) {
    if (!isVisible(parent)) continue;
    const sourceId = idByLabel.get(parent);
    if (!sourceId) continue;
    // Only draw real, direct connections — never bridge through hidden nodes.
    for (const child of connections[parent] ?? []) {
      if (!isVisible(child)) continue;

      const targetId = idByLabel.get(child);
      if (!targetId || targetId === sourceId) continue;
      const edgeId = `edge-${sourceId}-${targetId}`;
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      edges.push({
        id: edgeId,
        source: sourceId,
        target: targetId,
        type: "tapered",
        data: {
          sourceRadius: radiusByLabel.get(parent) ?? 25,
          targetRadius: radiusByLabel.get(child) ?? 25,
          sourceWeight: weightByLabel.get(parent) ?? 50,
          targetWeight: weightByLabel.get(child) ?? 50,
          edgeId,
        },
      });
    }
  }

  return { nodes, edges };
}


export function KnowledgeTree({
  data,
  editMode,
  selectedNodes,
  onToggleSelectNode,
  onGestureLongPressNode,
  onGestureCreateChild,
}: {
  data: KnowledgeNode;
  editMode?: boolean;
  selectedNodes?: Set<string>;
  onToggleSelectNode?: (label: string) => void;
  onGestureLongPressNode?: (label: string) => void;
  onGestureCreateChild?: (parentLabel: string) => void;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  
  const { focusLevel, filterTerm, setFilterTerm } = useFocus();
  const [isFilterVisible, setIsFilterVisible] = useState(false);
  const hideEmptyNodes = focusLevel === 1 || focusLevel === 3;

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => 
    convertTreeToReactFlow(data, hideEmptyNodes), [data, hideEmptyNodes]
  );
  
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { fitView, setCenter } = useReactFlow();
  const { focusedNodeLabel } = useFocus();

  const centerOnFocusedNode = useCallback(() => {
    if (!focusedNodeLabel) return;
    const target = nodes.find((n) => n.data?.label === focusedNodeLabel);
    if (!target) return;
    const radius = (target.data as any)?.radius ?? 25;
    setCenter(target.position.x + radius, target.position.y + radius, {
      zoom: 2.5,
      duration: 600,
    });
  }, [focusedNodeLabel, nodes, setCenter]);

  // Reset nodes and edges when data changes
  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = convertTreeToReactFlow(data, hideEmptyNodes);
    setNodes(newNodes.map(node => ({
      ...node,
      data: { 
        ...node.data, 
        searchTerm,
        editMode: !!editMode,
        isSelected: selectedNodes?.has(node.data.label as string) ?? false,
        onToggleSelect: onToggleSelectNode,
      }
    })));
    setEdges(newEdges);
    setTimeout(() => fitView({ padding: 0.1 }), 50);
  }, [data, hideEmptyNodes, setNodes, setEdges, fitView]);

  // Update nodes with search term and selection state
  useEffect(() => {
    setNodes(nds => nds.map(node => ({
      ...node,
      data: {
        ...node.data,
        searchTerm,
        editMode: !!editMode,
        isSelected: selectedNodes?.has(node.data.label as string) ?? false,
        onToggleSelect: onToggleSelectNode,
      }
    })));
  }, [searchTerm, editMode, selectedNodes, onToggleSelectNode, setNodes]);

  // Dynamic repositioning based on node movements
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    
    // Check if any node was dragged
    const draggedChanges = changes.filter(change => 
      change.type === 'position' && change.dragging === false
    );
    
    if (draggedChanges.length > 0) {
      // Apply force-directed layout to avoid overlaps
      setNodes(nds => {
        const updatedNodes = [...nds];
        
        // Simple collision detection and resolution
        for (let i = 0; i < updatedNodes.length; i++) {
          for (let j = i + 1; j < updatedNodes.length; j++) {
            const nodeA = updatedNodes[i];
            const nodeB = updatedNodes[j];
            
            if (!nodeA.position || !nodeB.position) continue;
            
            const dx = nodeB.position.x - nodeA.position.x;
            const dy = nodeB.position.y - nodeA.position.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const minDistance = 100; // Minimum distance between nodes
            
            if (distance < minDistance && distance > 0) {
              const pushDistance = (minDistance - distance) / 2;
              const angle = Math.atan2(dy, dx);
              
              // Push nodes apart
              const pushX = Math.cos(angle) * pushDistance;
              const pushY = Math.sin(angle) * pushDistance;
              
              updatedNodes[i] = {
                ...nodeA,
                position: {
                  x: nodeA.position.x - pushX,
                  y: nodeA.position.y - pushY
                }
              };
              
              updatedNodes[j] = {
                ...nodeB,
                position: {
                  x: nodeB.position.x + pushX,
                  y: nodeB.position.y + pushY
                }
              };
            }
          }
        }
        
        return updatedNodes;
      });
    }
  }, [onNodesChange, setNodes]);

  // ----- Touch gesture hit testing -----
  // Walk up from the touched DOM element to find a [data-node-label] node.
  const hitTest = useCallback((point: { x: number; y: number }): TouchedTarget => {
    const el = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
    if (!el) return { kind: "empty" };
    const nodeEl = el.closest<HTMLElement>("[data-node-label]");
    if (!nodeEl) return { kind: "empty" };
    const label = nodeEl.dataset.nodeLabel || "";
    const rect = nodeEl.getBoundingClientRect();
    return {
      kind: "node",
      id: label,
      label,
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  }, []);

  useTouchGestures(surfaceRef, {
    hitTest,
    editMode: !!editMode,
    onLongPressNode: (label) => onGestureLongPressNode?.(label),
    onRadialDragFromNode: (label) => onGestureCreateChild?.(label),
  });

  return (
    <section aria-label="Knowledge tree" className="w-full h-full">
      <div
        ref={surfaceRef}
        className="w-full h-full rounded-lg border border-border bg-card overflow-hidden"
      >
        {isFilterVisible && (
          <div className="p-2 border-b border-border bg-background">
            <Input
              autoFocus
              placeholder="Show only nodes matching..."
              value={filterTerm}
              onChange={(e) => setFilterTerm(e.target.value)}
              className="w-full max-w-md bg-background border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}
        {/* Conditional Search Bar */}
        {isSearchVisible && (
          <div className="p-4 border-b border-border bg-background">
            <Input
              placeholder="Search nodes..."
              value={searchTerm}
              onChange={(e) => {
                console.log('Search input changed:', e.target.value);
                setSearchTerm(e.target.value);
              }}
              className="w-full max-w-md bg-background border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}
        <div className="w-full" style={{ height: `calc(100% - ${(isSearchVisible ? 80 : 0) + (isFilterVisible ? 56 : 0)}px)` }}>
          <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          maxZoom={100}
          minZoom={0.0005}
          defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
          style={{ backgroundColor: '#f5f5f5' }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
        >
          <Background color="#e0e0e0" gap={20} />
            <Controls showInteractive={false}>
              <Button
                variant="outline" 
                size="sm"
                onClick={() => {
                  console.log('Search button clicked, current visibility:', isSearchVisible);
                  setIsSearchVisible(!isSearchVisible);
                }}
                className="!h-[26px] !w-[26px] min-h-0 min-w-0 rounded-none border-0 bg-background p-0 hover:bg-accent hover:text-accent-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Search />
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Filter nodes"
                aria-label="Filter nodes"
                onClick={() => setIsFilterVisible((v) => !v)}
                className={`!h-[26px] !w-[26px] min-h-0 min-w-0 rounded-none border-0 p-0 hover:bg-accent hover:text-accent-foreground [&_svg]:h-3.5 [&_svg]:w-3.5 ${filterTerm ? 'bg-accent' : 'bg-background'}`}
              >
                <Filter />
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Center on focused node"
                aria-label="Center on focused node"
                disabled={!focusedNodeLabel}
                onClick={centerOnFocusedNode}
                className="!h-[26px] !w-[26px] min-h-0 min-w-0 rounded-none border-0 bg-background p-0 hover:bg-accent hover:text-accent-foreground disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Crosshair />
              </Button>
            </Controls>
          </ReactFlow>
        </div>
      </div>
    </section>
  );
}
