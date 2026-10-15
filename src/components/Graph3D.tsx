import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { createPortal } from "react-dom";
import type { KnowledgeNode, Widget } from "../types"; // Adjusted path to match the correct location
import { useFocus } from '../contexts/FocusContext';
import { resolveImageUrl, getGlobalDirHandle, getGlobalVersion } from '../contexts/DataFolderContext';
import { useTheme } from "next-themes";
import { 
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import { Switch } from "../components/ui/switch";
import { Slider } from "./ui/slider";
import { Button } from "../components/ui/button";
import { isValidImageUrl } from "../lib/utils";
import { Volume2, VolumeX, Search, X } from "lucide-react";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useTouchGestures, type TouchedTarget, type ScreenPoint } from "@/hooks/useTouchGestures";
import { getEarthTexture } from "@/lib/earth-texture";
import { getSandColorMap, getSandBumpMap } from "@/lib/sand-texture";


// Resolve CSS HSL tokens like --primary into a usable CSS color string
function useCssHsl(varName: string, fallback: string = "hsl(220 14% 96%)") {
  const [color, setColor] = useState<string>(fallback);
  useEffect(() => {
    const root = document.documentElement;
    const val = getComputedStyle(root).getPropertyValue(varName).trim();
    if (val) {
      setColor(`hsl(${val})`);
    }
  }, [varName]);
  return color;
}

type Node3D = {
  id: string;
  label: string;
  icon?: string;
  weight?: number;
  position: [number, number, number];
  widgets?: Widget[];
  prose?: string;
};

function ResolvedImage({
  imagePath,
  alt,
  className,
  onError,
}: {
  imagePath: string;
  alt: string;
  className?: string;
  onError?: React.ImgHTMLAttributes<HTMLImageElement>["onError"];
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string>(imagePath);
  const [version, setVersion] = useState(getGlobalVersion());

  useEffect(() => {
    const id = window.setInterval(() => {
      const v = getGlobalVersion();
      if (v !== version) setVersion(v);
    }, 200);
    return () => window.clearInterval(id);
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = await resolveImageUrl(imagePath);
      if (cancelled) return;
      setResolvedSrc(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [imagePath, version]);

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      loading="lazy"
      onError={onError}
    />
  );
}

type Edge3D = { source: string; target: string };

const HTML_OVERLAY_Z_INDEX_RANGE: [number, number] = [120, 0];
/** Distance at which a node label reaches its full (maximum) size. */
const LABEL_DISTANCE_FACTOR = 6;
const WIDGET_LONG_PRESS_MS = 600;
const WIDGET_LONG_PRESS_MAX_TRAVEL_PX = 12;

function useWidgetLongPress({
  editMode,
  widget,
  nodeLabel,
  onWidgetLongPress,
}: {
  editMode: boolean;
  widget: Widget;
  nodeLabel: string;
  onWidgetLongPress?: (widgetName: string, nodeLabel: string) => void;
}) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<ScreenPoint | null>(null);
  const longPressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!editMode || !onWidgetLongPress || !widget.name) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    longPressedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      onWidgetLongPress(widget.name, nodeLabel);
    }, WIDGET_LONG_PRESS_MS);
  }, [clearTimer, editMode, nodeLabel, onWidgetLongPress, widget.name]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current || timerRef.current === null) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (Math.hypot(dx, dy) > WIDGET_LONG_PRESS_MAX_TRAVEL_PX) clearTimer();
  }, [clearTimer]);

  const onPointerEnd = useCallback((e: React.PointerEvent) => {
    clearTimer();
    startRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, [clearTimer]);

  const shouldSuppressClick = useCallback(() => {
    if (!longPressedRef.current) return false;
    longPressedRef.current = false;
    return true;
  }, []);

  return {
    widgetLongPressHandlers: {
      onPointerDownCapture: onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onContextMenu: (e: React.MouseEvent) => editMode && e.preventDefault(),
    },
    shouldSuppressClick,
  };
}

function normalizeWeight(w?: number) {
  if (w === undefined || Number.isNaN(w)) return 0.5;
  const clamped = Math.max(1, Math.min(100, w));
  return (clamped - 1) / 99; // 0..1
}

function coercePosition(value: any): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value.map((v) => Number(v));
  if ([x, y, z].some((v) => !Number.isFinite(v))) return null;
  return [x, y, z];
}

/** Earth radius used when the graph space is "Earth". */
export const EARTH_RADIUS = 100;

/** Convert [latitude(deg), longitude(deg), radius] into cartesian coordinates. */
function geoToCartesian(pos: [number, number, number]): [number, number, number] {
  const [lat, lon, r] = pos;
  // radius 0 (or negative/invalid) means the exact center of the Earth
  const radius = Number.isFinite(r) ? Math.max(0, r) : EARTH_RADIUS;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

/**
 * In "Earth" space the globe is solid: anything on the far side (or inside it)
 * must be hidden. Returns true when the segment camera -> point crosses the
 * Earth sphere before reaching the point.
 */
const _occP = new THREE.Vector3();
const _occD = new THREE.Vector3();
function useEarthOcclusion(position: [number, number, number], enabled: boolean) {
  const [occluded, setOccluded] = useState(false);
  const occRef = useRef(false);

  useFrame(({ camera }) => {
    let hidden = false;
    if (enabled) {
      const p = _occP.set(position[0], position[1], position[2]);
      const c = camera.position;
      const d = _occD.subVectors(p, c);
      const len = d.length();
      if (len > 1e-6) {
        d.divideScalar(len);
        // closest approach of the ray to the sphere centre (origin)
        const tca = -c.dot(d);
        const d2 = c.lengthSq() - tca * tca;
        const r2 = EARTH_RADIUS * EARTH_RADIUS;
        if (d2 < r2) {
          const thc = Math.sqrt(r2 - d2);
          const tEnter = tca - thc;
          // surface crossed between the camera and the point => hidden
          if (tEnter > 0.001 && tEnter < len - 0.001) hidden = true;
        }
      }
    }
    if (hidden !== occRef.current) {
      occRef.current = hidden;
      setOccluded(hidden);
    }
  });

  return occluded;
}


export function getGraphSpace(root: KnowledgeNode | null | undefined): string {
  return ((root as any)?.space ?? "Default") as string;
}

function build3DLayout(root: KnowledgeNode) {
  const space = getGraphSpace(root);
  const isEuclidean = space === "Euclidean";
  const isEarth = space === "Earth";

  const nodes: Node3D[] = [];
  const edges: Edge3D[] = [];
  let idCounter = 0;

  // Improved spacing parameters to prevent overlaps (halved for shorter links)
  const layerDistance = 7.5; // Half the distance between depth levels
  const minNodeDistance = 2; // Half the minimum distance between any two nodes
  const baseRadius = 3; // Half the base radius for first level
  
  function countNodesAtDepth(node: KnowledgeNode, targetDepth: number, currentDepth = 0): number {
    if (currentDepth === targetDepth) return 1;
    if (!node.children || currentDepth >= targetDepth) return 0;
    
    return node.children.reduce((sum, child) => 
      sum + countNodesAtDepth(child, targetDepth, currentDepth + 1), 0);
  }
  
  function calculateOptimalRadius(nodeCount: number, minDistance: number, averageNodeSize = 1): number {
    if (nodeCount <= 1) return 0;
    // Calculate radius needed to fit nodeCount nodes with minDistance between them
    // Scale by average node size - smaller nodes get shorter links
    const sizeScale = 0.5 + (averageNodeSize * 0.8); // Range from 0.5x to 1.3x
    const circumference = nodeCount * minDistance * 2 * sizeScale;
    return Math.max(baseRadius * sizeScale, circumference / (2 * Math.PI));
  }
  
  // A label may be reached from several parents (adjacency-list graph):
  // place it once, at its deepest occurrence, and add one edge per parent.
  const depthByLabel = new Map<string, number>();
  (function scanDepth(n: KnowledgeNode, d: number) {
    depthByLabel.set(n.node, Math.max(depthByLabel.get(n.node) ?? 0, d));
    for (const c of n.children ?? []) scanDepth(c, d + 1);
  })(root, 0);

  const idByLabel = new Map<string, string>();
  const seenEdges = new Set<string>();
  const addEdge3D = (source: string, target: string) => {
    const key = `${source}->${target}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target });
  };

  function traverse(n: KnowledgeNode, depth: number, parentId?: string, parentPos: [number, number, number] = [0, 0, 0], siblingIndex = 0, totalSiblings = 1) {
    const existingId = idByLabel.get(n.node);
    if (existingId) {
      if (parentId) addEdge3D(parentId, existingId);
      return existingId;
    }

    const id = `n3-${idCounter++}`;
    idByLabel.set(n.node, id);
    const z = (depthByLabel.get(n.node) ?? depth) * layerDistance;

    
    const rawPosition = isEuclidean || isEarth ? coercePosition((n as any).position) : null;
    const explicitPosition = rawPosition && isEarth ? geoToCartesian(rawPosition) : rawPosition;


    let x = 0, y = 0;
    
    if (depth === 0) {
      // Root node at origin
      x = 0;
      y = 0;
    } else {
      // Calculate position based on sibling arrangement
      if (totalSiblings === 1) {
        // Single child, place directly below parent with slight offset to avoid exact overlap
        x = parentPos[0] + (Math.random() - 0.5) * 0.5; // Small random offset
        y = parentPos[1] + (Math.random() - 0.5) * 0.5;
      } else {
        // Multiple siblings, arrange in circle around parent
        // Calculate average node size for this group (including parent and siblings)
        const parentWeight = normalizeWeight(n.weight);
        const siblingWeights = (n.children || []).map(child => normalizeWeight(child.weight));
        const averageSize = ([parentWeight, ...siblingWeights].reduce((sum, w) => sum + w, 0)) / (siblingWeights.length + 1);
        
        const radius = calculateOptimalRadius(totalSiblings, minNodeDistance, 0.2 * averageSize * normalizeWeight(n.weight) * normalizeWeight(n.weight));
        const angle = (siblingIndex / totalSiblings) * Math.PI * 15; // Wider spread 
        x = parentPos[0] + Math.cos(angle) * radius;
        y = parentPos[1] + Math.sin(angle) * radius;
      }
    }

    const position: [number, number, number] = explicitPosition ?? [x, y, z];
    
    // Check for collisions with existing nodes and adjust if necessary
    let finalPosition = position;
    let attempts = 0;
    const maxAttempts = explicitPosition ? 0 : 20;
    
    while (attempts < maxAttempts) {
      let collision = false;
      for (const existingNode of nodes) {
        const dx = finalPosition[0] - existingNode.position[0];
        const dy = finalPosition[1] - existingNode.position[1];
        const dz = finalPosition[2] - existingNode.position[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        if (distance < minNodeDistance) {
          collision = true;
          // Move away from collision
          const moveDistance = minNodeDistance - distance + 1;
          const moveAngle = Math.atan2(dy, dx);
          finalPosition = [
            finalPosition[0] + Math.cos(moveAngle) * moveDistance,
            finalPosition[1] + Math.sin(moveAngle) * moveDistance,
            finalPosition[2]
          ];
          break;
        }
      }
      
      if (!collision) break;
      attempts++;
    }

    nodes.push({ id, label: n.node, icon: (n as any).icon, weight: n.weight, position: finalPosition, widgets: n.widgets, prose: (n as any).prose });

    if (parentId) addEdge3D(parentId, id);

    const children = n.children ?? [];
    const childCount = children.length;
    
    if (childCount > 0) {
      for (let i = 0; i < childCount; i++) {
        traverse(children[i], depth + 1, id, finalPosition, i, childCount);
      }
    }

    return id;
  }

  traverse(root, 0);

  return { nodes, edges };
}


// Debug indicator to show positions - make more visible
/** Earth drawn at the origin when the graph space is "Earth". */
function EarthSphere() {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useEffect(() => {
    let alive = true;
    getEarthTexture()
      .then((t) => {
        if (!alive) return;
        setTexture(t);
        if (matRef.current) {
          matRef.current.map = t;
          matRef.current.emissiveMap = t;
          matRef.current.needsUpdate = true;
        }
      })
      .catch((e) => console.error("Failed to build Earth texture", e));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <group>
      <pointLight position={[0, 0, 0]} intensity={0} />
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[EARTH_RADIUS, 96, 96]} />
        <meshStandardMaterial
          ref={matRef}
          key={texture ? "earth-tex" : "earth-plain"}
          map={texture ?? undefined}
          emissiveMap={texture ?? undefined}
          emissive={texture ? new THREE.Color("#ffffff") : new THREE.Color("#000000")}
          emissiveIntensity={texture ? 0.85 : 0}
          color={texture ? "#ffffff" : "#1e3a8a"}
          roughness={0.9}
          metalness={0}
        />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[EARTH_RADIUS * 1.004, 48, 48]} />
        <meshBasicMaterial color="#60a5fa" transparent opacity={0.06} side={THREE.BackSide} />
      </mesh>
    </group>
  );
}



function DebugMarker({ position }: { position: [number, number, number] }) {

  return (
    <mesh position={position} scale={[0.3, 0.3, 0.3]}>
      <sphereGeometry />
      <meshBasicMaterial color="lime" />
    </mesh>
  );
}

// YouTube Preview component
function YouTubePreview({ 
  url, 
  position, 
  index, 
  notes,
  widget,
  nodeLabel,
  editMode,
  onWidgetClick,
  onWidgetLongPress,
}: { 
  url: string; 
  position: [number, number, number]; 
  index: number;
  notes?: string;
  widget: Widget;
  nodeLabel: string;
  editMode: boolean;
  onWidgetClick: (widget: Widget) => void;
  onWidgetLongPress?: (widgetName: string, nodeLabel: string) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true); // Start visible by default
  
  // Use the position passed from parent
  const previewPos: [number, number, number] = position;
  
  // Get YouTube video ID
  const getYouTubeVideoId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };
  
  const videoId = getYouTubeVideoId(url);
  const thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '';
  
  // Handle visibility based on camera position
  const { camera } = useThree();
  useFrame(() => {
    if (!previewRef.current) return;
    
    // Calculate distance to camera
    const distance = new THREE.Vector3(...previewPos).distanceTo(camera.position);
    
    // Always show previews, with slight fade at distance
    if (distance < 30) {
      previewRef.current.style.opacity = "1";
    } else {
      previewRef.current.style.opacity = "0.5";
    }
  });
  
  // Open side panel view  
  const openSidePanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shouldSuppressClick()) return;
    console.log("Opening side panel for YouTube video:", url);
    onWidgetClick(widget);
  };

  const { widgetLongPressHandlers, shouldSuppressClick } = useWidgetLongPress({
    editMode,
    widget,
    nodeLabel,
    onWidgetLongPress,
  });
  
  return (
    <>
      {/* Debug sphere to see where the preview should be */}
      
      
      {/* The YouTube preview */}
      <group position={previewPos}>
        <Html
          center
          transform
          occlude={false}
          distanceFactor={10}
          zIndexRange={HTML_OVERLAY_Z_INDEX_RANGE}
          position={[0, 0, 0]}
          style={{ 
            width: "60px", 
            height: "45px", // 4:3 aspect ratio for YouTube thumbnails
            transform: "rotateY(180deg)"
          }}
        >
          <div 
            ref={previewRef}
            style={{
              width: "100%",
              height: "100%",
              position: "relative",
              cursor: "pointer",
              borderRadius: "5px",
              opacity: 1, // Start visible immediately
              transition: "opacity 0.3s",
              overflow: "hidden",
              border: "2px solid #ff0000", // YouTube red border
              boxShadow: "0 0 10px rgba(255,0,0,0.7)",
              transform: "scaleX(-1)", // Fix inversion
              backgroundColor: "#000"
            }}
            {...widgetLongPressHandlers}
            onClick={openSidePanel}
          >
            {thumbnailUrl ? (
              <>
                <img 
                  src={thumbnailUrl}
                  alt="YouTube thumbnail"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    transform: "scaleX(-1)" // Fix inversion
                  }}
                />
                {/* Play button overlay */}
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: "20px",
                  height: "20px",
                  backgroundColor: "rgba(255,0,0,0.8)",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontSize: "8px",
                  fontWeight: "bold"
                }}>
                  ▶
                </div>
              </>
            ) : (
              <div style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#ff0000",
                color: "white",
                fontSize: "8px",
                textAlign: "center"
              }}>
                YouTube<br/>Video
              </div>
            )}
          </div>
        </Html>
      </group>
    </>
  );
}

// Website Preview component for URL widgets
function WebsitePreview({ 
  url, 
  position, 
  index, 
  notes,
  widget,
  nodeLabel,
  editMode,
  onWidgetClick,
  onWidgetLongPress,
}: { 
  url: string; 
  position: [number, number, number]; 
  index: number;
  notes?: string;
  widget: Widget;
  nodeLabel: string;
  editMode: boolean;
  onWidgetClick: (widget: Widget) => void;
  onWidgetLongPress?: (widgetName: string, nodeLabel: string) => void;
}) {
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true); // Start visible by default
  const [imageError, setImageError] = useState(false);
  
  // Use the position passed from parent
  const imagePos: [number, number, number] = position;
  
  // Get preview image from widget's preview attribute
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!widget.preview) {
        setPreviewImageUrl(null);
        return;
      }

      // Use the same resolver as everywhere else so previews work from the selected data folder.
      const url = await resolveImageUrl(widget.preview);
      if (!cancelled) setPreviewImageUrl(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [widget.preview]);
  
  // Handle image loading
  const handleImageLoad = () => {
    console.log(`✅ Website preview loaded: ${url}`);
    setIsVisible(true);
    setImageError(false);
  };
  
  const handleImageError = () => {
    console.error(`❌ Failed to load website preview: ${url}`);
    setImageError(true);
  };
  
  // Handle visibility based on camera position
  const { camera } = useThree();
  useFrame(() => {
    if (!imageRef.current) return;
    
    // Calculate distance to camera
    const distance = new THREE.Vector3(...imagePos).distanceTo(camera.position);
    
    // Always show previews, with slight fade at distance
    if (distance < 50) {
      imageRef.current.style.opacity = "1";
    } else {
      imageRef.current.style.opacity = "0.5";
    }
  });
  
  // Open sidebar when clicked
  const openSidebar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shouldSuppressClick()) return;
    onWidgetClick(widget);
  };

  const { widgetLongPressHandlers, shouldSuppressClick } = useWidgetLongPress({
    editMode,
    widget,
    nodeLabel,
    onWidgetLongPress,
  });
  
  return (
    <>
      {/* Website Screenshot Preview */}
      <Html
        key={`website-${index}`}
        position={imagePos}
        transform
        occlude
        sprite
        zIndexRange={HTML_OVERLAY_Z_INDEX_RANGE}
      >
        <div 
          ref={imageRef}
          className="website-preview-container"
          style={{
            width: '120px',
            height: '80px',
            cursor: 'pointer',
            opacity: 1, // Start visible immediately
            transition: 'opacity 0.3s ease',
            borderRadius: '8px',
            overflow: 'hidden',
            border: '2px solid rgba(255, 255, 255, 0.8)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            background: 'rgba(255, 255, 255, 0.95)',
          }}
          {...widgetLongPressHandlers}
          onClick={openSidebar}
        >
          {previewImageUrl && !imageError ? (
            <img
              src={previewImageUrl}
              alt="Website preview"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '6px',
              }}
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              fontSize: '11px',
              textAlign: 'center',
              padding: '8px',
            }}>
              <div style={{ fontSize: '24px', marginBottom: '6px' }}>🌐</div>
              <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>Website</div>
              <div style={{ fontSize: '9px', opacity: 0.9, lineHeight: '1.2' }}>
                {url.length > 25 ? url.substring(8, 25) + '...' : url.replace(/^https?:\/\//, '')}
              </div>
              <div style={{ fontSize: '8px', opacity: 0.7, marginTop: '4px' }}>Click to open</div>
            </div>
          )}
          
          {/* Hover overlay */}
          <div 
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              color: 'white',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: 0,
              transition: 'opacity 0.2s ease',
              fontSize: '10px',
              textAlign: 'center',
              padding: '8px',
              borderRadius: '6px',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0';
            }}
          >
            <div style={{ fontSize: '14px', marginBottom: '4px' }}>🔗</div>
            <div>Open Website</div>
            {notes && (
              <div style={{ fontSize: '8px', marginTop: '4px', opacity: 0.8 }}>
                {notes.length > 40 ? `${notes.substring(0, 40)}...` : notes}
              </div>
            )}
          </div>
        </div>
      </Html>
    </>
  );
}

// Size of the widget image cube in world units
const CUBE_SIZE = 1.4;

// Textures for widget cubes are cached across mounts: re-entering the main
// view after opening a widget must not re-download (and possibly fail) images
// that were already decoded once.
const cubeTextureCache = new Map<string, THREE.Texture>();
const cubeTexturePending = new Map<string, Promise<THREE.Texture | null>>();

function imageFromObjectUrl(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = objectUrl;
  });
}

function imageFromCorsUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed'));
    img.src = url + (url.includes('?') ? '&' : '?') + 'cors=1';
  });
}

function makeTexture(img: HTMLImageElement): THREE.Texture {
  // Copy decoded pixels into an owned canvas before any temporary blob URL is
  // revoked. A cached HTMLImageElement may otherwise render blank when a new
  // WebGL renderer is created after leaving and returning to the graph.
  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const maxDimension = 2048;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas context unavailable');
  context.drawImage(img, 0, 0, canvas.width, canvas.height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

async function loadCubeTexture(resolvedUrl: string): Promise<THREE.Texture | null> {
  const cached = cubeTextureCache.get(resolvedUrl);
  if (cached) {
    cached.needsUpdate = true;
    return cached;
  }
  const pending = cubeTexturePending.get(resolvedUrl);
  if (pending) return pending;

  const task = (async (): Promise<THREE.Texture | null> => {
    const candidates: string[] = [resolvedUrl];
    const yt = resolvedUrl.match(/img\.youtube\.com\/vi\/([^/]+)\//);
    if (yt) {
      for (const variant of ['hqdefault.jpg', '0.jpg', 'default.jpg']) {
        const alt = `https://img.youtube.com/vi/${yt[1]}/${variant}`;
        if (!candidates.includes(alt)) candidates.push(alt);
      }
    }

    // Some museum CDNs serve the same URL with and without CORS headers
    // (their edge cache is poisoned by the plain <img> preview request), and
    // British Museum media has no CORS headers at all. Route those through our
    // own relay, and fall back to the relay for any URL that fails directly.
    const RELAY_HOSTS = [
      'https://media.britishmuseum.org/',
      'https://images.metmuseum.org/',
      'https://collectionapi.metmuseum.org/',
    ];
    const relay = async (url: string): Promise<THREE.Texture | null> => {
      try {
        const cloudUrl = import.meta.env.VITE_SUPABASE_URL;
        const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const response = await fetch(`${cloudUrl}/functions/v1/bm-museum`, {
          method: 'POST',
          headers: {
            apikey: publicKey,
            Authorization: `Bearer ${publicKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'image', url }),
        });
        if (!response.ok) return null;
        const objectUrl = URL.createObjectURL(await response.blob());
        try {
          return makeTexture(await imageFromObjectUrl(objectUrl));
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      } catch {
        return null;
      }
    };

    if (RELAY_HOSTS.some((host) => resolvedUrl.startsWith(host))) {
      const relayed = await relay(resolvedUrl);
      if (relayed) return relayed;
    }

    for (const url of candidates) {
      // Fetch the bytes ourselves and decode from a blob URL: loading via
      // <img crossOrigin="anonymous"> fails when the same URL was already
      // cached by a non-CORS request (the widget preview <img> tag).
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const objectUrl = URL.createObjectURL(await res.blob());
        try {
          const img = await imageFromObjectUrl(objectUrl);
          return makeTexture(img);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      } catch {
        try {
          return makeTexture(await imageFromCorsUrl(url));
        } catch {
          const relayed = await relay(url);
          if (relayed) return relayed;
        }
      }
    }

    return null;
  })();

  cubeTexturePending.set(resolvedUrl, task);
  const result = await task;
  cubeTexturePending.delete(resolvedUrl);
  if (result) cubeTextureCache.set(resolvedUrl, result);
  return result;
}


// Completely reworked Image Preview component
function ImagePreview({ 
  src, 
  position, 
  index, 
  notes,
  widget,
  nodeLabel,
  editMode,
  onWidgetClick,
  onWidgetLongPress,
}: { 
  src: string; 
  position: [number, number, number]; 
  index: number;
  notes?: string;
  widget: Widget;
  nodeLabel: string;
  editMode: boolean;
  onWidgetClick: (widget: Widget) => void;
  onWidgetLongPress?: (widgetName: string, nodeLabel: string) => void;
}) {
  const [fullscreenView, setFullscreenView] = useState(false);
  const imageRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true); // Start visible by default
  const [imageError, setImageError] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string>('');
  
  // Use the position passed from parent (already calculated symmetrically)
  const imagePos: [number, number, number] = position;
  
  // Resolve image path using the global resolver (works inside Canvas)
  // Re-resolve when global version changes (folder changed)
  const [version, setVersion] = useState(getGlobalVersion());
  
  useEffect(() => {
    const interval = setInterval(() => {
      const currentVersion = getGlobalVersion();
      if (currentVersion !== version) {
        setVersion(currentVersion);
        setResolvedUrl(''); // Clear to force reload
      }
    }, 100);
    return () => clearInterval(interval);
  }, [version]);
  
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const url = await resolveImageUrl(src);
      if (!cancelled) setResolvedUrl(url);
    };
    resolve();
    return () => { cancelled = true; };
  }, [src, version]);
  
  // Load the resolved image as a texture applied to all six cube faces
  const cubeRef = useRef<THREE.Mesh>(null);
  const [cubeTexture, setCubeTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!resolvedUrl) return;
    let cancelled = false;

    const cached = cubeTextureCache.get(resolvedUrl);
    if (cached) {
      cached.needsUpdate = true;
      setCubeTexture(cached);
      setImageError(false);
      setIsVisible(true);
      return;
    }

    loadCubeTexture(resolvedUrl).then((tex) => {
      if (cancelled) return;
      if (tex) {
        setCubeTexture(tex);
        setImageError(false);
        setIsVisible(true);
      } else {
        setImageError(true);
      }
    });

    return () => { cancelled = true; };
  }, [resolvedUrl]);



  // Textures are shared via cubeTextureCache — never disposed per-mount.

  // Gentle idle rotation so the cube reads as 3D
  useFrame((_, delta) => {
    if (cubeRef.current) cubeRef.current.rotation.y += delta * 0.3;
  });
  
  // Open side panel view  
  const openSidePanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shouldSuppressClick()) return;
    console.log("Opening side panel for:", resolvedUrl);
    // Pass the entire widget object to the handler
    onWidgetClick(widget);
  };

  const { widgetLongPressHandlers, shouldSuppressClick } = useWidgetLongPress({
    editMode,
    widget,
    nodeLabel,
    onWidgetLongPress,
  });
  
  // Close fullscreen view
  const closeFullscreen = () => {
    setFullscreenView(false);
  };
  
  return (
    <>
      {/* The widget image mapped onto every face of a cube */}
      <group position={imagePos}>
        <mesh
          ref={cubeRef as any}
          onClick={(e) => {
            e.stopPropagation();
            if (shouldSuppressClick()) return;
            onWidgetClick(widget);
          }}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[CUBE_SIZE, CUBE_SIZE, CUBE_SIZE]} />
          {cubeTexture ? (
            <meshBasicMaterial map={cubeTexture} toneMapped={false} />
          ) : (
            <meshBasicMaterial color={imageError ? "#d9d6c3" : "#6ec8ff"} toneMapped={false} />
          )}

        </mesh>
      </group>
      
      
      {/* Fullscreen view using portal */}
      {fullscreenView && createPortal(
        <div 
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "pointer",
          }}
          onClick={closeFullscreen}
        >
          <div 
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              position: "relative",
            }}
            onClick={e => e.stopPropagation()}
          >
            <img 
              src={resolvedUrl}
              alt="Fullscreen view"
              style={{
                maxWidth: "100%",
                maxHeight: "90vh",
                boxShadow: "0 0 30px rgba(0,0,0,0.8)"
              }}
            />
            <button
              style={{
                position: "absolute",
                top: "-40px",
                right: "0",
                background: "rgba(255,255,255,0.2)",
                color: "white",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                cursor: "pointer"
              }}
              onClick={closeFullscreen}
            >
              Close
            </button>
            <div style={{
              marginTop: "10px",
              color: "white",
              textAlign: "center",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}>
              {src}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Generate a consistent random 3D treasure icon for each node based on node ID
function getNodeGeometry(nodeId: string) {
  // Use node ID to generate consistent random choice
  const hash = nodeId.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  const treasureIndex = Math.abs(hash) % 20;
  
  switch (treasureIndex) {
    // Gold coins and doubloons
    case 0:
      return { geometry: <cylinderGeometry args={[0.8, 0.8, 0.15, 16]} />, name: "gold_coin" };
    case 1:
      return { geometry: <cylinderGeometry args={[0.6, 0.6, 0.1, 12]} />, name: "doubloon" };
    
    // Precious gems and jewels
    case 2:
      return { geometry: <octahedronGeometry args={[0.9]} />, name: "diamond" };
    case 3:
      return { geometry: <dodecahedronGeometry args={[0.7]} />, name: "ruby" };
    case 4:
      return { geometry: <icosahedronGeometry args={[0.8]} />, name: "emerald" };
    case 5:
      return { geometry: <tetrahedronGeometry args={[1.1]} />, name: "sapphire" };
    
    // Gold bars and ingots
    case 6:
      return { geometry: <boxGeometry args={[1.4, 0.4, 0.8]} />, name: "gold_bar" };
    case 7:
      return { geometry: <boxGeometry args={[1.0, 0.3, 0.6]} />, name: "silver_ingot" };
    
    // Pearls and orbs
    case 8:
      return { geometry: <sphereGeometry args={[0.7, 12, 8]} />, name: "pearl" };
    case 9:
      return { geometry: <sphereGeometry args={[0.9, 16, 12]} />, name: "crystal_orb" };
    
    // Treasure chests and containers
    case 10:
      return { geometry: <boxGeometry args={[1.2, 0.8, 0.9]} />, name: "treasure_chest" };
    case 11:
      return { geometry: <cylinderGeometry args={[0.6, 0.8, 1.0, 8]} />, name: "chalice" };
    
    // Jewelry and accessories
    case 12:
      return { geometry: <torusGeometry args={[0.7, 0.2, 8, 16]} />, name: "gold_ring" };
    case 13:
      return { geometry: <torusGeometry args={[0.9, 0.15, 12, 20]} />, name: "bracelet" };
    
    // Crowns and royal items
    case 14:
      return { geometry: <coneGeometry args={[0.8, 1.2, 6]} />, name: "crown" };
    case 15:
      return { geometry: <cylinderGeometry args={[0.4, 0.7, 1.5, 8]} />, name: "goblet" };
    
    // Medallions and tokens
    case 16:
      return { geometry: <cylinderGeometry args={[0.9, 0.9, 0.2, 8]} />, name: "medallion" };
    case 17:
      return { geometry: <cylinderGeometry args={[0.5, 0.5, 0.08, 16]} />, name: "token" };
    
    // Crystal formations and rare stones
    case 18:
      return { geometry: <coneGeometry args={[0.4, 1.8, 6]} />, name: "crystal_formation" };
    case 19:
      return { geometry: <torusKnotGeometry args={[0.5, 0.15, 32, 6]} />, name: "jeweled_ornament" };
    
    default:
      return { geometry: <cylinderGeometry args={[0.8, 0.8, 0.15, 16]} />, name: "gold_coin" };
  }
}

// Update the NodeMesh component to handle widgets as dictionaries with "name" attribute
function NodeMesh({ 
  node, 
  onClick, 
  isFocused = false,
  onWidgetClick,
  onWidgetLongPress,
  editMode = false,
  showOnlyFocusedWidgets = false,
  hideEmptyNodes = false,
  hideUnfocusedNodes = false,
  focusedNodeId,
  sidePanelOpen = false,
  fadeOpacity = 1,
  isSearchMatch = false,
  earthMode = false,
  showLabel = true
}: { 
  node: Node3D; 
  onClick: (id: string) => void;
  isFocused?: boolean;
  onWidgetClick: (widget: Widget, nodeLabel: string) => void;
  onWidgetLongPress?: (widgetName: string, nodeLabel: string) => void;
  editMode?: boolean;
  showOnlyFocusedWidgets?: boolean;
  hideEmptyNodes?: boolean;
  hideUnfocusedNodes?: boolean;
  focusedNodeId?: string | null;
  sidePanelOpen?: boolean;
  fadeOpacity?: number;
  isSearchMatch?: boolean;
  earthMode?: boolean;
  showLabel?: boolean;
}) {
  const earthOccluded = useEarthOcclusion(node.position, earthMode);
  const { theme } = useTheme();
  const isLight = theme === "light";
  const primary = "#F0EFCC"; // sand yellow
  const ring = "#F4F2BE"; // soft yellow glow
  const focusColor = "hsl(210 80% 90%)"; // Very light blue for focused nodes
  const focusEmissive = "hsl(210 70% 85%)"; // Light blue for glow effect
  const fadedColor = isLight ? "#e0e0e0" : "#555555";
  const fadedEmissive = isLight ? "#d0d0d0" : "#222222";
  const textColor = useCssHsl("--foreground", "hsl(222 47% 11%)");
  const weightN = normalizeWeight(node.weight);
  const depth = Math.max(0, node.position[2] / 6);
  const size = (0.35 + weightN * 0.6) / 5; // base by weight (heavier = larger), scaled down 5x
  const scale = size / (1 + depth * 0.25); // smaller with distance

  // Prefer node.icon as the displayed image; fall back to legacy "label-is-an-image" behavior.
  const imagePath = typeof node.icon === "string" && node.icon.length > 0 ? node.icon : (isValidImageUrl(node.label) ? node.label : "");
  
  // Check if this is already a full URL (http/https/blob)
  const isFullUrl = imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('blob:');
  
  // Debug: log when a node has an icon
  useEffect(() => {
    if (node.icon) {
      console.log(`Node "${node.label}" has icon: "${node.icon}", imagePath: "${imagePath}", isFullUrl: ${isFullUrl}`);
    }
  }, [node.icon, node.label, imagePath, isFullUrl]);

  // Track global cache version so textures update when the data folder changes.
  const [assetVersion, setAssetVersion] = useState(getGlobalVersion());
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const v = getGlobalVersion();
      setAssetVersion((prev) => (prev !== v ? v : prev));
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // If there's no image path at all, don't try to resolve
      if (!imagePath) {
        setResolvedImageUrl(null);
        return;
      }
      
      // If it's already a full URL, use it directly
      if (isFullUrl) {
        console.log(`Using direct URL for node "${node.label}": ${imagePath}`);
        if (!cancelled) setResolvedImageUrl(imagePath);
        return;
      }
      
      // Otherwise, try to resolve the local file path from the data folder
      try {
        const url = await resolveImageUrl(imagePath);
        console.log(`Resolved local path "${imagePath}" to: ${url}`);
        if (!cancelled) setResolvedImageUrl(url);
      } catch (err) {
        console.warn(`Failed to resolve image path: ${imagePath}`, err);
        if (!cancelled) setResolvedImageUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imagePath, isFullUrl, assetVersion, node.label]);

  // Track texture loading state
  const [textureLoaded, setTextureLoaded] = useState(false);
  const [imageTexture, setImageTexture] = useState<THREE.Texture | null>(null);
  
  useEffect(() => {
    if (!resolvedImageUrl) {
      setImageTexture(null);
      setTextureLoaded(false);
      return;
    }
    
    console.log(`Loading texture for node ${node.id} (${node.label}) from: ${resolvedImageUrl}`);
    setTextureLoaded(false);
    let cancelled = false;
    
    const loadTexture = async () => {
      try {
        // For blob URLs and data URLs, load directly
        if (resolvedImageUrl.startsWith('blob:') || resolvedImageUrl.startsWith('data:')) {
          const img = new Image();
          img.src = resolvedImageUrl;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
          });
          
          if (cancelled) return;
          
          const texture = new THREE.Texture(img);
          texture.flipY = true;
          texture.needsUpdate = true;
          texture.colorSpace = THREE.SRGBColorSpace;
          console.log(`✅ Texture created from blob/data URL for node ${node.id} (${node.label})`);
          setImageTexture(texture);
          setTextureLoaded(true);
          return;
        }
        
        // For http(s) URLs: fetch the bytes ourselves and decode from a blob URL.
        // Loading via <img crossOrigin="anonymous"> can fail when the same URL was
        // already cached by a non-CORS request (e.g. a widget <img> tag), because the
        // cached response has no CORS headers and the browser rejects the reuse.
        const loadViaFetch = async (): Promise<HTMLImageElement> => {
          const res = await fetch(resolvedImageUrl, { mode: 'cors', credentials: 'omit' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          try {
            const el = new Image();
            await new Promise<void>((resolve, reject) => {
              el.onload = () => resolve();
              el.onerror = () => reject(new Error('Blob decode failed'));
              el.src = objectUrl;
            });
            return el;
          } finally {
            setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
          }
        };

        const loadViaImgTag = async (): Promise<HTMLImageElement> => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          // Cache-bust so we never reuse a non-CORS cached response.
          const busted = resolvedImageUrl + (resolvedImageUrl.includes('?') ? '&' : '?') + 'cors=1';
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = busted;
          });
          return img;
        };

        let loadedImg: HTMLImageElement;
        try {
          loadedImg = await loadViaFetch();
        } catch {
          loadedImg = await loadViaImgTag();
        }

        
        if (cancelled) return;
        
        const texture = new THREE.Texture(loadedImg);
        texture.flipY = true;
        texture.needsUpdate = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        console.log(`✅ Texture created successfully for node ${node.id} (${node.label})`);
        setImageTexture(texture);
        setTextureLoaded(true);
        
      } catch (err) {
        if (cancelled) return;
        
        console.warn(`Direct load failed for ${resolvedImageUrl}, trying CORS proxy...`);
        
        // Try using a CORS proxy as fallback
        try {
          const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(resolvedImageUrl)}`;
          const img = new Image();
          img.crossOrigin = 'anonymous';
          
          const loadPromise = new Promise<HTMLImageElement>((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Proxy load failed'));
          });
          
          img.src = proxyUrl;
          
          const loadedImg = await loadPromise;
          
          if (cancelled) return;
          
          const texture = new THREE.Texture(loadedImg);
          texture.flipY = true;
          texture.needsUpdate = true;
          texture.colorSpace = THREE.SRGBColorSpace;
          console.log(`✅ Texture created via CORS proxy for node ${node.id} (${node.label})`);
          setImageTexture(texture);
          setTextureLoaded(true);
          
        } catch (proxyErr) {
          if (cancelled) return;
          console.error(`❌ Failed to load texture for node ${node.id} (${node.label}):`, proxyErr);
          console.error(`URL was: ${resolvedImageUrl}`);
          setImageTexture(null);
          setTextureLoaded(false);
        }
      }
    };
    
    loadTexture();
    
    return () => {
      cancelled = true;
      // Cleanup: dispose of texture when component unmounts or URL changes
      setImageTexture((prev) => {
        if (prev) {
          prev.dispose();
        }
        return null;
      });
    };
  }, [resolvedImageUrl, node.id, node.label]);
  
  // Get the 3D geometry for this node (used as fallback when no image)
  const nodeShape = useMemo(() => getNodeGeometry(node.id), [node.id]);
  
  // Only use image texture if it's fully loaded
  const showImageTexture = Boolean(imageTexture && textureLoaded);
  
  // Debug log the showImageTexture state
  
  // Hover state for showing prose text
  const [isHovered, setIsHovered] = useState(false);

  // Add slight pulsing effect for focused node
  const [pulseScale, setPulseScale] = useState(1);
  const searchGlowRef = useRef<THREE.Mesh>(null);
  const searchGlowGroupRef = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useFrame(({ clock, camera, size }) => {


    if (isFocused) {
      setPulseScale(1 + Math.sin(clock.getElapsedTime() * 3) * 0.05);
    } else if (pulseScale !== 1) {
      setPulseScale(1);
    }
    if (isSearchMatch && searchGlowRef.current) {
      const t = clock.getElapsedTime();
      const p = 1 + Math.sin(t * 4) * 0.18;
      searchGlowRef.current.scale.setScalar(p);
      const mat = searchGlowRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.3 + (Math.sin(t * 4) + 1) * 0.18;

      // Keep the ball a constant size on screen (~1/20 of the canvas width).
      if (searchGlowGroupRef.current) {
        const worldPos = searchGlowGroupRef.current.getWorldPosition(new THREE.Vector3());
        const dist = camera.position.distanceTo(worldPos);
        const persp = camera as THREE.PerspectiveCamera;
        const fov = ((persp.fov ?? 50) * Math.PI) / 180;
        const visibleHeight = 2 * Math.tan(fov / 2) * Math.max(dist, 0.001);
        const targetPx = size.width / 20;
        const worldDiameter = visibleHeight * (targetPx / Math.max(size.height, 1));
        const parentScale = pulseScale;
        searchGlowGroupRef.current.scale.setScalar(
          worldDiameter / 2 / Math.max(parentScale, 0.0001),
        );
      }
    }
  });

  
  // Debug widgets
  
  // Helper function to detect YouTube URLs
  const isYouTubeUrl = (url: string) => {
    return url.includes('youtube.com/watch') || 
           url.includes('youtu.be/') || 
           url.includes('youtube.com/embed/') ||
           url.includes('youtube.com/v/');
  };

  // Helper function to get YouTube video ID
  const getYouTubeVideoId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };

  // Show ALL widgets, not just images or videos
  const allWidgets = node.widgets?.filter(widget => widget && widget.name) || [];
  
  // Determine if widgets should be visible
  const shouldShowWidgets = (!showOnlyFocusedWidgets || (showOnlyFocusedWidgets && node.id === focusedNodeId)) && !earthOccluded;

  // In the "hide empty nodes" focus levels, nodes with an empty widgets array disappear entirely
  if (hideEmptyNodes && !(node.widgets && node.widgets.length > 0)) return null;
  // Rightmost focus level: only the focused node remains visible
  if (hideUnfocusedNodes && focusedNodeId && node.id !== focusedNodeId) return null;
  
  return (
    <group 
      position={node.position} 
      visible={!earthOccluded}
      onClick={(e) => { e.stopPropagation(); if (earthOccluded) return; onClick(node.id); }}
      onPointerOver={(e) => { e.stopPropagation(); if (!earthOccluded) setIsHovered(true); }}
      onPointerOut={() => setIsHovered(false)}
      scale={[pulseScale, pulseScale, pulseScale]}
    >
      {/* Main node with random 3D geometry or image texture */}
      {/* Use key to force re-render when switching between texture and geometry */}
      <mesh 
        key={`${node.id}-${showImageTexture ? 'image' : 'geo'}`}
        castShadow 
        receiveShadow 
        scale={[scale, scale, scale]}
      >
        {showImageTexture ? (
          // Use a plane geometry for image nodes
          <planeGeometry args={[2, 2]} />
        ) : (
          nodeShape.geometry
        )}
        {showImageTexture && imageTexture ? (
          <meshBasicMaterial
            map={imageTexture}
            transparent
            opacity={(isFocused ? 1.0 : 0.9) * fadeOpacity}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        ) : (
          <meshPhysicalMaterial
            color={fadeOpacity < 0.5 ? fadedColor : (isFocused ? focusColor : "#ffffff")}
            emissive={isFocused ? "hsl(220 100% 50%)" : "#ffffff"}
            emissiveIntensity={isFocused ? 0.5 : 0.05}
            metalness={0}
            roughness={0.15}
            transmission={0.85}
            thickness={0.6}
            ior={1.3}
            transparent
            opacity={(isFocused ? 0.55 : 0.35) * fadeOpacity}
            depthWrite={false}
          />

        )}
      </mesh>
      
      {/* Glow halo for focused nodes */}
      {isFocused && fadeOpacity > 0.5 && (
        <mesh scale={[scale * 3.4, scale * 3.4, scale * 3.4]}>
          <sphereGeometry args={[1, 16, 16]} />
          <meshBasicMaterial 
            color="hsl(220 100% 60%)"
            transparent
            opacity={0.22 * fadeOpacity}
            side={2} // DoubleSide
          />
        </mesh>
      )}

      {/* Pulsating glow for search matches */}
      {isSearchMatch && (
        <group ref={searchGlowGroupRef}>
          <mesh ref={searchGlowRef}>
            <sphereGeometry args={[1, 24, 24]} />
            <meshBasicMaterial
              color="#f97316"
              transparent
              opacity={0.4}
              depthWrite={false}
              side={THREE.BackSide}
              toneMapped={false}
            />
          </mesh>
        </group>
      )}
      {(isHovered || isFocused) && showLabel && !sidePanelOpen && !earthOccluded && fadeOpacity > 0.1 && (
      <Html center zIndexRange={HTML_OVERLAY_Z_INDEX_RANGE} style={{ pointerEvents: "none", opacity: fadeOpacity }}>
        <div ref={labelRef} style={{
          transformOrigin: "center center",
          background: isFocused ? "rgba(30, 144, 255, 0.8)" : "hsl(var(--card) / 0.8)",

          color: isFocused ? "white" : textColor,
          border: isFocused ? "1px solid rgba(135, 206, 250, 0.8)" : "1px solid hsl(var(--border))",
          borderRadius: 8,
          padding: "2px 6px",
          fontSize: 12,
          whiteSpace: "nowrap",
          fontWeight: isFocused ? "bold" : "normal",
          boxShadow: isFocused ? "0 0 8px rgba(30, 144, 255, 0.5)" : "none",
        }}>
          {node.label}
        </div>
      </Html>
      )}
      
      {/* Hover tooltip showing prose text */}
      {isHovered && isFocused && !earthOccluded && node.prose && (
        <Html
          position={[0, 0, 0]}
          transform={false}
          zIndexRange={HTML_OVERLAY_Z_INDEX_RANGE}
          style={{
            pointerEvents: "none",
            transform: "translate(-420px, -140px)",
          }}
        >
          <div style={{
            background: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 13,
            width: "40ch",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          }}>
            {node.prose}
          </div>
        </Html>
      )}
      
      {/* Render widget previews symmetrically around the node */}
      {shouldShowWidgets && !sidePanelOpen && allWidgets.map((widget, index) => {
        // Rings: ring N (1-based) holds 8N widgets at radius N*R
        const baseRadius = 2.0;
        let ring = 0; // 0-based
        let capacity = 8;
        let indexInRing = index;
        while (indexInRing >= capacity) {
          indexInRing -= capacity;
          ring += 1;
          capacity = 8 * (ring + 1);
        }
        const countInRing = Math.min(capacity, allWidgets.length - (index - indexInRing));
        const radius = baseRadius * (ring + 1);
        const angle = (indexInRing / countInRing) * Math.PI * 2 + ring * (Math.PI / countInRing);
        const widgetPosition: [number, number, number] = [
          Math.cos(angle) * radius,
          Math.sin(angle) * radius,
          0 
        ];

        
        // Extract the widget name from the widget object - widgets are now always objects  
        const widgetSrc = widget.name;
        
        // Extract notes from widget object
        const widgetNotes = widget.notes || '';
        
        // Check if it's a YouTube video, website URL, or image
        const isYoutube = isYouTubeUrl(widgetSrc);
        const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(widgetSrc);
        const isWebsiteUrl = (widgetSrc.startsWith('http://') || widgetSrc.startsWith('https://')) && !isImageUrl;
        
        // Create a wrapper that includes the node label
        const handleWidgetClickWithLabel = (w: Widget) => onWidgetClick(w, node.label);
        
        if (isYoutube) {
          return (
            <YouTubePreview 
              key={`${node.id}-youtube-${index}`}
              url={widgetSrc} 
              position={widgetPosition} 
              index={index}
              notes={widgetNotes}
              widget={widget}
              nodeLabel={node.label}
              editMode={editMode}
              onWidgetClick={handleWidgetClickWithLabel}
              onWidgetLongPress={onWidgetLongPress}
            />
          );
        } else if (isWebsiteUrl && !isYoutube) {
          return (
            <WebsitePreview 
              key={`${node.id}-website-${index}`}
              url={widgetSrc} 
              position={widgetPosition} 
              index={index}
              notes={widgetNotes}
              widget={widget}
              nodeLabel={node.label}
              editMode={editMode}
              onWidgetClick={handleWidgetClickWithLabel}
              onWidgetLongPress={onWidgetLongPress}
            />
          );
        } else {
          return (
            <ImagePreview 
              key={`${node.id}-img-${index}-${widgetSrc}`}
              src={widgetSrc} 
              position={widgetPosition} 
              index={index}
              notes={widgetNotes}
              widget={widget}
              nodeLabel={node.label}
              editMode={editMode}
              onWidgetClick={handleWidgetClickWithLabel}
              onWidgetLongPress={onWidgetLongPress}
            />
          );
        }
      })}
    </group>
  );
}

// Frames the whole globe on first render in Earth mode
function EarthInitialView({ controlsRef }: { controlsRef: React.RefObject<any> }) {
  const { camera } = useThree();
  const frames = useRef(0);
  const released = useRef(false);

  const apply = () => {
    const cam = camera as THREE.PerspectiveCamera;
    // Back the camera off far enough that the whole globe fits the viewport,
    // taking the narrower of the vertical/horizontal fields of view into account.
    const aspect = cam.aspect || 1;
    const halfV = ((cam.fov || 50) * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const distance = (EARTH_RADIUS / Math.sin(Math.max(0.05, Math.min(halfV, halfH)))) * 1.08;
    const [x, y, z] = geoToCartesian([33.0286, 35.0586, distance]);
    cam.position.set(x, y, z);
    cam.near = 0.1;
    cam.far = 100000;
    cam.updateProjectionMatrix();
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
    cam.lookAt(0, 0, 0);
  };

  useEffect(() => {
    apply();
    const controls = controlsRef.current;
    const release = () => { released.current = true; };
    controls?.addEventListener?.("start", release);
    return () => controls?.removeEventListener?.("start", release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controlsRef]);

  // Keep enforcing for the first frames: other init code can move the camera
  useFrame(() => {
    if (released.current || frames.current > 30) return;
    frames.current += 1;
    apply();
  });


  return null;
}


// Custom OrbitControls hook to refine controls
function useCustomOrbitControls(controlsRef: React.RefObject<any>) {
  const { camera, gl } = useThree();
  
  useEffect(() => {
    if (!controlsRef.current) return;
    
    // Set initial position for better viewing
    camera.position.set(0, 5, -15);
    camera.lookAt(0, 0, 0);
    
    // Enhance control behavior
    const controls = controlsRef.current;
    controls.update();
    
    // Constrain vertical rotation to avoid upside-down view
    controls.minPolarAngle = Math.PI * 0.1;
    controls.maxPolarAngle = Math.PI * 0.8;
    
    // Add event listeners for zoom
    const handleWheel = (e: WheelEvent) => {
      // Smooth zoom sensitivity
      const zoomFactor = e.deltaY * 0.005;
      camera.position.z += zoomFactor;
      camera.position.z = Math.max(2, Math.min(camera.position.z, 30));
      controls.update();
    };
    
    gl.domElement.addEventListener('wheel', handleWheel, { passive: true });
    
    return () => {
      gl.domElement.removeEventListener('wheel', handleWheel);
    };
  }, [camera, gl, controlsRef]);
}

// Component to render an edge with tapered thickness based on node weights
function TaperedEdge({ 
  sourcePos, 
  targetPos, 
  sourceWeight,
  targetWeight,
  color, 
  opacity, 
  isFocused,
  onClick,
}: {
  sourcePos: [number, number, number];
  targetPos: [number, number, number];
  sourceWeight?: number;
  targetWeight?: number;
  color: string;
  opacity: number;
  isFocused: boolean;
  onClick?: () => void;
}) {

  // Calculate line thickness based on node weights
  const sourceThickness = normalizeWeight(sourceWeight) * 0.35 + 0.01; 
  const targetThickness = normalizeWeight(targetWeight) * 0.35 + 0.01; 
  
  // Create tapered line geometry
  const segments = 20; // Number of segments for smooth tapering
  const points = [];
  const radii = [];
  
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Interpolate position along the line from source to target
    points.push(new THREE.Vector3(
      sourcePos[0] + (targetPos[0] - sourcePos[0]) * t,
      sourcePos[1] + (targetPos[1] - sourcePos[1]) * t,
      sourcePos[2] + (targetPos[2] - sourcePos[2]) * t
    ));
    // Interpolate thickness from source to target
    const thickness = sourceThickness + (targetThickness - sourceThickness) * t;
    radii.push(thickness * (isFocused ? 2 : 1));
  }
  
  // Create tube geometry for tapered line
  const curve = new THREE.CatmullRomCurve3(points);
  const tubeGeometry = new THREE.TubeGeometry(curve, segments, 0.1, 8, false);
  
  // Modify the tube geometry to have variable radius
  const positionAttribute = tubeGeometry.attributes.position;
  for (let i = 0; i < positionAttribute.count; i++) {
    const segmentIndex = Math.floor(i / 9); // 9 vertices per ring (8 sides + center)
    const radius = radii[Math.min(segmentIndex, radii.length - 1)] || 0.05;
    
    // Get the vertex position
    const x = positionAttribute.getX(i);
    const y = positionAttribute.getY(i);
    const z = positionAttribute.getZ(i);
    
    // Calculate distance from the curve center for this vertex
    const segmentT = segmentIndex / segments;
    const curvePoint = curve.getPoint(segmentT);
    const dx = x - curvePoint.x;
    const dy = y - curvePoint.y;
    const dz = z - curvePoint.z;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Scale the vertex position based on the desired radius
    if (distFromCenter > 0) {
      const scale = radius / 0.1; // 0.1 is the default tube radius
      positionAttribute.setXYZ(i,
        curvePoint.x + dx * scale,
        curvePoint.y + dy * scale,
        curvePoint.z + dz * scale
      );
    }
  }
  
  positionAttribute.needsUpdate = true;
  tubeGeometry.computeVertexNormals();
  
  return (
    <mesh onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}>
      <primitive object={tubeGeometry} />
      <meshStandardMaterial 
        color={color}
        transparent 
        opacity={opacity}
        metalness={0.2}
        roughness={0.8}
      />
    </mesh>
  );
}

// Evaluate a quadratic bezier at parameter t
function quadBezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number): THREE.Vector3 {
  const mt = 1 - t;
  return new THREE.Vector3(
    mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    mt * mt * p0.z + 2 * mt * t * p1.z + t * t * p2.z,
  );
}

// Tangent of quadratic bezier at parameter t
function quadBezierTangent(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number): THREE.Vector3 {
  const mt = 1 - t;
  return new THREE.Vector3(
    2 * mt * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    2 * mt * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
    2 * mt * (p1.z - p0.z) + 2 * t * (p2.z - p1.z),
  ).normalize();
}

// Road mesh component - curved road connecting two nodes via quadratic bezier
function RoadMesh({
  sourcePos,
  targetPos,
  sourceWeight,
  targetWeight,
  planeNormal,
  maxSourceWidth,
  maxTargetWidth,
  curveControl,
  arrowsReversed,
  onClick,
}: {
  sourcePos: [number, number, number];
  targetPos: [number, number, number];
  sourceWeight?: number;
  targetWeight?: number;
  planeNormal?: THREE.Vector3;
  maxSourceWidth?: number;
  maxTargetWidth?: number;
  curveControl?: THREE.Vector3;
  arrowsReversed?: boolean;
  onClick?: () => void;
}) {
  const { theme } = useTheme();
  const isLight = theme === "light";
  const roadSurfaceColor = isLight ? "#c0c0c0" : "#2a2a2a";
  const edgeLineColor = isLight ? "#66aaff" : "#0088ff";
  const arrowColor = isLight ? "#aaddff" : "#99ddff";
  const { roadGeo, edgeGeoLeft, edgeGeoRight, arrowGeos } = useMemo(() => {
    let srcW = normalizeWeight(sourceWeight) * 0.5 + 0.12;
    let tgtW = normalizeWeight(targetWeight) * 0.5 + 0.12;

    if (maxSourceWidth !== undefined) srcW = Math.min(srcW, maxSourceWidth);
    if (maxTargetWidth !== undefined) tgtW = Math.min(tgtW, maxTargetWidth);

    const src = new THREE.Vector3(...sourcePos);
    const tgt = new THREE.Vector3(...targetPos);
    const ctrl = curveControl || new THREE.Vector3().lerpVectors(src, tgt, 0.5);

    const segments = 24;
    const normal = planeNormal || new THREE.Vector3(0, 1, 0);

    const centerPoints: THREE.Vector3[] = [];
    const perps: THREE.Vector3[] = [];
    const widths: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const pt = quadBezier(src, ctrl, tgt, t);
      const tan = quadBezierTangent(src, ctrl, tgt, t);
      let perp = new THREE.Vector3().crossVectors(tan, normal).normalize();
      if (perp.lengthSq() < 0.001) {
        const fallback = Math.abs(tan.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        perp = new THREE.Vector3().crossVectors(tan, fallback).normalize();
      }
      centerPoints.push(pt);
      perps.push(perp);
      widths.push(srcW + (tgtW - srcW) * t);
    }

    // Build road surface
    const roadVerts: number[] = [];
    for (let i = 0; i < segments; i++) {
      const p0 = centerPoints[i];
      const p1 = centerPoints[i + 1];
      const pr0 = perps[i];
      const pr1 = perps[i + 1];
      const w0 = widths[i];
      const w1 = widths[i + 1];
      const l0 = p0.clone().add(pr0.clone().multiplyScalar(w0 / 2));
      const r0 = p0.clone().sub(pr0.clone().multiplyScalar(w0 / 2));
      const l1 = p1.clone().add(pr1.clone().multiplyScalar(w1 / 2));
      const r1 = p1.clone().sub(pr1.clone().multiplyScalar(w1 / 2));
      roadVerts.push(
        l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, r1.x, r1.y, r1.z,
        l0.x, l0.y, l0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z,
      );
    }
    const roadG = new THREE.BufferGeometry();
    roadG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(roadVerts), 3));
    roadG.computeVertexNormals();

    // Edge lines (glowing blue sidelines) along curve
    const edgeOffset = normal.clone().multiplyScalar(0.02);
    const edgeW = 0.04;
    const makeEdgeGeo = (side: number) => {
      const ev: number[] = [];
      for (let i = 0; i < segments; i++) {
        const p0 = centerPoints[i].clone().add(edgeOffset);
        const p1 = centerPoints[i + 1].clone().add(edgeOffset);
        const pr0 = perps[i];
        const pr1 = perps[i + 1];
        const w0 = widths[i];
        const w1 = widths[i + 1];
        const ea0 = p0.clone().add(pr0.clone().multiplyScalar(side * w0 / 2));
        const ea1 = ea0.clone().add(pr0.clone().multiplyScalar(side * edgeW));
        const eb0 = p1.clone().add(pr1.clone().multiplyScalar(side * w1 / 2));
        const eb1 = eb0.clone().add(pr1.clone().multiplyScalar(side * edgeW));
        ev.push(
          ea0.x, ea0.y, ea0.z, ea1.x, ea1.y, ea1.z, eb1.x, eb1.y, eb1.z,
          ea0.x, ea0.y, ea0.z, eb1.x, eb1.y, eb1.z, eb0.x, eb0.y, eb0.z,
        );
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ev), 3));
      g.computeVertexNormals();
      return g;
    };

    // Build arrow chevrons pointing toward the target (child), visible on both sides
    const arrowGeos: THREE.BufferGeometry[] = [];
    const arrowCount = Math.max(3, Math.floor(segments / 4));
    for (let a = 0; a < arrowCount; a++) {
      const t = 0.1 + (a / arrowCount) * 0.8; // spread from 10% to 90% along curve
      const idx = Math.round(t * segments);
      const clamped = Math.min(idx, segments);
      const tanRaw = quadBezierTangent(src, ctrl, tgt, t).normalize();
      const tan = arrowsReversed ? tanRaw.negate() : tanRaw;
      const perp = perps[clamped];
      const w = widths[clamped] * 0.4; // arrow spans 80% of road width
      const arrowLen = w * 1.4; // longer arrows

      // Create arrow on both sides of the road surface
      for (const sideSign of [1, -1]) {
        const nOffset = normal.clone().multiplyScalar(0.025 * sideSign);
        const pt = centerPoints[clamped].clone().add(nOffset);

        const tip = pt.clone().add(tan.clone().multiplyScalar(arrowLen * 0.5));
        const backL = pt.clone().sub(tan.clone().multiplyScalar(arrowLen * 0.5)).add(perp.clone().multiplyScalar(w));
        const backR = pt.clone().sub(tan.clone().multiplyScalar(arrowLen * 0.5)).sub(perp.clone().multiplyScalar(w));

        // Simple triangle - just the arrowhead, no stem
        const av: number[] = [];
        av.push(tip.x, tip.y, tip.z, backL.x, backL.y, backL.z, backR.x, backR.y, backR.z);

        const ag = new THREE.BufferGeometry();
        ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(av), 3));
        ag.computeVertexNormals();
        arrowGeos.push(ag);
      }
    }

    return {
      roadGeo: roadG,
      edgeGeoLeft: makeEdgeGeo(1),
      edgeGeoRight: makeEdgeGeo(-1),
      arrowGeos,
    };
  }, [sourcePos, targetPos, sourceWeight, targetWeight, planeNormal, maxSourceWidth, maxTargetWidth, curveControl, arrowsReversed]);

  return (
    <group onClick={onClick ? (e: any) => { e.stopPropagation(); onClick(); } : undefined}>
      <mesh geometry={roadGeo}>
        <meshStandardMaterial color={roadSurfaceColor} roughness={0.95} metalness={0.05} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={edgeGeoLeft}>
        <meshStandardMaterial color={edgeLineColor} roughness={0.3} side={THREE.DoubleSide} emissive={edgeLineColor} emissiveIntensity={0.6} />
      </mesh>
      <mesh geometry={edgeGeoRight}>
        <meshStandardMaterial color={edgeLineColor} roughness={0.3} side={THREE.DoubleSide} emissive={edgeLineColor} emissiveIntensity={0.6} />
      </mesh>
      {arrowGeos.map((ag, i) => (
        <mesh key={`arrow-${i}`} geometry={ag}>
          <meshStandardMaterial color={arrowColor} roughness={0.4} side={THREE.DoubleSide} emissive={arrowColor} emissiveIntensity={0.5} transparent opacity={0.75} />
        </mesh>
      ))}
    </group>
  );
}

// src/components/Graph3D.tsx - update the GraphScene component
function GraphScene({ data }: { data: KnowledgeNode }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [selectedWidget, setSelectedWidget] = useState<Widget | null>(null);
  const [showOnlyFocusedWidgets] = useState(false); // Show all widgets by default
  const [hideEmptyNodes] = useState(false);
  const { nodes, edges } = useMemo(() => build3DLayout(data), [data]);
  const idToNode = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();
  
  // Get the current focus from context
  const { focusedNodeLabel, setFocusedNodeLabel, focusSource, setFocusSource, setDfsIndexByLabel } = useFocus();
  
  // Create a map of node labels to IDs for quick lookup
  const labelToId = useMemo(() => {
    const map = new Map<string, string>();
    nodes.forEach(node => map.set(node.label, node.id));
    return map;
  }, [nodes]);
  
  // Listen for changes to focusedNodeLabel and update the 3D focus when coming from 2D view
  useEffect(() => {
    if (focusedNodeLabel) {
      const matchingId = labelToId.get(focusedNodeLabel);
      if (matchingId) {
        setFocusId(matchingId);
      }
    } else {
      setFocusId(null);
    }
  }, [focusedNodeLabel, labelToId]);
  
  // Update the node click handler
  const handleNodeClick = (id: string) => {
    const clickedNode = idToNode.get(id);
    if (!clickedNode) return;
    
    // Toggle focus state
    if (focusId === id) {
      setFocusId(null);
      setFocusedNodeLabel(null);
      setFocusSource(null);
    } else {
      setFocusId(id);
      setFocusedNodeLabel(clickedNode.label);
      setFocusSource('graph3d');
      // Set DFS to resume from this node
      setDfsIndexByLabel(clickedNode.label);
    }
  };

  // Handle widget clicks
  const handleWidgetClick = (widget: Widget, nodeLabel: string) => {
    // Focus the node that owns this widget
    if (nodeLabel) {
      const owner = nodes.find(n => n.label === nodeLabel);
      if (owner) {
        setFocusId(owner.id);
        setFocusedNodeLabel(owner.label);
        setFocusSource('graph3d');
        setDfsIndexByLabel(owner.label);
      }
    }
    // Open side panel for all widgets (including URLs)
    setSelectedWidget(widget);
    setSidePanelOpen(true);
  };
  
  // Handle focus animation when node is clicked
  const initialFocusSkipped = useRef(false);
  useEffect(() => {
    // In Earth mode keep the initial wide view of the globe instead of
    // immediately flying to the auto-focused root node.
    if (!initialFocusSkipped.current) {
      initialFocusSkipped.current = true;
      if (getGraphSpace(data) === "Earth") return;
    }
    if (focusId && controlsRef.current) {
      const focusedNode = nodes.find(n => n.id === focusId);
      if (focusedNode) {
        // Get node position
        const nodePos = focusedNode.position;
        
        // Store original camera position and rotation
        const startPos = camera.position.clone();
        const startTarget = controlsRef.current.target.clone();
        
        // Calculate target position (we want to be at a slight offset from the node)
        const targetDistance = 6; // Distance from node to camera
        
        // Direction from node to current camera (normalized)
        const dir = new THREE.Vector3()
          .subVectors(startPos, new THREE.Vector3(...nodePos))
          .normalize();
        
        // Calculate target camera position
        const targetPos = new THREE.Vector3(
          nodePos[0] + dir.x * targetDistance,
          nodePos[1] + dir.y * targetDistance,
          nodePos[2] + dir.z * targetDistance
        );
        
        // Animate to target
        let startTime = Date.now();
        const duration = 1000; // Animation duration in ms
        
        function animate() {
          const now = Date.now();
          const elapsed = now - startTime;
          const progress = Math.min(1, elapsed / duration);
          
          // Ease function (cubic ease in/out)
          const ease = progress < 0.5 
            ? 4 * progress * progress * progress 
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
          
          // Interpolate camera position
          camera.position.set(
            startPos.x + (targetPos.x - startPos.x) * ease,
            startPos.y + (targetPos.y - startPos.y) * ease,
            startPos.z + (targetPos.z - startPos.z) * ease
          );
          
          // Interpolate orbit controls target (what the camera looks at)
          controlsRef.current.target.set(
            startTarget.x + (nodePos[0] - startTarget.x) * ease,
            startTarget.y + (nodePos[1] - startTarget.y) * ease,
            startTarget.z + (nodePos[2] - startTarget.z) * ease
          );
          
          controlsRef.current.update();
          
          if (progress < 1) {
            requestAnimationFrame(animate);
          }
        }
        
        animate();
      }
    }
  }, [focusId, nodes, camera]);
  
  // Get colors from CSS variables
  const muted = "#3b82f6"; // Blue color for edges
  const focusedEdgeColor = "#1d4ed8"; // Darker blue for focused edges
  
  return (
    <>
      <ambientLight intensity={0.6} />
      {getGraphSpace(data) === "Earth" && <EarthSphere />}
      {getGraphSpace(data) === "Earth" && <EarthInitialView controlsRef={controlsRef} />}

      <directionalLight position={[5, 7, -5]} intensity={0.5} />
      
      <OrbitControls
        ref={controlsRef}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={0.05}
        maxDistance={200000}
        dampingFactor={0.1}
        rotateSpeed={0.7}
        panSpeed={0.5}
        zoomSpeed={1.0}
        makeDefault
      />
      
      {/* Render edges connecting nodes with tapered thickness */}
      {edges.map((e, idx) => {
        const sourceNode = idToNode.get(e.source);
        const targetNode = idToNode.get(e.target);
        if (!sourceNode || !targetNode) return null;
        
        const isFocusedEdge = focusId === e.source || focusId === e.target;
        const lineColor = isFocusedEdge ? focusedEdgeColor : muted;
        
        return (
          <TaperedEdge
            key={`edge-${idx}`}
            sourcePos={sourceNode.position}
            targetPos={targetNode.position}
            sourceWeight={sourceNode.weight}
            targetWeight={targetNode.weight}
            color={lineColor}
            opacity={isFocusedEdge ? 0.7 : 0.3}
            isFocused={isFocusedEdge}
          />
        );
      })}
      
      {nodes.map((n) => (
        <NodeMesh 
          key={n.id} 
          node={n} 
          onClick={handleNodeClick} 
          isFocused={n.id === focusId}
          onWidgetClick={handleWidgetClick}
          showOnlyFocusedWidgets={showOnlyFocusedWidgets}
          hideEmptyNodes={hideEmptyNodes}
          focusedNodeId={focusId}
          sidePanelOpen={sidePanelOpen}
          earthMode={getGraphSpace(data) === "Earth"}
        />
      ))}
    </>
  );
}

// Component for theme-aware 3D background
function BackgroundColor() {
  const { theme } = useTheme();
  const backgroundColor = theme === "light" ? "hsl(39, 100%, 95%)" : "hsl(222.2, 84%, 4.9%)"; // Light beige for light mode, dark for dark mode
  
  return <color attach="background" args={[backgroundColor] as any} />;
}

// And update the Graph3D component to include the drawer
export function Graph3D({
  data,
  editMode = false,
  onNodeClickForEdit,
  onWidgetClickForEdit,
  onGestureLongPressNode,
  onGestureLongPressWidget,
  onGestureCreateWidget,
  externalSearchTerm,
}: {
  data: KnowledgeNode;
  editMode?: boolean;
  onNodeClickForEdit?: (nodeLabel: string) => void;
  onWidgetClickForEdit?: (widget: Widget, nodeLabel: string) => void;
  onGestureLongPressNode?: (label: string) => void;
  onGestureLongPressWidget?: (widgetName: string, nodeLabel: string) => void;
  onGestureCreateWidget?: (parentLabel: string) => void;
  externalSearchTerm?: string;
}) {
  const card = useCssHsl("--card", "hsl(0 0% 100%)");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [selectedWidget, setSelectedWidget] = useState<Widget | null>(null);
  const { focusLevel, setFocusLevel } = useFocus(); // 0: all; 1: hide widget-less nodes (default); 2: focused widgets only; 3: both
  const showOnlyFocusedWidgets = focusLevel >= 2;
  const hideEmptyNodes = focusLevel === 1 || focusLevel === 3;
  const hideUnfocusedNodes = false;
  const [iframeError, setIframeError] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [isReadingWidget, setIsReadingWidget] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isImageHovered, setIsImageHovered] = useState(false);
  const searchTerm = externalSearchTerm ?? "";
  
  // Get the current focus from context  
  const { focusedNodeLabel } = useFocus();
  
  // Load available voices from Web Speech API
  useEffect(() => {
    const loadVoices = () => {
      const voices = speechSynthesis.getVoices();
      
      // Filter for high-quality voices (Google, Microsoft, etc.)
      const qualityVoices = voices.filter(voice => {
        const name = voice.name.toLowerCase();
        const lang = voice.lang.toLowerCase();
        
        // Prioritize English voices from quality providers
        return (
          lang.startsWith('en') && (
            name.includes('google') ||
            name.includes('microsoft') ||
            name.includes('enhanced') ||
            name.includes('premium') ||
            name.includes('natural') ||
            voice.localService === false // Cloud-based voices are usually better
          )
        );
      });
      
      // Fallback to all English voices if no quality voices found
      const selectedVoices = qualityVoices.length > 0 
        ? qualityVoices 
        : voices.filter(v => v.lang.toLowerCase().startsWith('en'));
      
      setAvailableVoices(selectedVoices);
      
      // Set default voice to first available
      if (selectedVoices.length > 0 && !selectedVoice) {
        setSelectedVoice(selectedVoices[0].name);
      }
    };
    
    loadVoices();
    
    // Voices may load asynchronously
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);
  
  // Get the focused node's prose content
  const { nodes } = useMemo(() => build3DLayout(data), [data]);
  const focusedNode = useMemo(() => {
    return nodes.find(node => node.label === focusedNodeLabel);
  }, [nodes, focusedNodeLabel]);
  
  // Text-to-speech functionality for nodes
  const readProseContent = () => {
    if (!focusedNode?.prose) {
      console.log('No prose content available for the focused node');
      return;
    }
    
    // Stop any current speech
    speechSynthesis.cancel();
    
    if (isReading) {
      setIsReading(false);
      return;
    }
    
    const utterance = new SpeechSynthesisUtterance(focusedNode.prose);
    
    // Find and set the selected voice
    const voice = availableVoices.find(v => v.name === selectedVoice);
    if (voice) {
      utterance.voice = voice;
    }
    
    // Configure speech settings
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    
    // Set up event listeners
    utterance.onstart = () => setIsReading(true);
    utterance.onend = () => setIsReading(false);
    utterance.onerror = () => setIsReading(false);
    
    // Start speaking
    speechSynthesis.speak(utterance);
  };

  // Text-to-speech functionality for widgets
  const readWidgetProseContent = () => {
    if (!selectedWidget?.prose) {
      console.log('No prose content available for the selected widget');
      return;
    }
    
    // Stop any current speech
    speechSynthesis.cancel();
    
    if (isReadingWidget) {
      setIsReadingWidget(false);
      return;
    }
    
    const utterance = new SpeechSynthesisUtterance(selectedWidget.prose);
    
    // Find and set the selected voice
    const voice = availableVoices.find(v => v.name === selectedVoice);
    if (voice) {
      utterance.voice = voice;
    }
    
    // Configure speech settings
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    
    // Set up event listeners
    utterance.onstart = () => setIsReadingWidget(true);
    utterance.onend = () => setIsReadingWidget(false);
    utterance.onerror = () => setIsReadingWidget(false);
    
    // Start speaking
    speechSynthesis.speak(utterance);
  };
  
  // Reset iframe error when widget changes
  useEffect(() => {
    setIframeError(false);
  }, [selectedWidget]);
  
  // Get focus control functions from context
  const { setFocusedNodeLabel, focusSource, setFocusSource, setDfsIndexByLabel } = useFocus();
  
  return (
    <>
      <section aria-label="3D knowledge tree" className="w-full h-[800px] mt-10 relative">



        {/* Control panel with focus mode and TTS */}
        <div className="absolute top-4 right-4 z-10 bg-card/80 backdrop-blur-sm border border-border rounded-lg p-3 shadow-lg">
          <div className="flex items-center space-x-4">
           
            
            {/* Focus level slider */}
            <div className="flex items-center space-x-2">
              <label className="text-sm font-medium text-foreground">Focus</label>
              <Slider
                value={[focusLevel]}
                onValueChange={(v) => setFocusLevel(v[0])}
                min={0}
                max={3}
                step={1}
                className="w-28"
                aria-label="Focus level"
              />
            </div>
            
            {/* TTS Speaker Button */}
            {focusedNode?.prose && (
              <Button
                variant="outline"
                size="sm"
                onClick={readProseContent}
                disabled={!focusedNode?.prose}
                className="flex items-center gap-2"
              >
                {isReading ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
                {isReading ? "Stop" : "Read"}
              </Button>
            )}
             {/* Voice Selector */}
             <div className="flex items-center space-x-2">
              <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Select Voice" />
                </SelectTrigger>
                <SelectContent>
                  {availableVoices.map((voice) => (
                    <SelectItem key={voice.name} value={voice.name}>
                      {voice.name.replace(/\s*\(.*?\)\s*/g, '').substring(0, 30)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        
        <div className="w-full h-full rounded-lg border border-border bg-card overflow-hidden">
          <Canvas shadows camera={{ position: [0, 5, -15], fov: 50, near: 0.01, far: 500000 }}>
            <BackgroundColor />
            <GraphSceneWithDrawer
              data={data} 
              setSidePanelOpen={setSidePanelOpen}
              setSelectedWidget={setSelectedWidget}
              showOnlyFocusedWidgets={showOnlyFocusedWidgets}
              hideEmptyNodes={hideEmptyNodes}
              hideUnfocusedNodes={hideUnfocusedNodes}
              sidePanelOpen={sidePanelOpen}
              focusedNodeLabel={focusedNodeLabel}
              setFocusedNodeLabel={setFocusedNodeLabel}
              focusSource={focusSource}
              setFocusSource={setFocusSource}
              setDfsIndexByLabel={setDfsIndexByLabel}
              editMode={editMode}
              onNodeClickForEdit={onNodeClickForEdit}
              onWidgetClickForEdit={onWidgetClickForEdit}
              onGestureLongPressNode={onGestureLongPressNode}
              onGestureLongPressWidget={onGestureLongPressWidget}
              onGestureCreateWidget={onGestureCreateWidget}
              searchTerm={searchTerm}
            />
          </Canvas>
        </div>
      </section>

      {/* Side panel drawer - starts at right edge of 2D panel (400px) */}
      <Drawer open={sidePanelOpen} onOpenChange={setSidePanelOpen} modal={true}>
        <DrawerContent
          className="h-full z-[600]"
          style={{ left: '400px', right: '0', position: 'fixed' }}
          onWheel={(e) => e.stopPropagation()}
        >
          <DrawerHeader className="text-left">
            <div className="flex justify-between items-start">
              <div>
                <DrawerTitle>{selectedWidget?.title || 'Widget Details'}</DrawerTitle>
                <DrawerDescription>
                  {selectedWidget?.subtitle || ''}
                </DrawerDescription>
              </div>
              {/* Widget Control Panel */}
              <div className="flex items-center gap-2">
                {/* TTS Speaker Button for widget */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={readWidgetProseContent}
                  disabled={!selectedWidget?.prose}
                  className="flex items-center gap-2"
                >
                  {isReadingWidget ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                  {isReadingWidget ? "Stop" : "Read"}
                </Button>
                
                {/* Voice Selector for widget TTS */}
                <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Select Voice" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableVoices.map((voice) => (
                      <SelectItem key={voice.name} value={voice.name}>
                        {voice.name.replace(/\s*\(.*?\)\s*/g, '').substring(0, 30)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </DrawerHeader>
          <div className="p-4 flex-1 overflow-auto">
            {selectedWidget && (
              <div className="space-y-4">
                {/* Helper functions to check widget name type */}
                {(() => {
                  const isImageFile = (name: string) => {
                    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;
                    return imageExtensions.test(name);
                  };
                  
                  const isYouTubeLink = (name: string) => {
                    return name.includes('youtube.com') || name.includes('youtu.be');
                  };
                  
                  const isWebUrl = (name: string) => {
                    return name.startsWith('http://') || name.startsWith('https://');
                  };
                  
                  // Display logic based on widget name
                  if (isImageFile(selectedWidget.name)) {
                    // Show image from name field
                    return (
                      <div className="w-full">
                        {/* Show Source button if url attribute exists */}
                        {selectedWidget.url && (
                          <div className="mb-2 flex justify-between items-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(selectedWidget.url, '_blank')}
                            >
                              Source
                            </Button>
                          </div>
                        )}
                        <div 
                          className={`relative ${!editMode ? 'cursor-zoom-in' : ''}`}
                          onClick={() => !editMode && setIsImageHovered(true)}
                          onWheel={() => !editMode && setIsImageHovered(true)}
                        >
                          <ResolvedImage
                            imagePath={selectedWidget.name}
                            alt="Widget"
                            className="w-full max-h-96 object-contain rounded-lg border border-border"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        </div>
                      </div>
                    );
                  } else if (isYouTubeLink(selectedWidget.name)) {
                    // Show YouTube video from name field
                    return (
                      <div className="w-full">
                        {/* Show Source button if url attribute exists */}
                        {selectedWidget.url && (
                          <div className="mb-2 flex justify-between items-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(selectedWidget.url, '_blank')}
                            >
                              Source
                            </Button>
                          </div>
                        )}
                        <iframe 
                          src={(() => {
                            const getYouTubeVideoId = (url: string) => {
                              const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
                              const match = url.match(regExp);
                              return (match && match[2].length === 11) ? match[2] : null;
                            };
                            const videoId = getYouTubeVideoId(selectedWidget.name);
                            return videoId ? `https://www.youtube.com/embed/${videoId}` : selectedWidget.name;
                          })()}
                          title="YouTube video"
                          className="w-full aspect-video rounded-lg border border-border"
                          allowFullScreen
                        />
                      </div>
                    );
                  } else if (isWebUrl(selectedWidget.name)) {
                    // Show website iframe for URLs
                    return (
                      <div className="w-full">
                        {!iframeError ? (
                          <>
                            <div className="mb-2 flex justify-between items-center">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(selectedWidget.url || selectedWidget.name, '_blank')}
                              >
                                Source
                              </Button>
                            </div>
                            <iframe 
                              src={selectedWidget.name}
                              title="Website"
                              className="w-full h-96 rounded-lg border border-border"
                              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                              onError={() => {
                                console.log('Failed to load iframe:', selectedWidget.name);
                                setIframeError(true);
                              }}
                            />
                          </>
                        ) : (
                          /* Show widget image when iframe fails */
                          <>
                            <div className="mb-2 flex justify-between items-center">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(selectedWidget.url || selectedWidget.name, '_blank')}
                              >
                                Source
                              </Button>
                            </div>
                            {selectedWidget.preview ? (
                              <div 
                                className={`relative ${!editMode ? 'cursor-zoom-in' : ''}`}
                                onClick={() => !editMode && setIsImageHovered(true)}
                                onWheel={() => !editMode && setIsImageHovered(true)}
                              >
                                <img 
                                  src={selectedWidget.preview.startsWith('http') 
                                    ? selectedWidget.preview 
                                    : selectedWidget.preview.startsWith('/') 
                                      ? selectedWidget.preview 
                                      : `${selectedWidget.preview}`
                                  }
                                  alt="Widget" 
                                  className="w-full max-h-96 object-contain rounded-lg border border-border"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                  }}
                                />
                              </div>
                            ) : (
                              !selectedWidget.name.startsWith('http') && (
                                <div 
                                  className={`relative ${!editMode ? 'cursor-zoom-in' : ''}`}
                                  onClick={() => !editMode && setIsImageHovered(true)}
                                  onWheel={() => !editMode && setIsImageHovered(true)}
                                >
                                  <img 
                                    src={selectedWidget.name.startsWith('/') 
                                      ? selectedWidget.name 
                                      : `${selectedWidget.name}`
                                    }
                                    alt="Widget" 
                                    className="w-full max-h-96 object-contain rounded-lg border border-border"
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                    }}
                                  />
                                </div>
                              )
                            )}
                          </>
                        )}
                      </div>
                    );
                  } else {
                    // Default: show as image file
                    return (
                      <div className="w-full">
                        {/* Show Source button if url attribute exists */}
                        {selectedWidget.url && (
                          <div className="mb-2 flex justify-between items-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(selectedWidget.url, '_blank')}
                            >
                              Source
                            </Button>
                          </div>
                        )}
                        <div 
                          className={`relative ${!editMode ? 'cursor-zoom-in' : ''}`}
                          onClick={() => !editMode && setIsImageHovered(true)}
                          onWheel={() => !editMode && setIsImageHovered(true)}
                        >
                          <img 
                            src={selectedWidget.name.startsWith('http') 
                              ? selectedWidget.name 
                              : selectedWidget.name.startsWith('/') 
                                ? selectedWidget.name 
                                : `${selectedWidget.name}`
                            }
                            alt="Widget" 
                            className="w-full max-h-96 object-contain rounded-lg border border-border"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        </div>
                      </div>
                    );
                  }
                })()}
                
                {/* Widget prose content */}
                {selectedWidget.prose && (
                  <div className="space-y-2">
                    <h3 className="font-semibold text-foreground">Prose:</h3>
                    <div className="text-lg font-bold text-foreground whitespace-pre-wrap bg-muted/50 p-3 rounded-lg">
                      {selectedWidget.prose}
                    </div>
                  </div>
                )}
                
                {/* Widget notes */}
                {selectedWidget.notes && (
                  <div className="space-y-2">
                    <h3 className="font-semibold text-foreground">Notes:</h3>
                    <div className="text-lg font-bold text-foreground whitespace-pre-wrap bg-muted/50 p-3 rounded-lg">
                      {selectedWidget.notes}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Detailed image view (click or scroll on the image) - only in non-edit mode */}
          {!editMode && isImageHovered && selectedWidget && (
            <EnlargedImageViewer
              imagePath={selectedWidget.detailed_url || selectedWidget.name}
              alt={selectedWidget.title || selectedWidget.name || "Widget image"}
              onClose={() => setIsImageHovered(false)}
            />
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** Full-screen image viewer with wheel/pinch zoom and drag panning. */
function EnlargedImageViewer({
  imagePath,
  alt,
  onClose,
}: {
  imagePath: string;
  alt: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const stateRef = useRef({ zoom, offset });
  stateRef.current = { zoom, offset };

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 12;

  // Non-passive wheel listener so we can preventDefault (page/trackpad pinch zoom)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const { zoom: z, offset: o } = stateRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-dy * 0.0015)));
      const k = next / z;
      if (next === 1) {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
        return;
      }
      setZoom(next);
      setOffset({ x: px - (px - o.x) * k, y: py - (py - o.y) * k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[700] overflow-hidden bg-background"
      style={{ touchAction: 'none', cursor: dragRef.current ? 'grabbing' : zoom > 1 ? 'grab' : 'zoom-out' }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        setOffset({ x: d.ox + dx, y: d.oy + dy });
      }}
      onPointerUp={() => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d && !d.moved && zoom === 1) onClose();
      }}
      onPointerLeave={() => {
        dragRef.current = null;
      }}
      onDoubleClick={() => {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      }}
    >
      <div
        className="w-full h-full"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <ResolvedImage
          imagePath={imagePath}
          alt={alt}
          className="w-screen h-screen object-contain select-none pointer-events-none"
        />
      </div>
    </div>
  );
}

// Create a wrapper component that passes the drawer state down
// ============================================================
// Level-of-detail helpers for very large graphs
// ============================================================

/** Above this node count the renderer switches to LOD mode. */
const LOD_NODE_THRESHOLD = 400;
/** Max nodes rendered as full React NodeMesh (textures, widgets, interaction). */
const LOD_DETAIL_BUDGET = 250;
/** Max DOM label overlays rendered at once. */
const LOD_LABEL_BUDGET = 60;

type LodSets = { detail: Set<string>; labels: Set<string> };

/**
 * Picks, a few times per second, which nodes deserve full detail and which
 * deserve a DOM label — nearest-to-camera first, always including the focused
 * node and its neighbours.
 */
function LodSelector({
  nodes,
  focusId,
  adjacency,
  onChange,
}: {
  nodes: Node3D[];
  focusId: string | null;
  adjacency: Map<string, Set<string>>;
  onChange: (sets: LodSets) => void;
}) {
  const acc = useRef(0);
  const lastKey = useRef("");

  useFrame(({ camera }, delta) => {
    acc.current += delta;
    if (acc.current < 0.25) return;
    acc.current = 0;

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const scored = nodes.map((n) => {
      const dx = n.position[0] - cx, dy = n.position[1] - cy, dz = n.position[2] - cz;
      return { id: n.id, d: dx * dx + dy * dy + dz * dz };
    });
    scored.sort((a, b) => a.d - b.d);

    const forced = new Set<string>();
    if (focusId) {
      forced.add(focusId);
      adjacency.get(focusId)?.forEach((id) => forced.add(id));
    }

    const detail = new Set(forced);
    for (const s of scored) {
      if (detail.size >= LOD_DETAIL_BUDGET) break;
      detail.add(s.id);
    }
    const labels = new Set(forced);
    for (const s of scored) {
      if (labels.size >= LOD_LABEL_BUDGET) break;
      labels.add(s.id);
    }

    const key = `${[...detail].sort().join("|")}##${[...labels].sort().join("|")}`;
    if (key !== lastKey.current) {
      lastKey.current = key;
      onChange({ detail, labels });
    }
  });

  return null;
}

/** All low-detail nodes drawn in a single instanced draw call. */
function InstancedNodes({
  nodes,
  color,
  emissive,
  onSelect,
}: {
  nodes: Node3D[];
  color: string;
  emissive: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    nodes.forEach((n, i) => {
      const s = (0.35 + normalizeWeight(n.weight) * 0.6) / 5;
      pos.set(n.position[0], n.position[1], n.position[2]);
      scl.set(s, s, s);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    });
    mesh.count = nodes.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [nodes]);

  if (nodes.length === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[undefined as any, undefined as any, nodes.length]}
      frustumCulled
      onClick={(e: any) => {
        e.stopPropagation();
        const i = e.instanceId;
        if (typeof i === "number" && nodes[i]) onSelect(nodes[i].id);
      }}
    >
      <sphereGeometry args={[1, 10, 8]} />
      <meshPhysicalMaterial
        color="#ffffff"
        emissive="#ffffff"
        emissiveIntensity={0.05}
        metalness={0}
        roughness={0.15}
        transmission={0.85}
        thickness={0.6}
        ior={1.3}
        transparent
        opacity={0.35}
        depthWrite={false}
      />

    </instancedMesh>
  );
}

/** All low-detail edges collapsed into one merged line-segment geometry. */
function MergedEdges({
  segments,
  color,
  opacity,
}: {
  segments: Float32Array;
  color: string;
  opacity: number;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(segments, 3));
    return g;
  }, [segments]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (segments.length === 0) return null;

  return (
    <lineSegments geometry={geometry} frustumCulled>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </lineSegments>
  );
}

function GraphSceneWithDrawer({ 
  data, 
  setSidePanelOpen, 
  setSelectedWidget,
  showOnlyFocusedWidgets,
  hideEmptyNodes,
  hideUnfocusedNodes,
  sidePanelOpen,
  focusedNodeLabel,
  setFocusedNodeLabel,
  focusSource,
  setFocusSource,
  setDfsIndexByLabel,
  editMode,
  onNodeClickForEdit,
  onWidgetClickForEdit,
  onGestureLongPressNode,
  onGestureLongPressWidget,
  onGestureCreateWidget,
  searchTerm = "",
}: {
  data: KnowledgeNode;
  setSidePanelOpen: (open: boolean) => void;
  setSelectedWidget: (widget: Widget | null) => void;
  showOnlyFocusedWidgets: boolean;
  hideEmptyNodes: boolean;
  hideUnfocusedNodes: boolean;
  sidePanelOpen: boolean;
  focusedNodeLabel: string | null;
  setFocusedNodeLabel: (label: string | null) => void;
  focusSource: 'graph2d' | 'graph3d' | null;
  setFocusSource: (source: 'graph2d' | 'graph3d' | null) => void;
  setDfsIndexByLabel: (label: string) => void;
  editMode?: boolean;
  onNodeClickForEdit?: (nodeLabel: string) => void;
  onWidgetClickForEdit?: (widget: Widget, nodeLabel: string) => void;
  onGestureLongPressNode?: (label: string) => void;
  onGestureLongPressWidget?: (widgetName: string, nodeLabel: string) => void;
  onGestureCreateWidget?: (parentLabel: string) => void;
  searchTerm?: string;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const prevFocusIdRef = useRef<string | null>(null);
  const { nodes, edges } = useMemo(() => build3DLayout(data), [data]);
  const isEarth = getGraphSpace(data) === "Earth";

  // Level of detail: only engages for very large graphs
  const lodActive = nodes.length > LOD_NODE_THRESHOLD;
  const [lodSets, setLodSets] = useState<LodSets>({ detail: new Set(), labels: new Set() });

  // Nodes matching the search term (matches node label/prose or any widget text)
  const searchMatchIds = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const matches = new Set<string>();
    if (!q) return matches;
    for (const n of nodes) {
      const label = typeof n.label === "string" ? n.label : "";
      if (label.toLowerCase().includes(q)) matches.add(n.id);
    }
    return matches;
  }, [nodes, searchTerm]);
  const idToNode = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();
  const isDriving = useRef(false);
  const skipNextAnimation = useRef(false);
  const driveAnimationRef = useRef<number | null>(null);

  // Find root node for initial positioning
  const rootNode = useMemo(() => nodes.find(node => node.position[2] === 0), [nodes]);

  useEffect(() => {
    if (!isEarth && controlsRef.current && rootNode) {
      controlsRef.current.target.set(rootNode.position[0], rootNode.position[1], rootNode.position[2]);
      controlsRef.current.update();
    }
  }, [rootNode, isEarth]);

  // Build adjacency map
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    edges.forEach(e => {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    });
    return adj;
  }, [edges]);

  // Build parent map (child → parent) so we can detect upward navigation
  const parentMap = useMemo(() => {
    const pm = new Map<string, string>();
    edges.forEach(e => pm.set(e.target, e.source)); // edge source is parent
    return pm;
  }, [edges]);

  // BFS graph distances from focused node
  const graphDistances = useMemo(() => {
    if (!focusId) return new Map<string, number>();
    const distances = new Map<string, number>();
    distances.set(focusId, 0);
    const queue = [focusId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDist = distances.get(current)!;
      const neighbors = adjacency.get(current) || new Set<string>();
      for (const neighbor of neighbors) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, currentDist + 1);
          queue.push(neighbor);
        }
      }
    }
    return distances;
  }, [focusId, adjacency]);

  // Directly connected node IDs
  const connectedNodeIds = useMemo(() => {
    if (!focusId) return new Set<string>();
    return adjacency.get(focusId) || new Set<string>();
  }, [focusId, adjacency]);

  // Pre-compute road curve controls so drive animation can follow curves
  const roadCurveControlsRef = useRef(new Map<string, THREE.Vector3>());

  const labelToId = useMemo(() => {
    const map = new Map<string, string>();
    nodes.forEach(node => map.set(node.label, node.id));
    return map;
  }, [nodes]);

  // Sync focus from navigation arrows or 2D view — use drive animation when possible
  useEffect(() => {
    if (focusedNodeLabel) {
      const matchingId = labelToId.get(focusedNodeLabel);
      if (matchingId) {
        const prevId = prevFocusIdRef.current;
        const sourceNode = prevId ? idToNode.get(prevId) : null;
        const targetNode = idToNode.get(matchingId);

        if (sourceNode && targetNode && prevId !== matchingId && !isDriving.current) {
          // Detect if we're going from child back to parent (upward navigation)
          const isReverse = parentMap.get(prevId!) === matchingId;
          // Find the road curve control point between these nodes
          const curveCtrl = roadCurveControlsRef.current.get(isReverse ? prevId! : matchingId);
          driveToNode(sourceNode, targetNode, matchingId, curveCtrl, isReverse);
        } else {
          setFocusId(matchingId);
        }
        prevFocusIdRef.current = matchingId;
      }
    } else {
      setFocusId(null);
      prevFocusIdRef.current = null;
    }
  }, [focusedNodeLabel, labelToId]);

  // Drive animation: smoothly travel along road like driving a car
  const driveToNode = (sourceNode: Node3D, targetNode: Node3D, targetId: string, curveCtrl?: THREE.Vector3, reverse = false) => {
    isDriving.current = true;
    skipNextAnimation.current = true;

    if (controlsRef.current) controlsRef.current.enabled = false;

    const src = new THREE.Vector3(...sourceNode.position);
    const tgt = new THREE.Vector3(...targetNode.position);
    const ctrl = curveCtrl || new THREE.Vector3().lerpVectors(src, tgt, 0.5);

    // For reverse: we travel the same path but backwards (tgt→src geometrically, arriving at tgt logically)
    // Swap the bezier endpoints so the curve is traversed in reverse
    const pathStart = reverse ? tgt : src;
    const pathEnd = reverse ? src : tgt;
    // For reverse, flip the control point order too
    const pathCtrl = ctrl; // control point stays the same, just traversal direction changes

    const driverHeight = 0.45;
    const savedCamPos = camera.position.clone();
    const savedLookAt = controlsRef.current
      ? controlsRef.current.target.clone()
      : tgt.clone();

    const roadLen = src.distanceTo(tgt);
    const duration = Math.max(2000, Math.min(4000, roadLen * 350));

    // Final camera position: for reverse, arrive looking back down the road we came from
    const arrivalDir = reverse
      ? new THREE.Vector3().subVectors(tgt, ctrl).normalize()   // look from child side
      : new THREE.Vector3().subVectors(tgt, ctrl).normalize();
    const endCamPos = new THREE.Vector3(
      tgt.x - arrivalDir.x * 8,
      tgt.y + 5,
      tgt.z - arrivalDir.z * 8
    );

    const startTime = Date.now();
    let prevLookAt = savedLookAt.clone();

    function animate() {
      const elapsed = Date.now() - startTime;
      const rawProgress = Math.min(1, elapsed / duration);

      const ease = rawProgress < 0.5
        ? 16 * Math.pow(rawProgress, 5)
        : 1 - Math.pow(-2 * rawProgress + 2, 5) / 2;

      if (rawProgress < 0.10) {
        const t = rawProgress / 0.10;
        const smoothT = t * t * (3 - 2 * t);
        const roadStart = new THREE.Vector3(pathStart.x, pathStart.y + driverHeight, pathStart.z);
        camera.position.lerpVectors(savedCamPos, roadStart, smoothT);
        // In reverse, look behind us (back along the road we're about to reverse on)
        const lookAheadPos = quadBezier(pathStart, pathCtrl, pathEnd, 0.15);
        if (reverse) {
          // Look backwards: towards where we came from (the pathStart side)
          const behindPos = quadBezier(pathStart, pathCtrl, pathEnd, -0.05);
          const lookTarget = new THREE.Vector3().lerpVectors(savedLookAt, behindPos, smoothT);
          prevLookAt.copy(lookTarget);
          camera.lookAt(lookTarget);
        } else {
          const lookTarget = new THREE.Vector3().lerpVectors(savedLookAt, lookAheadPos, smoothT);
          prevLookAt.copy(lookTarget);
          camera.lookAt(lookTarget);
        }
      } else if (rawProgress < 0.88) {
        const driveT = (rawProgress - 0.10) / 0.78;

        const driveEase = driveT < 0.2
          ? 2.5 * driveT * driveT
          : driveT > 0.8
            ? 1 - 2.5 * Math.pow(1 - driveT, 2)
            : 0.1 + driveT * 0.8;

        const curvePos = quadBezier(pathStart, pathCtrl, pathEnd, driveEase);

        const bobFreq = driveT * Math.PI * 6;
        const bob = Math.sin(bobFreq) * 0.02 * (1 - Math.abs(driveT - 0.5) * 2);

        camera.position.set(
          curvePos.x,
          curvePos.y + driverHeight + bob,
          curvePos.z
        );

        if (reverse) {
          // Look behind: opposite of travel direction (look back along the road)
          const lookBehindT = Math.max(0, driveEase - 0.12);
          const lookBehindPos = quadBezier(pathStart, pathCtrl, pathEnd, lookBehindT);
          lookBehindPos.y += driverHeight * 0.5;
          prevLookAt.lerp(lookBehindPos, 0.12);
          camera.lookAt(prevLookAt);
        } else {
          const lookAheadT = Math.min(1, driveEase + 0.12);
          const lookAheadPos = quadBezier(pathStart, pathCtrl, pathEnd, lookAheadT);
          lookAheadPos.y += driverHeight * 0.5;
          prevLookAt.lerp(lookAheadPos, 0.12);
          camera.lookAt(prevLookAt);
        }
      } else {
        const riseT = (rawProgress - 0.88) / 0.12;
        const smoothRise = riseT * riseT * (3 - 2 * riseT);

        const roadEnd = new THREE.Vector3(pathEnd.x, pathEnd.y + driverHeight, pathEnd.z);
        camera.position.lerpVectors(roadEnd, endCamPos, smoothRise);

        const lookTarget = new THREE.Vector3().lerpVectors(prevLookAt, tgt, smoothRise);
        camera.lookAt(lookTarget);
      }

      if (controlsRef.current) {
        controlsRef.current.target.lerpVectors(
          controlsRef.current.target,
          tgt,
          0.08
        );
        controlsRef.current.update();
      }

      if (rawProgress < 1) {
        driveAnimationRef.current = requestAnimationFrame(animate);
      } else {
        isDriving.current = false;
        if (controlsRef.current) {
          controlsRef.current.target.copy(tgt);
          controlsRef.current.enabled = true;
          controlsRef.current.update();
        }
        setFocusId(targetId);
        const clickedNode = idToNode.get(targetId);
        if (clickedNode) {
          setFocusedNodeLabel(clickedNode.label);
          setFocusSource('graph3d');
          setDfsIndexByLabel(clickedNode.label);
        }
      }
    }

    animate();
  };

  // Node click handler with drive support
  const handleNodeClick = (id: string) => {
    if (isDriving.current) return;

    const clickedNode = idToNode.get(id);
    if (!clickedNode) return;

    if (editMode && onNodeClickForEdit) {
      onNodeClickForEdit(clickedNode.label);
      return;
    }

    if (focusId === id) {
      setFocusId(null);
      setFocusedNodeLabel(null);
      setFocusSource(null);
      prevFocusIdRef.current = null;
    } else {
      // Drive if clicking a direct neighbor of the focused node
      const shouldDrive = focusId && focusId !== id && connectedNodeIds.has(id);

      if (shouldDrive) {
        const sourceNode = idToNode.get(focusId!);
        if (sourceNode) {
          const curveCtrl = roadCurveControlsRef.current.get(id);
          driveToNode(sourceNode, clickedNode, id, curveCtrl);
          return;
        }
      }

      setFocusId(id);
      setFocusedNodeLabel(clickedNode.label);
      setFocusSource('graph3d');
      setDfsIndexByLabel(clickedNode.label);
      prevFocusIdRef.current = id;
    }
  };

  // Widget clicks
  const handleWidgetClick = (widget: Widget, nodeLabel: string) => {
    if (editMode && onWidgetClickForEdit) {
      onWidgetClickForEdit(widget, nodeLabel);
      return;
    }
    // Focus (zoom + center) the node that owns this widget
    if (nodeLabel) {
      const owner = nodes.find(n => n.label === nodeLabel);
      if (owner) {
        skipNextAnimation.current = false;
        if (focusId === owner.id) {
          // Already focused: re-run the zoom animation explicitly
          animateFocusToNode(owner);
        } else {
          setFocusId(owner.id);
          prevFocusIdRef.current = owner.id;
        }
        setFocusedNodeLabel(owner.label);
        setFocusSource('graph3d');
        setDfsIndexByLabel(owner.label);
      }
    }
    setSelectedWidget(widget);
    setSidePanelOpen(true);
  };

  // Zoom + center camera on a node
  const animateFocusToNode = (focusedNode: { position: [number, number, number] } | any) => {
    if (!controlsRef.current || !focusedNode) return;
    const nodePos = focusedNode.position;
    const startPos = camera.position.clone();
    const startTarget = controlsRef.current.target.clone();
    const targetDistance = 6;
    const dir = new THREE.Vector3()
      .subVectors(startPos, new THREE.Vector3(...nodePos))
      .normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    const targetPos = new THREE.Vector3(
      nodePos[0] + dir.x * targetDistance,
      nodePos[1] + dir.y * targetDistance,
      nodePos[2] + dir.z * targetDistance
    );

    const startTime = Date.now();
    const duration = 1000;

    function animate() {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const ease = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      camera.position.set(
        startPos.x + (targetPos.x - startPos.x) * ease,
        startPos.y + (targetPos.y - startPos.y) * ease,
        startPos.z + (targetPos.z - startPos.z) * ease
      );
      controlsRef.current.target.set(
        startTarget.x + (nodePos[0] - startTarget.x) * ease,
        startTarget.y + (nodePos[1] - startTarget.y) * ease,
        startTarget.z + (nodePos[2] - startTarget.z) * ease
      );
      controlsRef.current.update();

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }

    animate();
  };

  // Focus animation (zoom to node) — skipped after drive
  const initialEarthFocusSkipped = useRef(false);
  useEffect(() => {
    if (skipNextAnimation.current) {
      skipNextAnimation.current = false;
      return;
    }
    // A collection may restore its root as focused after the globe has already
    // been framed. Keep that state, but do not let it pull the startup camera
    // from the whole-Earth view down to six units from the root node.
    if (isEarth && focusId && !initialEarthFocusSkipped.current) {
      initialEarthFocusSkipped.current = true;
      return;
    }
    if (focusId) {
      const focusedNode = nodes.find(n => n.id === focusId);
      if (focusedNode) animateFocusToNode(focusedNode);
    }
  }, [focusId, nodes, camera, isEarth]);

  // Cleanup drive animation on unmount
  useEffect(() => {
    return () => {
      if (driveAnimationRef.current) cancelAnimationFrame(driveAnimationRef.current);
    };
  }, []);

  const muted = "#3b82f6";
  const focusedEdgeColor = "#1d4ed8";

  // Split nodes into full-detail (React meshes) and instanced (single draw call)
  const detailNodes = useMemo(() => {
    if (!lodActive) return nodes;
    return nodes.filter((n) => lodSets.detail.has(n.id) || n.id === focusId || searchMatchIds.has(n.id));
  }, [nodes, lodActive, lodSets, focusId, searchMatchIds]);

  const instancedNodes = useMemo(() => {
    if (!lodActive) return [] as Node3D[];
    const detailed = new Set(detailNodes.map((n) => n.id));
    return nodes.filter((n) => !detailed.has(n.id) && (!hideEmptyNodes || (n.widgets && n.widgets.length > 0)));
  }, [nodes, detailNodes, lodActive, hideEmptyNodes]);

  // A node is visible unless we're hiding nodes with an empty widgets array
  const isNodeVisible = useMemo(
    () => (n: Node3D | undefined) => !!n && (!hideEmptyNodes || (!!n.widgets && n.widgets.length > 0)),
    [hideEmptyNodes]
  );

  // Merged geometry for all non-focus edges in LOD mode
  const mergedEdgeSegments = useMemo(() => {
    if (!lodActive) return new Float32Array(0);
    const pts: number[] = [];
    for (const e of edges) {
      if (focusId && (e.source === focusId || e.target === focusId)) continue;
      const a = idToNode.get(e.source);
      const b = idToNode.get(e.target);
      if (!a || !b) continue;
      if (!isNodeVisible(a) || !isNodeVisible(b)) continue;
      pts.push(a.position[0], a.position[1], a.position[2], b.position[0], b.position[1], b.position[2]);
    }
    return new Float32Array(pts);
  }, [edges, idToNode, focusId, lodActive, isNodeVisible]);

  return (
    <>
      <ambientLight intensity={0.6} />
      {isEarth && <EarthSphere />}
      {isEarth && <EarthInitialView controlsRef={controlsRef} />}

      <directionalLight position={[5, 7, -5]} intensity={0.5} />

      <OrbitControls
        ref={controlsRef}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={0.05}
        maxDistance={200000}
        dampingFactor={0.1}
        rotateSpeed={0.7}
        panSpeed={0.5}
        zoomSpeed={1.0}
        makeDefault
      />

      {/* Edges: roads for direct connections when focused, tapered tubes otherwise */}
      {(() => {
        let roadPlaneNormal: THREE.Vector3 | undefined;
        const roadMaxWidths = new Map<string, { src: number; tgt: number }>();
        const roadCurveControls = new Map<string, THREE.Vector3>();

        if (focusId) {
          const focusNode = idToNode.get(focusId);
          const neighbors = adjacency.get(focusId);
          if (focusNode && neighbors && neighbors.size > 0) {
            const focusPos = new THREE.Vector3(...focusNode.position);

            const dirs: THREE.Vector3[] = [];
            const neighborList: { id: string; pos: THREE.Vector3; dir: THREE.Vector3; dist: number }[] = [];
            for (const nId of neighbors) {
              const nNode = idToNode.get(nId);
              if (nNode) {
                const nPos = new THREE.Vector3(...nNode.position);
                const d = nPos.clone().sub(focusPos);
                const dist = d.length();
                const dir = d.clone().normalize();
                dirs.push(dir);
                neighborList.push({ id: nId, pos: nPos, dir, dist });
              }
            }

            // Compute best-fit plane normal
            if (dirs.length >= 2) {
              let bestCross = new THREE.Vector3();
              let bestCrossLen = 0;
              for (let i = 0; i < dirs.length; i++) {
                for (let j = i + 1; j < dirs.length; j++) {
                  const c = new THREE.Vector3().crossVectors(dirs[i], dirs[j]);
                  if (c.length() > bestCrossLen) {
                    bestCrossLen = c.length();
                    bestCross = c;
                  }
                }
              }
              if (bestCrossLen > 0.001) roadPlaneNormal = bestCross.normalize();
            }
            if (!roadPlaneNormal) {
              const fallbackUp = new THREE.Vector3(0, 1, 0);
              if (dirs.length > 0) {
                const c = new THREE.Vector3().crossVectors(dirs[0], fallbackUp);
                if (c.length() > 0.001) {
                  roadPlaneNormal = c.clone().crossVectors(dirs[0], c).normalize();
                }
              }
              if (!roadPlaneNormal) roadPlaneNormal = fallbackUp;
            }

            // Build 2D plane basis for angular calculations
            const planeX = new THREE.Vector3();
            const planeY = new THREE.Vector3();
            const tmpUp = Math.abs(roadPlaneNormal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            planeX.crossVectors(roadPlaneNormal, tmpUp).normalize();
            planeY.crossVectors(roadPlaneNormal, planeX).normalize();

            // Compute angle for each neighbor
            const angleData: { id: string; angle: number; dir: THREE.Vector3; dist: number; pos: THREE.Vector3 }[] = [];
            for (const n of neighborList) {
              const px = n.dir.dot(planeX);
              const py = n.dir.dot(planeY);
              const angle = Math.atan2(py, px);
              angleData.push({ id: n.id, angle, dir: n.dir, dist: n.dist, pos: n.pos });
            }
            angleData.sort((a, b) => a.angle - b.angle);

            // Compute max widths and curve control points
            for (let i = 0; i < angleData.length; i++) {
              const curr = angleData[i];
              const prev = angleData[(i - 1 + angleData.length) % angleData.length];
              const next = angleData[(i + 1) % angleData.length];
              let gapPrev = curr.angle - prev.angle;
              let gapNext = next.angle - curr.angle;
              if (gapPrev <= 0) gapPrev += Math.PI * 2;
              if (gapNext <= 0) gapNext += Math.PI * 2;
              const minGap = Math.min(gapPrev, gapNext);

              const nNode = idToNode.get(curr.id);
              if (!nNode) continue;

              // Max width based on angular gap
              const maxHalfWidth = curr.dist * Math.tan(Math.min(minGap / 2, Math.PI / 3));
              const maxWidth = Math.max(0.06, Math.min(maxHalfWidth * 2, normalizeWeight(focusNode.weight) * 0.5 + 0.12));
              roadMaxWidths.set(curr.id, { src: maxWidth, tgt: normalizeWeight(nNode.weight) * 0.5 + 0.12 });

              // Curve control point: push road away from its closest neighbor
              // The closer the angular gap, the more we curve the road outward
              if (angleData.length >= 2 && minGap < Math.PI * 0.6) {
                // Direction to push: perpendicular to the road direction, away from closest neighbor
                const closestNeighborAngle = gapPrev < gapNext ? prev.angle : next.angle;
                // Bisector away from closest neighbor
                const awayAngle = curr.angle + (curr.angle - closestNeighborAngle);
                const pushDir = new THREE.Vector3()
                  .addScaledVector(planeX, Math.cos(awayAngle))
                  .addScaledVector(planeY, Math.sin(awayAngle))
                  .normalize();

                // Push strength: stronger when gap is smaller, proportional to distance
                const pushStrength = curr.dist * 0.3 * Math.max(0, 1 - minGap / (Math.PI * 0.6));
                const midpoint = new THREE.Vector3().lerpVectors(focusPos, curr.pos, 0.4);
                const controlPt = midpoint.clone().addScaledVector(pushDir, pushStrength);
                roadCurveControls.set(curr.id, controlPt);
              }
              // else: straight road (no curveControl passed)
            }
          }
        }

        // Store curve controls in ref so drive animation can access them
        roadCurveControlsRef.current = roadCurveControls;

        return edges.map((e, idx) => {
          const sourceNode = idToNode.get(e.source);
          const targetNode = idToNode.get(e.target);
          if (!sourceNode || !targetNode) return null;
          if (!isNodeVisible(sourceNode) || !isNodeVisible(targetNode)) return null;

          const isDirectConnection = focusId !== null && (focusId === e.source || focusId === e.target);

          if (focusId && isDirectConnection) {
            const isFocusSource = focusId === e.source;
            const neighborId = isFocusSource ? e.target : e.source;
            const widths = roadMaxWidths.get(neighborId);
            const curveCtrl = roadCurveControls.get(neighborId);

            return (
              <RoadMesh
                key={`road-${idx}`}
                sourcePos={isFocusSource ? sourceNode.position : targetNode.position}
                targetPos={isFocusSource ? targetNode.position : sourceNode.position}
                sourceWeight={isFocusSource ? sourceNode.weight : targetNode.weight}
                targetWeight={isFocusSource ? targetNode.weight : sourceNode.weight}
                planeNormal={roadPlaneNormal}
                maxSourceWidth={widths?.src}
                maxTargetWidth={widths?.tgt}
                curveControl={curveCtrl}
                arrowsReversed={!isFocusSource}
                onClick={() => handleNodeClick(neighborId)}
              />
            );
          }

          if (lodActive) {
            // Non-focus edges are batched into a single merged geometry below.
            return null;
          }

          if (focusId && !isDirectConnection) {
            return (
              <TaperedEdge
                key={`edge-${idx}`}
                sourcePos={sourceNode.position}
                targetPos={targetNode.position}
                sourceWeight={sourceNode.weight}
                targetWeight={targetNode.weight}
                color={muted}
                opacity={0.04}
                isFocused={false}
                onClick={() => handleNodeClick(focusId === e.source ? e.target : e.source)}
              />
            );
          }

          return (
            <TaperedEdge
              key={`edge-${idx}`}
              sourcePos={sourceNode.position}
              targetPos={targetNode.position}
              sourceWeight={sourceNode.weight}
              targetWeight={targetNode.weight}
              color={muted}
              opacity={0.3}
              isFocused={false}
              onClick={() => handleNodeClick(focusId === e.target ? e.source : e.target)}
            />
          );
        });
      })()}

      {/* Large graphs: one merged line-segment draw call for all non-focus edges */}
      {lodActive && (
        <MergedEdges segments={mergedEdgeSegments} color={muted} opacity={focusId ? 0.12 : 0.3} />
      )}

      {/* Large graphs: choose which nodes get full detail / labels */}
      {lodActive && (
        <LodSelector nodes={nodes} focusId={focusId} adjacency={adjacency} onChange={setLodSets} />
      )}

      {/* Large graphs: every low-detail node in one instanced draw call */}
      {lodActive && (
        <InstancedNodes
          nodes={instancedNodes}
          color="#F0EFCC"
          emissive="hsl(38 50% 80%)"
          onSelect={handleNodeClick}
        />
      )}

      {/* Nodes with distance-based fading */}
      {detailNodes.map((n) => {
        let fadeOpacity = 1;
        if (focusId) {
          const dist = graphDistances.get(n.id);
          if (dist === undefined) {
            fadeOpacity = 0.02;
          } else if (dist === 0) {
            fadeOpacity = 1;
          } else if (dist === 1) {
            fadeOpacity = 0.85;
          } else {
            fadeOpacity = Math.max(0.02, 0.15 / dist);
          }
        }

        return (
          <NodeMesh
            key={n.id}
            node={n}
            onClick={handleNodeClick}
            isFocused={n.id === focusId}
            onWidgetClick={handleWidgetClick}
            onWidgetLongPress={onGestureLongPressWidget}
            editMode={!!editMode}
            showOnlyFocusedWidgets={showOnlyFocusedWidgets}
            hideEmptyNodes={hideEmptyNodes}
            hideUnfocusedNodes={hideUnfocusedNodes}
            focusedNodeId={focusId}
            sidePanelOpen={sidePanelOpen}
            fadeOpacity={fadeOpacity}
            isSearchMatch={searchMatchIds.has(n.id)}
            earthMode={getGraphSpace(data) === "Earth"}
            showLabel={!lodActive || lodSets.labels.has(n.id) || n.id === focusId}
          />
        );
      })}

      {/* Touch gesture overlay — invisible, captures touch events for long-press / radial drag */}
      <TouchGestureLayer
        nodes={nodes}
        focusedId={focusId}
        editMode={!!editMode}
        onLongPressNode={onGestureLongPressNode}
        onLongPressWidget={onGestureLongPressWidget}
        onCreateWidget={onGestureCreateWidget}
      />
    </>
  );
}

/**
 * Headless R3F component that listens to touch events on the WebGL canvas
 * and projects 3D node/widget positions to screen-space for hit-testing.
 */
function TouchGestureLayer({
  nodes,
  focusedId,
  editMode,
  onLongPressNode,
  onLongPressWidget,
  onCreateWidget,
}: {
  nodes: Node3D[];
  focusedId: string | null;
  editMode: boolean;
  onLongPressNode?: (label: string) => void;
  onLongPressWidget?: (widgetName: string, nodeLabel: string) => void;
  onCreateWidget?: (parentLabel: string) => void;
}) {
  const { camera, gl } = useThree();
  const surfaceRef = useRef<HTMLCanvasElement>(gl.domElement);
  // Keep ref in sync if gl element changes
  useEffect(() => {
    surfaceRef.current = gl.domElement;
  }, [gl]);

  // Mutable refs so the hit-test closure always sees the latest scene data.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;

  // World->screen projection helper for the *current* camera.
  const project = useCallback(
    (worldPos: THREE.Vector3): ScreenPoint | null => {
      const v = worldPos.clone().project(camera);
      if (v.z < -1 || v.z > 1) return null; // behind camera / outside frustum
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      const x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
      const y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
      return { x, y };
    },
    [camera, gl]
  );

  const NODE_HIT_PX = 44;
  const WIDGET_HIT_PX = 90;

  const hitTest = useCallback(
    (point: ScreenPoint): TouchedTarget => {
      let best: { dist: number; target: TouchedTarget } | null = null;

      // Widgets get priority over nodes when both are under the finger,
      // because the widget render footprint is much larger than its center hit slop.
      let bestWidget: { dist: number; target: TouchedTarget } | null = null;
      const consider = (target: TouchedTarget, screen: ScreenPoint, slack: number) => {
        const dx = point.x - screen.x;
        const dy = point.y - screen.y;
        const d = Math.hypot(dx, dy);
        if (d > slack) return;
        if (target.kind === "widget") {
          if (!bestWidget || d < bestWidget.dist) bestWidget = { dist: d, target };
        } else {
          if (!best || d < best.dist) best = { dist: d, target };
        }
      };

      // Test all nodes
      for (const n of nodesRef.current) {
        const screen = project(new THREE.Vector3(...n.position));
        if (!screen) continue;
        consider(
          { kind: "node", id: n.id, label: n.label, center: screen },
          screen,
          NODE_HIT_PX
        );

        // Test widgets only on the focused node (where they're rendered visibly)
        if (n.id === focusedIdRef.current && n.widgets) {
          const widgets = n.widgets.filter((w) => w && w.name);
          for (let i = 0; i < widgets.length; i++) {
            const angle = (i / widgets.length) * Math.PI * 2;
            const radius = 2.0;
            const widgetWorld = new THREE.Vector3(
              n.position[0] + Math.cos(angle) * radius,
              n.position[1] + Math.sin(angle) * radius,
              n.position[2]
            );
            const ws = project(widgetWorld);
            if (!ws) continue;
            consider(
              { kind: "widget", id: widgets[i].name, nodeLabel: n.label, center: ws },
              ws,
              WIDGET_HIT_PX
            );
          }
        }
      }

      if (bestWidget) return bestWidget.target;
      return best ? best.target : { kind: "empty" };
    },
    [project]
  );

  useTouchGestures(surfaceRef, {
    hitTest,
    editMode,
    onLongPressNode: (label) => onLongPressNode?.(label),
    onLongPressWidget: (widgetId, nodeLabel) =>
      onLongPressWidget?.(widgetId, nodeLabel),
    onRadialDragFromNode: (label) => onCreateWidget?.(label),
  });

  return null;
}