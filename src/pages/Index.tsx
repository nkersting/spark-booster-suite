import { useMemo, useState, MouseEvent, useEffect, useCallback, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Graph3D } from "@/components/Graph3D";
import { SEO } from "@/components/SEO";
import { KnowledgeNode, Widget } from "../types";
import { coerceGeneratedDocument, emptyKnowledgeDocument, normalizeKnowledgeData, parseKnowledgeFile, serializeKnowledgeData } from "@/lib/knowledge-graph";
import { KnowledgeTree } from "@/components/KnowledgeTree";
import { FocusProvider, useFocus } from "@/contexts/FocusContext";
import { filterTreeByText } from "@/lib/knowledge-graph";
import { DataFolderProvider, useDataFolder, resolveImageUrl, clearImageCache } from "@/contexts/DataFolderContext";
import { NavigationButton } from "@/components/NavigationButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pencil, Settings, FolderOpen, FileText, RefreshCw, LogOut, User, Shield, Eye, Presentation, Search, X, Filter, Landmark, Loader2 } from "lucide-react";
import { MuseumQueryDialog } from "@/components/MuseumQueryDialog";
import { parsePptx, type PptxParseResult } from "@/lib/pptx-parser";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isValidImageUrl } from "@/lib/utils";
import { applyPptImagesToKnowledgeData } from "@/lib/pptx-widget-images";
import { NodeEditPanel } from "@/components/NodeEditPanel";

// Tactile press feedback for the landing buttons
const pressCls =
  "shadow-md transition-all duration-100 active:translate-y-0.5 active:shadow-none active:scale-[0.97] active:brightness-90";
import { WidgetEditPanel } from "@/components/WidgetEditPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

function IndexContent() {
  const { initializeDfsTraversal, focusNextNode, focusPreviousNode, setFocusedNodeLabel, setFocusSource, setDfsIndexByLabel, filterTerm, setFilterTerm } = useFocus();
  const [isFilterVisible, setIsFilterVisible] = useState(false);
  const { dirHandle, setDirHandle } = useDataFolder();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [topic, setTopic] = useState("");
  const [anthropicKey, setAnthropicKey] = useState(() => {
    try { return localStorage.getItem('anthropic-api-key') || ""; } catch { return ""; }
  });
  const [pexelsKey, setPexelsKey] = useState(() => {
    try { return localStorage.getItem('pexels-api-key') || ""; } catch { return ""; }
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  // The generation log survives page reloads so a failed or interrupted run always leaves a record.
  const [genLogs, setGenLogs] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem('last-generation-log') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('last-generation-log', JSON.stringify(genLogs.slice(-500))); } catch { /* storage full */ }
  }, [genLogs]);
  const [genLogOpen, setGenLogOpen] = useState(false);
  const genLogEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (genLogOpen) genLogEndRef.current?.scrollIntoView({ block: "end" }); }, [genLogs, genLogOpen]);
  const [editMode, setEditMode] = useState(false);
  const [graphSearchTerm, setGraphSearchTerm] = useState("");
  const [isGraphSearchVisible, setIsGraphSearchVisible] = useState(false);
  const [editingNode, setEditingNode] = useState<KnowledgeNode | null>(null);
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [editingWidgetNodeLabel, setEditingWidgetNodeLabel] = useState<string | null>(null);
  const [widgetEditPanelOpen, setWidgetEditPanelOpen] = useState(false);
  const [selectedNodeLabels, setSelectedNodeLabels] = useState<Set<string>>(new Set());
  const [knowledgeData, setKnowledgeData] = useState<any | null>(null);
  const [dataFolderPath, setDataFolderPath] = useState("");
  const [sourceFilePath, setSourceFilePath] = useState(() => localStorage.getItem('sourceFilePath') || '');
  const [sourceOnly, setSourceOnly] = useState(() => localStorage.getItem('sourceOnly') === 'true');
  const [sourceFileHandle, setSourceFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [isSampleMode, setIsSampleMode] = useState(false);
  const [isMuseumMode] = useState(() => sessionStorage.getItem('museum-mode') === 'true');
  const [isMetMode] = useState(() => sessionStorage.getItem('met-mode') === 'true');
  const [museumDialogOpen, setMuseumDialogOpen] = useState(false);
  const [loadingExample, setLoadingExample] = useState<string | null>(null);
  const [pptxSourceText, setPptxSourceText] = useState("");
  const [pptConvertProgress, setPptConvertProgress] = useState(0);
  const [pptConvertStage, setPptConvertStage] = useState("");
  const [isPptWorkflowActive, setIsPptWorkflowActive] = useState(false);
  const pptDestinationDirRef = useRef<FileSystemDirectoryHandle | null>(null);
  const pptParseResultRef = useRef<Pick<PptxParseResult, "slides" | "images"> | null>(null);

  // Page (header) edits
  const [seoTitleDraft, setSeoTitleDraft] = useState("");
  const [seoDescriptionDraft, setSeoDescriptionDraft] = useState("");
  const [seoDirty, setSeoDirty] = useState(false);
  
  // Generation options
  const [maxTokens, setMaxTokens] = useState(() => parseInt(localStorage.getItem('maxTokens') || '20000', 10));
  const [minNodes, setMinNodes] = useState(() => parseInt(localStorage.getItem('minNodes') || '30', 10));
  const [maxNodes, setMaxNodes] = useState(() => parseInt(localStorage.getItem('maxNodes') || '60', 10));

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [pendingSave, setPendingSave] = useState<{ blob: Blob; filename: string } | null>(null);
  const [treeSize, setTreeSize] = useState({ width: 384, height: 320 });

  // Long-press confirmation dialog state (touch-gesture deletion in edit mode)
  type PendingDelete =
    | { kind: "node"; label: string }
    | { kind: "widget"; widgetName: string; nodeLabel: string; displayLabel: string };
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // Resize handler for the 2D tree panel
  const handleTreeResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = treeSize.width;
    const startH = treeSize.height;
    const onMove = (ev: globalThis.MouseEvent) => {
      setTreeSize({
        width: Math.max(200, startW + ev.clientX - startX),
        height: Math.max(150, startH + ev.clientY - startY),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [treeSize]);
  const particleData = knowledgeData?.knowledgeTree as KnowledgeNode | undefined;
  // Text filter (shared by 2D and 3D); disabled in edit mode so edits apply to the full tree.
  const viewData = useMemo(
    () => (particleData && filterTerm && !editMode ? filterTreeByText(particleData, filterTerm) : particleData),
    [particleData, filterTerm, editMode],
  );
  const showPptWorkflowProgress = isPptWorkflowActive && (pptConvertProgress > 0 || isSubmitting);
  const pptWorkflowStage = pptConvertProgress > 0
    ? pptConvertStage || "Converting PowerPoint…"
    : isSubmitting && pptxSourceText
      ? "Generating knowledge tree from PowerPoint…"
      : "";
  const pptWorkflowProgress = pptConvertProgress > 0 ? pptConvertProgress : generateProgress;

  useEffect(() => {
    if (!knowledgeData) return;
    setSeoTitleDraft(knowledgeData?.seo?.title ?? "");
    setSeoDescriptionDraft(knowledgeData?.seo?.description ?? "");
    setSeoDirty(false);
  }, [knowledgeData]);

  useEffect(() => {
    if (particleData) {
      initializeDfsTraversal(particleData);
    }
  }, [particleData]);

  // Check if user is admin
  useEffect(() => {
    async function checkAdmin() {
      if (!user) {
        setIsAdmin(false);
        return;
      }
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      setIsAdmin(data?.role === "admin");
    }
    checkAdmin();
  }, [user]);

  const collectImagePaths = useCallback((root: KnowledgeNode | undefined): string[] => {
    if (!root) return [];
    const paths = new Set<string>();

    const visit = (n: KnowledgeNode) => {
      const icon = (n as any).icon;
      if (typeof icon === "string" && isValidImageUrl(icon)) paths.add(icon);

      // Legacy behavior: if the node *label itself* is an image path, include it too.
      if (isValidImageUrl(n.node)) paths.add(n.node);

      for (const w of n.widgets ?? []) {
        if (typeof w?.name === "string" && isValidImageUrl(w.name)) paths.add(w.name);
        if (typeof w?.preview === "string" && isValidImageUrl(w.preview)) paths.add(w.preview);
      }

      for (const c of n.children ?? []) visit(c);
    };

    visit(root);
    return Array.from(paths);
  }, []);

  const preloadImages = useCallback(async (imagePaths: string[], concurrency = 8) => {
    if (imagePaths.length === 0) return;

    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, imagePaths.length) }).map(async () => {
      while (i < imagePaths.length) {
        const idx = i++;
        const path = imagePaths[idx];
        try {
          const url = await resolveImageUrl(path);
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = url;
          });
        } catch {
          // ignore
        }
      }
    });

    await Promise.allSettled(workers);
  }, []);

  const setActiveDataFolder = useCallback((handle: FileSystemDirectoryHandle) => {
    setDirHandle(handle);
    setDataFolderPath(handle.name);
    localStorage.setItem('dataFolderPath', handle.name);
  }, [setDirHandle]);

  const ensureWritableDestinationFolder = useCallback(async () => {
    if (dirHandle) return dirHandle;

    if (!("showDirectoryPicker" in window)) {
      toast.error('Folder access is not supported in this browser. Please use Chrome or Edge.');
      return null;
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
      });
      setIsSampleMode(false);
      setActiveDataFolder(handle);
      return handle as FileSystemDirectoryHandle;
    } catch (err: any) {
      if (err.name === 'AbortError') return null;
      toast.error('Failed to select destination folder');
      return null;
    }
  }, [dirHandle, setActiveDataFolder]);

  // Load knowledge.json from selected data folder
  const loadFromDataFolder = async (handle: FileSystemDirectoryHandle) => {
    // IMPORTANT: set the dir handle first so any initial image resolutions use the correct folder.
    setActiveDataFolder(handle);

    let data: any;
    try {
      const fileHandle = await handle.getFileHandle('knowledge.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      const raw = JSON.parse(text);
      data = parseKnowledgeFile(raw);
      // Upgrade older-format files in place to schema 1.0
      if (raw?.schemaVersion !== '1.0') {
        try {
          const writable = await fileHandle.createWritable();
          await writable.write(serializeKnowledgeData(data));
          await writable.close();
          toast.info('Upgraded knowledge.json to schema 1.0');
        } catch (e) {
          console.warn('Could not upgrade knowledge.json', e);
        }
      }
      toast.success(`Loaded knowledge.json from ${handle.name}`);
    } catch (err: any) {
      if (err.name === 'NotFoundError') {
        // Create empty knowledge.json in the graph format
        const emptyData = emptyKnowledgeDocument();
        const fileHandle = await handle.getFileHandle('knowledge.json', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(emptyData, null, 2));
        await writable.close();
        data = parseKnowledgeFile(emptyData);
        toast.info(`Created empty knowledge.json in ${handle.name}`);
      } else {
        console.error('Error loading knowledge.json:', err);
        toast.error(err?.message || 'Failed to load knowledge.json');
        return;
      }

    }

    setKnowledgeData(data);

    // Preload all images referenced in the tree/widgets
    const imagePaths = collectImagePaths(data?.knowledgeTree as KnowledgeNode | undefined);
    void preloadImages(imagePaths);
  };

  // Browse for data folder
  const handleBrowseDataFolder = async () => {
    // Check if File System Access API is supported (Chrome/Edge only, not Safari/Firefox)
    if (!('showDirectoryPicker' in window)) {
      toast.error('Folder access is not supported in this browser. Please use Chrome or Edge.');
      return;
    }
    
    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
      });
      setIsSampleMode(false);
      await loadFromDataFolder(handle);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      toast.error('Failed to select folder');
    }
  };

  // Load sample data from public folder
  const handleViewSample = async () => {
    try {
      const response = await fetch('/data/knowledge.json');
      if (!response.ok) {
        throw new Error('Failed to fetch sample data');
      }
      const data = parseKnowledgeFile(await response.json());
      setKnowledgeData(data);
      setIsSampleMode(true);
      setEditMode(false); // Disable edit mode for sample
      setDirHandle(null); // Clear any folder handle
      setDataFolderPath('');
      toast.success('Loaded sample presentation');

      // Preload images (they're in public folder, no dir handle needed)
      const imagePaths = collectImagePaths(data?.knowledgeTree as KnowledgeNode | undefined);
      void preloadImages(imagePaths);
    } catch (err: any) {
      console.error('Error loading sample data:', err);
      toast.error('Failed to load sample data');
    }
  };

  // Load a knowledge tree built from a British Museum query
  const handleMuseumLoaded = (doc: any) => {
    const data = parseKnowledgeFile(doc);
    setKnowledgeData(data);
    setIsSampleMode(true);
    setEditMode(false);
    setDirHandle(null);
    setDataFolderPath('');
  };

  // Load a prebuilt British Museum example collection
  const handleLoadMuseumExample = async (slug: string, label: string) => {
    if (loadingExample) return;
    setLoadingExample(slug);
    try {
      const response = await fetch(`/data/knowledge-bm-${slug}.json`);
      if (!response.ok) throw new Error('not found');
      const doc = await response.json();
      handleMuseumLoaded(doc);
      toast.success(`Loaded ${label} example`);
      const data = parseKnowledgeFile(doc);
      const imagePaths = collectImagePaths(data?.knowledgeTree as KnowledgeNode | undefined);
      void preloadImages(imagePaths);
    } catch (err) {
      console.error('Error loading museum example:', err);
      toast.error(`The ${label} example is not available yet.`);
    } finally {
      setLoadingExample(null);
    }
  };

  // Load the preloaded MET collection
  const handleLoadMet = async () => {
    if (loadingExample) return;
    setLoadingExample('met');
    try {
      const response = await fetch('/data/knowledge-met.json');
      if (!response.ok) throw new Error('not found');
      const doc = await response.json();
      handleMuseumLoaded(doc);
      const data = parseKnowledgeFile(doc);
      const imagePaths = collectImagePaths(data?.knowledgeTree as KnowledgeNode | undefined);
      void preloadImages(imagePaths);
    } catch (err) {
      console.error('Error loading MET collection:', err);
      toast.error('The MET collection is not available yet.');
    } finally {
      setLoadingExample(null);
    }
  };

  // In MET mode, load the preloaded collection automatically
  const metAutoLoadRef = useRef(false);
  useEffect(() => {
    if (!isMetMode || metAutoLoadRef.current) return;
    metAutoLoadRef.current = true;
    void handleLoadMet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMetMode]);




  // Convert PPT: pick a .pptx file, parse content, feed to generation engine
  const handleConvertPpt = async () => {
    if (!('showOpenFilePicker' in window)) {
      // Fallback for browsers without File System Access API
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pptx';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const destinationHandle = await ensureWritableDestinationFolder();
        if (!destinationHandle) return;
        await processPptxFile(file, destinationHandle);
      };
      input.click();
      return;
    }

    try {
      const [fileHandle] = await (window as any).showOpenFilePicker({
        types: [{ description: 'PowerPoint files', accept: { 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'] } }]
      });
      const file = await fileHandle.getFile();
      const destinationHandle = await ensureWritableDestinationFolder();
      if (!destinationHandle) return;
      await processPptxFile(file, destinationHandle);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      toast.error('Failed to open PowerPoint file');
    }
  };

  const processPptxFile = async (file: File, destinationHandle: FileSystemDirectoryHandle | null) => {
    if (!destinationHandle) {
      toast.error('Select a destination folder to save PPT images and knowledge.json');
      return;
    }

    pptDestinationDirRef.current = destinationHandle;
    setIsPptWorkflowActive(true);
    setIsSampleMode(false);
    setActiveDataFolder(destinationHandle);
    setPptConvertProgress(0);
    setPptConvertStage("Starting…");

    try {
      const { summary, slides, images } = await parsePptx(file, (stage, pct) => {
        setPptConvertStage(stage);
        setPptConvertProgress(pct);
      });

      pptParseResultRef.current = { slides, images };

      if (slides.length === 0) {
        toast.error('No slides found in the PowerPoint file');
        setPptConvertProgress(0);
        setPptConvertStage("");
        return;
      }

      // Save extracted images to the data folder
      let savedImageCount = 0;
      console.log(`[PPT Convert] destination folder: ${destinationHandle.name}, images to save: ${images.length}`);
      if (images.length > 0) {
        setPptConvertStage("Saving images to folder…");
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (img.blob.size === 0) {
            console.warn(`[PPT Convert] Skipping empty blob: ${img.filename}`);
            continue;
          }
          try {
            console.log(`[PPT Convert] Saving ${img.filename} (${img.blob.size} bytes) to ${destinationHandle.name}`);
            const fh = await destinationHandle.getFileHandle(img.filename, { create: true });
            const writable = await fh.createWritable();
            await writable.write(img.blob);
            await writable.close();
            savedImageCount++;
            console.log(`[PPT Convert] Saved ${img.filename} successfully`);
          } catch (err) {
            console.error(`[PPT Convert] Failed to save image ${img.filename}:`, err);
          }
          setPptConvertProgress(92 + Math.round((i / images.length) * 6));
        }
        console.log(`[PPT Convert] Total images saved: ${savedImageCount}/${images.length}`);
      } else {
        console.warn('[PPT Convert] No images were extracted from the PPTX file');
      }

      setPptConvertProgress(100);
      setPptConvertStage("Starting AI generation…");

      // Build an enhanced summary that tells the generator about available images
      let enhancedSummary = summary;
      if (images.length > 0) {
        enhancedSummary += "\n\n--- Available Images ---\n";
        enhancedSummary += "The following image files have been extracted from the presentation and saved to the working directory. ";
        enhancedSummary += "Use these exact filenames as widget 'name' values in the knowledge tree. Do not place them in node icons or preview fields:\n";
        for (const img of images) {
          const slideInfo = img.slideNumbers.map(n => `Slide ${n}`).join(", ");
          enhancedSummary += `- ${img.filename} (from ${slideInfo})\n`;
        }
      }

      toast.success(`Extracted ${slides.length} slides, ${savedImageCount} images. Starting generation...`);

      // Set the topic from filename (without extension)
      const topicFromFile = file.name.replace(/\.pptx$/i, '').replace(/[_-]/g, ' ');
      setTopic(topicFromFile);

      // Store the pptx content so handleSubmit picks it up as source text
      setPptxSourceText(enhancedSummary);
    } catch (err: any) {
      console.error('PPTX parse error:', err);
      toast.error('Failed to parse PowerPoint file');
      setIsPptWorkflowActive(false);
    } finally {
      // Clear conversion state; PPT workflow stays visible while AI generation runs.
      setTimeout(() => {
        setPptConvertProgress(0);
        setPptConvertStage("");
      }, 150);
    }
  };

  // Find a node in the tree by its label
  // Auto-trigger generation when pptxSourceText is set
  useEffect(() => {
    if (pptxSourceText && topic.trim()) {
      handleSubmit({ preventDefault: () => {} } as React.FormEvent);
    }
  }, [pptxSourceText]); // eslint-disable-line react-hooks/exhaustive-deps

  const findNodeByLabel = useCallback((root: KnowledgeNode | undefined, label: string): KnowledgeNode | null => {
    if (!root) return null;
    if (root.node === label) return root;
    for (const child of root.children ?? []) {
      const found = findNodeByLabel(child, label);
      if (found) return found;
    }
    return null;
  }, []);

  // Update a node in the tree
  const updateNodeInTree = useCallback((root: KnowledgeNode, originalLabel: string, updatedNode: KnowledgeNode): KnowledgeNode => {
    if (root.node === originalLabel) {
      return { ...root, ...updatedNode };
    }
    return {
      ...root,
      children: root.children?.map(child => updateNodeInTree(child, originalLabel, updatedNode))
    };
  }, []);

  // Handle node click in edit mode
  const handleNodeClickForEdit = useCallback((nodeLabel: string) => {
    if (!editMode || !particleData) return;
    const node = findNodeByLabel(particleData, nodeLabel);
    if (node) {
      setEditingNode(node);
      setEditPanelOpen(true);
    }
  }, [editMode, particleData, findNodeByLabel]);

  // Toggle node selection for generation context
  const handleToggleSelectNode = useCallback((label: string) => {
    setSelectedNodeLabels(prev => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  // Handle save from edit panel
  const handleSaveNode = useCallback(async (updatedNode: KnowledgeNode) => {
    if (!editingNode || !knowledgeData || !particleData) return;

    const originalLabel = editingNode.node;
    const updatedTree = updateNodeInTree(particleData, originalLabel, updatedNode);
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    // Save to file
    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      // Clear image cache to force re-resolution of icons
      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditingNode(null);
      toast.success("Node updated and saved");
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to save changes");
    }
  }, [editingNode, knowledgeData, particleData, dirHandle, updateNodeInTree]);

  // Handle widget click for edit
  const handleWidgetClickForEdit = useCallback((widget: Widget, nodeLabel: string) => {
    if (!editMode) return;
    setEditingWidget(widget);
    setEditingWidgetNodeLabel(nodeLabel);
    setWidgetEditPanelOpen(true);
  }, [editMode]);

  // Update a widget in a node
  const updateWidgetInNode = useCallback((node: KnowledgeNode, originalWidget: Widget, updatedWidget: Widget): KnowledgeNode => {
    if (!node.widgets) return node;
    return {
      ...node,
      widgets: node.widgets.map(w => 
        w.name === originalWidget.name ? updatedWidget : w
      )
    };
  }, []);

  // Delete a widget from a node
  const deleteWidgetFromNode = useCallback((node: KnowledgeNode, widgetToDelete: Widget): KnowledgeNode => {
    if (!node.widgets) return node;
    return {
      ...node,
      widgets: node.widgets.filter(w => w.name !== widgetToDelete.name)
    };
  }, []);

  // Handle save from widget edit panel
  const handleSaveWidget = useCallback(async (updatedWidget: Widget) => {
    if (!editingWidget || !editingWidgetNodeLabel || !knowledgeData || !particleData) return;

    const targetNode = findNodeByLabel(particleData, editingWidgetNodeLabel);
    if (!targetNode) {
      toast.error("Could not find parent node");
      return;
    }

    const updatedNode = updateWidgetInNode(targetNode, editingWidget, updatedWidget);
    const updatedTree = updateNodeInTree(particleData, editingWidgetNodeLabel, updatedNode);
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    // Save to file
    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      // Clear image cache to force re-resolution
      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditingWidget(null);
      setEditingWidgetNodeLabel(null);
      toast.success("Widget updated and saved");
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to save changes");
    }
  }, [editingWidget, editingWidgetNodeLabel, knowledgeData, particleData, dirHandle, findNodeByLabel, updateWidgetInNode, updateNodeInTree]);

  // Handle delete from widget edit panel
  const handleDeleteWidget = useCallback(async (widgetToDelete: Widget) => {
    if (!editingWidgetNodeLabel || !knowledgeData || !particleData) return;

    const targetNode = findNodeByLabel(particleData, editingWidgetNodeLabel);
    if (!targetNode) {
      toast.error("Could not find parent node");
      return;
    }

    const updatedNode = deleteWidgetFromNode(targetNode, widgetToDelete);
    const updatedTree = updateNodeInTree(particleData, editingWidgetNodeLabel, updatedNode);
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditingWidget(null);
      setEditingWidgetNodeLabel(null);
      setWidgetEditPanelOpen(false);
      toast.success("Widget deleted");
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to delete widget");
    }
  }, [editingWidgetNodeLabel, knowledgeData, particleData, dirHandle, findNodeByLabel, deleteWidgetFromNode, updateNodeInTree]);

  // Add a widget to a node
  const addWidgetToNode = useCallback((node: KnowledgeNode, newWidget: Widget): KnowledgeNode => {
    return {
      ...node,
      widgets: [...(node.widgets || []), newWidget]
    };
  }, []);

  // Add a child node to a parent node
  const addChildToNode = useCallback((node: KnowledgeNode, newChild: KnowledgeNode): KnowledgeNode => {
    return {
      ...node,
      children: [...(node.children || []), newChild]
    };
  }, []);

  // Handle adding a widget from NodeEditPanel
  const handleAddWidgetFromNode = useCallback(async (nodeLabel: string, widget: Widget) => {
    if (!knowledgeData || !particleData) return;

    const targetNode = findNodeByLabel(particleData, nodeLabel);
    if (!targetNode) {
      toast.error("Could not find node");
      return;
    }

    const updatedNode = addWidgetToNode(targetNode, widget);
    const updatedTree = updateNodeInTree(particleData, nodeLabel, updatedNode);
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditPanelOpen(false);
      toast.success("Widget added");
      
      // Open widget edit panel for the new widget
      setEditingWidget(widget);
      setEditingWidgetNodeLabel(nodeLabel);
      setWidgetEditPanelOpen(true);
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to add widget");
    }
  }, [knowledgeData, particleData, dirHandle, findNodeByLabel, addWidgetToNode, updateNodeInTree]);

  // Handle adding a child node from NodeEditPanel
  const handleAddChildNode = useCallback(async (parentLabel: string, childNode: KnowledgeNode) => {
    if (!knowledgeData || !particleData) return;

    const targetNode = findNodeByLabel(particleData, parentLabel);
    if (!targetNode) {
      toast.error("Could not find parent node");
      return;
    }

    const updatedNode = addChildToNode(targetNode, childNode);
    const updatedTree = updateNodeInTree(particleData, parentLabel, updatedNode);
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditPanelOpen(false);
      toast.success("Child node added");
      
      // Open node edit panel for the new child
      setEditingNode(childNode);
      setEditPanelOpen(true);
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to add child node");
    }
  }, [knowledgeData, particleData, dirHandle, findNodeByLabel, addChildToNode, updateNodeInTree]);

  // Delete a node from the tree (removes from parent's children array)
  const deleteNodeFromTree = useCallback((root: KnowledgeNode, nodeToDelete: KnowledgeNode): KnowledgeNode | null => {
    // If root is the node to delete, return null (caller handles this)
    if (root.node === nodeToDelete.node) return null;
    
    return {
      ...root,
      children: root.children
        ?.map(child => deleteNodeFromTree(child, nodeToDelete))
        .filter((child): child is KnowledgeNode => child !== null)
    };
  }, []);

  // Handle delete from node edit panel
  const handleDeleteNode = useCallback(async (nodeToDelete: KnowledgeNode) => {
    if (!knowledgeData || !particleData) return;

    // Don't allow deleting root node
    if (particleData.node === nodeToDelete.node) {
      toast.error("Cannot delete the root node");
      return;
    }

    const updatedTree = deleteNodeFromTree(particleData, nodeToDelete);
    if (!updatedTree) {
      toast.error("Cannot delete the root node");
      return;
    }
    
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };

    try {
      if (!dirHandle) {
        toast.error("No data folder selected");
        return;
      }
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();

      clearImageCache();
      
      setKnowledgeData(updatedData);
      setEditingNode(null);
      setEditPanelOpen(false);
      toast.success("Node deleted");
    } catch (err: any) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to delete node");
    }
  }, [knowledgeData, particleData, dirHandle, deleteNodeFromTree]);

  // -------------------- Touch-gesture wrappers --------------------
  // These accept labels (what gesture detection produces) and reuse the
  // existing tree mutation helpers. They show a toast with Undo so the user
  // can recover from accidental destructive gestures.

  const persistTree = useCallback(async (updatedTree: KnowledgeNode) => {
    if (!knowledgeData) return false;
    const updatedData = { ...knowledgeData, knowledgeTree: updatedTree };
    if (!dirHandle) {
      // Sample mode / no folder — still update in-memory state so the UI
      // reflects the gesture, but warn the user.
      setKnowledgeData(updatedData);
      toast.warning("No data folder selected — change is not persisted");
      return true;
    }
    try {
      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(serializeKnowledgeData(updatedData));
      await writable.close();
      clearImageCache();
      setKnowledgeData(updatedData);
      return true;
    } catch (err) {
      console.error('Error saving knowledge.json:', err);
      toast.error("Failed to save changes");
      return false;
    }
  }, [knowledgeData, dirHandle]);

  // Long-press in edit mode opens a confirmation dialog before deleting.
  // The pending delete is held in `pendingDelete` until the user confirms.
  const handleGestureLongPressNode = useCallback((label: string) => {
    if (!editMode || !particleData) return;
    if (particleData.node === label) {
      toast.error("Cannot delete the root node");
      return;
    }
    setPendingDelete({ kind: "node", label });
  }, [editMode, particleData]);

  const handleGestureLongPressWidget = useCallback((widgetName: string, nodeLabel: string) => {
    if (!editMode || !particleData) return;
    const target = findNodeByLabel(particleData, nodeLabel);
    const widget = target?.widgets?.find(w => w.name === widgetName);
    if (!widget) return;
    setPendingDelete({
      kind: "widget",
      widgetName,
      nodeLabel,
      displayLabel: widget.title || widget.name,
    });
  }, [editMode, particleData, findNodeByLabel]);

  const confirmPendingDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target || !knowledgeData || !particleData) {
      setPendingDelete(null);
      return;
    }
    const previousData = knowledgeData;
    const previousParticle = particleData;
    if (target.kind === "node") {
      const node = findNodeByLabel(particleData, target.label);
      if (!node) { setPendingDelete(null); return; }
      const updatedTree = deleteNodeFromTree(particleData, node);
      if (!updatedTree) { setPendingDelete(null); return; }
      const ok = await persistTree(updatedTree);
      setPendingDelete(null);
      if (!ok) return;
      setEditingNode(null);
      setEditPanelOpen(false);
      toast.success(`Deleted "${target.label}"`, {
        action: {
          label: "Undo",
          onClick: async () => {
            await persistTree(previousParticle);
            setKnowledgeData(previousData);
          },
        },
        duration: 5000,
      });
    } else {
      const node = findNodeByLabel(particleData, target.nodeLabel);
      const widget = node?.widgets?.find(w => w.name === target.widgetName);
      if (!node || !widget) { setPendingDelete(null); return; }
      const updatedNode = deleteWidgetFromNode(node, widget);
      const updatedTree = updateNodeInTree(particleData, target.nodeLabel, updatedNode);
      const ok = await persistTree(updatedTree);
      setPendingDelete(null);
      if (!ok) return;
      toast.success(`Deleted widget "${target.displayLabel}"`, {
        action: {
          label: "Undo",
          onClick: async () => {
            await persistTree(previousParticle);
            setKnowledgeData(previousData);
          },
        },
        duration: 5000,
      });
    }
  }, [pendingDelete, knowledgeData, particleData, findNodeByLabel, deleteNodeFromTree, deleteWidgetFromNode, updateNodeInTree, persistTree]);

  const handleGestureCreateChildNode = useCallback(async (parentLabel: string) => {
    if (!editMode || !knowledgeData || !particleData) return;
    const parent = findNodeByLabel(particleData, parentLabel);
    if (!parent) return;
    const newChild: KnowledgeNode = { node: "<node>", weight: 50 };
    const previousData = knowledgeData;
    const previousTree = particleData;
    const updatedNode = addChildToNode(parent, newChild);
    const updatedTree = updateNodeInTree(previousTree, parentLabel, updatedNode);
    const ok = await persistTree(updatedTree);
    if (!ok) return;
    toast.success(`Added child to "${parentLabel}"`, {
      action: {
        label: "Undo",
        onClick: async () => {
          await persistTree(previousTree);
          setKnowledgeData(previousData);
        },
      },
      duration: 5000,
    });
    // Open edit panel on the new child for naming
    setEditingNode(newChild);
    setEditPanelOpen(true);
  }, [editMode, knowledgeData, particleData, findNodeByLabel, addChildToNode, updateNodeInTree, persistTree]);

  const handleGestureCreateWidget = useCallback(async (parentLabel: string) => {
    if (!editMode || !knowledgeData || !particleData) return;
    const parent = findNodeByLabel(particleData, parentLabel);
    if (!parent) return;
    const newWidget: Widget = {
      name: `widget-${Date.now()}`,
      title: "<widget>",
    };
    const previousData = knowledgeData;
    const previousTree = particleData;
    const updatedNode = addWidgetToNode(parent, newWidget);
    const updatedTree = updateNodeInTree(previousTree, parentLabel, updatedNode);
    const ok = await persistTree(updatedTree);
    if (!ok) return;
    toast.success(`Added widget to "${parentLabel}"`, {
      action: {
        label: "Undo",
        onClick: async () => {
          await persistTree(previousTree);
          setKnowledgeData(previousData);
        },
      },
      duration: 5000,
    });
    setEditingWidget(newWidget);
    setEditingWidgetNodeLabel(parentLabel);
    setWidgetEditPanelOpen(true);
  }, [editMode, knowledgeData, particleData, findNodeByLabel, addWidgetToNode, updateNodeInTree, persistTree]);

  const [spot, setSpot] = useState<{ x: number; y: number }>({ x: 50, y: 50 });

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setSpot({ x, y });
  };

  const handleSubmit = async (e?: React.FormEvent, resume?: { jobId: string; topic: string }) => {
    e?.preventDefault();
    const genTopic = resume?.topic ?? topic;
    if (!resume && !topic.trim()) {
      toast.error("Please enter a topic");
      return;
    }
    // Keys live in this browser only (incognito and each address such as localhost:5000 start empty)
    if (!resume && !anthropicKey.trim()) {
      toast.error("Add your Anthropic API key in Settings (gear icon, top left) before generating. Keys are saved per browser, so incognito windows and new addresses start empty.", { duration: 12000 });
      return;
    }

    const animateProgressTo = (target: number, durationMs = 900) => {
      return new Promise<void>((resolve) => {
        let from = 0;
        setGenerateProgress((prev) => {
          from = prev;
          return prev;
        });

        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / durationMs);
          const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
          const value = from + (target - from) * eased;
          setGenerateProgress(value);
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };

        requestAnimationFrame(tick);
      });
    };

    setIsSubmitting(true);
    setGenerateProgress(0);
    const genStartMs = Date.now();
    if (resume) {
      setGenLogs([`Page was reloaded: resuming job ${resume.jobId.slice(0, 8)} for "${genTopic}"...`]);
      setGenLogOpen(true);
      toast.info(`Resuming generation for: ${genTopic}`);
    } else {
      setGenLogs([`00:00  Starting generation for "${genTopic}"...`]);
      if (pptxSourceText) {
        setPptConvertProgress(0);
        setPptConvertStage("");
      }
      toast.info(`Generating knowledge tree for: ${genTopic}... This may take several minutes.`);
    }

    // Simulated progress - time-based asymptotic curve tuned so ~90% aligns with a ~5 minute total.
    // progress = 90 * (1 - exp(-t / tau)); tau chosen so t=300s → ~82%, t=450s → ~87%.
    const progressStartedAt = Date.now();
    const TAU_MS = 120_000;
    const progressInterval = setInterval(() => {
      setGenerateProgress((prev) => {
        const cap = 90;
        if (prev >= cap) return prev;
        const elapsed = Date.now() - progressStartedAt;
        const target = cap * (1 - Math.exp(-elapsed / TAU_MS));
        return target > prev ? target : prev;
      });
    }, 1000);

    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let didComplete = false;
    let awaitingSave = false;

    try {
      let jobId: string;
      if (resume) {
        jobId = resume.jobId;
      } else {
      // Read source file content - first check pptxSourceText, then try sourceFileHandle,
      // then fall back to reading from data folder
      let sourceText = pptxSourceText || '';
      if (!sourceText && sourceFileHandle) {
        try {
          const file = await sourceFileHandle.getFile();
          sourceText = await file.text();
        } catch (err) {
          console.warn('Could not read source file from handle:', err);
          toast.warning('Could not read source file');
        }
      } else if (sourceFilePath && dirHandle) {
        try {
          const sourceHandle = await dirHandle.getFileHandle(sourceFilePath);
          const file = await sourceHandle.getFile();
          sourceText = await file.text();
        } catch (err) {
          console.warn('Could not read source file from data folder:', err);
          toast.warning(`Source file "${sourceFilePath}" not found in data folder`);
        }
      }

      // Collect selected node JSON objects for context
      const contextNodes: KnowledgeNode[] = [];
      if (selectedNodeLabels.size > 0 && particleData) {
        for (const label of selectedNodeLabels) {
          const node = findNodeByLabel(particleData, label);
          if (node) contextNodes.push(node);
        }
      }

      // Start the background job
      const startResponse = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-knowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          topic,
          sourceText,
          sourceOnly,
          maxTokens,
          minNodes,
          maxNodes,
          contextNodes: contextNodes.length > 0 ? contextNodes : undefined,
          anthropicKey: anthropicKey.trim() || undefined,
          pexelsKey: pexelsKey.trim() || undefined,
        }),
      });

      if (!startResponse.ok) {
        const errorData = await startResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to start generation: ${startResponse.status}`);
      }

      const started = await startResponse.json();
      if (typeof started.jobId !== 'string' || !started.jobId) throw new Error('Generation did not return a job ID');
      jobId = started.jobId;
      console.log(`Generation job started: ${jobId}`);
      localStorage.setItem('last-generation-job', jobId);
      // Remembered until the result is handled, so a reload resumes instead of losing the run
      localStorage.setItem('active-generation-job', JSON.stringify({ jobId, topic: genTopic }));
      setGenLogs((prev) => [...prev, `00:0${Math.min(9, Math.floor((Date.now() - genStartMs) / 1000))}  Job queued (${jobId.slice(0, 8)})`]);
      }

      // Poll for completion (no client-side timeout)
      const POLL_INTERVAL = 2000;
      const keepLogs = resume ? 1 : 2;

      let lastLogCount = 0;
      let lastLogChange = Date.now();
      const pollForResult = (): Promise<any> => {
        return new Promise((resolve, reject) => {
          pollInterval = setInterval(async () => {
            try {
              const statusResponse = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-knowledge`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
                },
                body: JSON.stringify({ jobId }),
              });

              if (!statusResponse.ok) {
                if (statusResponse.status < 500 && statusResponse.status !== 429) {
                  const errorData = await statusResponse.json().catch(() => ({}));
                  if (pollInterval) clearInterval(pollInterval);
                  reject(new Error(errorData.error || `Cannot retrieve generation: HTTP ${statusResponse.status}`));
                  return;
                }
                if (Date.now() - lastLogChange > 6 * 60_000) {
                  if (pollInterval) clearInterval(pollInterval);
                  reject(new Error('Cannot retrieve generation progress. Check your connection and try again.'));
                  return;
                }
                console.warn('Poll request failed, retrying...');
                return;
              }

              const job = await statusResponse.json();
              if (Array.isArray(job.logs) && job.logs.length) {
                setGenLogs((prev) => [...prev.slice(0, keepLogs), ...job.logs]);
                if (job.logs.length !== lastLogCount) { lastLogCount = job.logs.length; lastLogChange = Date.now(); }
              }
              if (job.status !== 'completed' && job.status !== 'failed' && Date.now() - lastLogChange > 6 * 60_000) {
                if (pollInterval) clearInterval(pollInterval);
                reject(new Error('Generation stalled (no progress for 6 minutes). Please try again.'));
                return;
              }
              
              if (job.status === 'completed') {
                if (pollInterval) clearInterval(pollInterval);
                resolve(job.result);
              } else if (job.status === 'failed') {
                if (pollInterval) clearInterval(pollInterval);
                reject(new Error(job.error || 'Generation failed'));
              }
              // Otherwise keep polling (status is 'queued' or 'processing')
            } catch (err) {
              console.warn('Poll error, retrying...', err);
            }
          }, POLL_INTERVAL);
        });
      };

      const data = await pollForResult();

      // If contextNodes were used, merge new children into existing tree
      let finalData = data;
      if (selectedNodeLabels.size > 0 && particleData && Array.isArray(data)) {
        // data is an array of { parentNode, newChildren }
        let updatedTree = { ...particleData };
        for (const entry of data) {
          const parentNode = findNodeByLabel(updatedTree, entry.parentNode);
          if (parentNode) {
            const updated = {
              ...parentNode,
              children: [...(parentNode.children || []), ...(entry.newChildren || [])],
            };
            updatedTree = updateNodeInTree(updatedTree, entry.parentNode, updated);
          }
        }
        finalData = { ...knowledgeData, knowledgeTree: updatedTree };
        setSelectedNodeLabels(new Set()); // clear selection after generation
      }

      // Coerce whatever came back (graph, or nested tree with node/name/label keys)
      // into the nested tree first; slide images must be applied to the nested tree.
      finalData = coerceGeneratedDocument(finalData);
      finalData = applyPptImagesToKnowledgeData(finalData, pptParseResultRef.current);
      if (!finalData?.knowledgeTree || typeof finalData.knowledgeTree.node !== "string") {
        throw new Error("Generated content was not a valid knowledge tree");
      }

      // Ensure depth-based weights are applied (server does this too, but safety net)
      if (finalData?.knowledgeTree) {
        const assignWeights = (node: any, depth = 0) => {
          node.weight = Math.max(1, Math.round(100 / Math.pow(2, depth)));
          if (node.children) node.children.forEach((c: any) => assignWeights(c, depth + 1));
        };
        assignWeights(finalData.knowledgeTree);
      }

      // Save directly to the data folder if one is selected
      const countNodes = (n: any): number => 1 + (n?.children || []).reduce((a: number, c: any) => a + countNodes(c), 0);
      const nodeCount = countNodes(finalData.knowledgeTree);
      setGenLogs((prev) => [...prev, `Received tree with ${nodeCount} topics`]);
      clearImageCache();
      setKnowledgeData(finalData);
      didComplete = true;
      toast.success(`Knowledge tree generated for: ${genTopic}`);
      const outputDirHandle = pptDestinationDirRef.current ?? dirHandle;
      if (outputDirHandle) {
        try {
          const fileHandle = await outputDirHandle.getFileHandle('knowledge.json', { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(serializeKnowledgeData(finalData));
          await writable.close();
          
          clearImageCache();
          setKnowledgeData(finalData);
          setGenLogs((prev) => [...prev, `DONE: saved ${nodeCount} topics to ${outputDirHandle.name}/knowledge.json`]);
          toast.success(`Saved ${nodeCount} topics to ${outputDirHandle.name}/knowledge.json`, { duration: 10000 });
        } catch (err: any) {
          console.error('Error saving to data folder:', err);
          setGenLogs((prev) => [...prev, `FAILED to save to folder: ${err?.message || err}`]);
          setGenLogOpen(true);
          toast.error('Failed to save to data folder');
        }
      } else {
        const jsonString = serializeKnowledgeData(finalData);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const filename = 'knowledge.json';
        setGenLogs((prev) => [...prev, `DONE: ${nodeCount} topics ready, choose where to save knowledge.json`]);
        setPendingSave({ blob, filename });
        setSaveDialogOpen(true);
        awaitingSave = true;
      }
    } catch (error: any) {
      const msg = error?.message || 'Failed to generate knowledge tree';
      setGenLogs((prev) => [...prev, `FAILED: ${msg}`]);
      setGenLogOpen(true);
      toast.error(msg, { duration: 15000 });
    } finally {
      if (pollInterval) clearInterval(pollInterval);
      clearInterval(progressInterval);
      // Keep the job remembered while the save window is open, so a reload can still recover it
      if (!awaitingSave) localStorage.removeItem('active-generation-job');

      if (didComplete) {
        // Smoothly animate the last stretch to 100% so it never jumps (e.g. 68 -> 100)
        await animateProgressTo(100, 800);
        setTimeout(() => {
          setIsSubmitting(false);
          setGenerateProgress(0);
        }, 250);
      } else {
        // On failure, quickly clear the progress so we don't misleadingly show 100%
        await animateProgressTo(0, 250);
        setIsSubmitting(false);
        setGenerateProgress(0);
      }
      // Clear pptx workflow state after generation
      setPptxSourceText("");
      setPptConvertProgress(0);
      setPptConvertStage("");
      setIsPptWorkflowActive(false);
      pptDestinationDirRef.current = null;
      pptParseResultRef.current = null;
    }
  };


  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleSavePending = useCallback(async () => {
    if (!pendingSave) return;

    try {
      const picker = (window as any).showSaveFilePicker as undefined | ((options: any) => Promise<any>);
      if (!picker) {
        triggerDownload(pendingSave.blob, pendingSave.filename);
        toast.success('Downloaded knowledge.json');
        return;
      }

      const handle = await picker({
        suggestedName: pendingSave.filename,
        types: [{
          description: 'JSON files',
          accept: { 'application/json': ['.json'] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(pendingSave.blob);
      await writable.close();
      toast.success('Saved knowledge.json');
    } catch {
      // If the picker fails (permissions, unsupported), fall back to download.
      triggerDownload(pendingSave.blob, pendingSave.filename);
      toast.success('Downloaded knowledge.json');
    } finally {
      setSaveDialogOpen(false);
      setPendingSave(null);
      localStorage.removeItem('active-generation-job');
    }
  }, [pendingSave, triggerDownload]);

  // Resume a generation that was still running (or unsaved) when the page reloaded
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (resumeCheckedRef.current || isSampleMode) return;
    resumeCheckedRef.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem('active-generation-job') || 'null');
      if (saved && typeof saved.jobId === 'string') {
        handleSubmit(undefined, { jobId: saved.jobId, topic: String(saved.topic || '') });
      }
    } catch { localStorage.removeItem('active-generation-job'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSampleMode]);

  const SaveKnowledgeDialog = (
    <Dialog
      open={saveDialogOpen}
      onOpenChange={(open) => {
        setSaveDialogOpen(open);
        if (!open) { setPendingSave(null); localStorage.removeItem('active-generation-job'); }
      }}
    >
      <DialogContent
        // Only the buttons close this window; a stray click or focus change must not discard the result
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Save generated file</DialogTitle>
          <DialogDescription>
            Your knowledge tree is ready. Choose where to save <span className="font-medium">{pendingSave?.filename ?? 'knowledge.json'}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSaveDialogOpen(false);
              setPendingSave(null);
              localStorage.removeItem('active-generation-job');
              setGenLogs((prev) => [...prev, 'Save skipped: generated tree is shown but not saved to a file']);
            }}
          >
            Not now
          </Button>
          <Button type="button" onClick={handleSavePending}>
            Save…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Show empty state if no data loaded
  if (!knowledgeData || !particleData) {
    return (
      <>
        <SEO title="Knowledge Tree" description="Select a data folder to load knowledge.json" />
        {SaveKnowledgeDialog}
        <header className="relative">
          <div className="absolute top-4 left-4 z-50">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Settings className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[400px]">
                <SheetHeader>
                  <SheetTitle>Settings</SheetTitle>
                </SheetHeader>
                <div className="mt-6 space-y-6">
                  <div className="space-y-2">
                  <Label htmlFor="anthropicKey1">Anthropic API Key</Label>
                  <Input
                    id="anthropicKey1"
                    type="password"
                    placeholder="sk-ant-..."
                    value={anthropicKey}
                    onChange={(e) => { setAnthropicKey(e.target.value); try { localStorage.setItem('anthropic-api-key', e.target.value); } catch {} }}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Saved only in this browser. Used for topic generation.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pexelsKey1">Pexels API Key</Label>
                  <Input
                    id="pexelsKey1"
                    type="password"
                    placeholder="Pexels API key"
                    value={pexelsKey}
                    onChange={(e) => { setPexelsKey(e.target.value); try { localStorage.setItem('pexels-api-key', e.target.value); } catch {} }}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="dataFolder">Data Folder Location</Label>
                    <div className="flex gap-2">
                      <Input
                        id="dataFolder"
                        placeholder="Select data folder..."
                        value={dataFolderPath}
                        readOnly
                        className="flex-1"
                      />
                      <Button variant="outline" size="icon" onClick={handleBrowseDataFolder}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <div className="border-t pt-4">
                    <h3 className="text-sm font-semibold mb-4">Generation Options</h3>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="sourceFile">Source File Path</Label>
                        <div className="flex gap-2">
                          <Input
                            id="sourceFile"
                            placeholder="Path to source file..."
                            value={sourceFilePath}
                            onChange={(e) => {
                              setSourceFilePath(e.target.value);
                              localStorage.setItem('sourceFilePath', e.target.value);
                            }}
                            className="flex-1"
                          />
                          <Button variant="outline" size="icon" onClick={async () => {
                            try {
                              const [fileHandle] = await (window as any).showOpenFilePicker({
                                types: [{ description: 'Text files', accept: { 'text/*': ['.txt', '.md', '.json'] } }]
                              });
                              setSourceFileHandle(fileHandle);
                              const file = await fileHandle.getFile();
                              setSourceFilePath(file.name);
                              localStorage.setItem('sourceFilePath', file.name);
                            } catch (e) {
                              // User cancelled
                            }
                          }}>
                            <FileText className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="sourceOnly"
                          checked={sourceOnly}
                          onCheckedChange={(checked) => {
                            const value = checked === true;
                            setSourceOnly(value);
                            localStorage.setItem('sourceOnly', String(value));
                          }}
                        />
                        <Label htmlFor="sourceOnly" className="text-sm font-normal">
                          Use source file *only* for content generation
                        </Label>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="maxTokens">Max Tokens</Label>
                        <Input
                          id="maxTokens"
                          type="number"
                          value={maxTokens}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10) || 20000;
                            setMaxTokens(value);
                            localStorage.setItem('maxTokens', String(value));
                          }}
                          min={1000}
                          max={100000}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="minNodes">Min Nodes</Label>
                          <Input
                            id="minNodes"
                            type="number"
                            value={minNodes}
                            onChange={(e) => {
                              const value = parseInt(e.target.value, 10) || 30;
                              setMinNodes(value);
                              localStorage.setItem('minNodes', String(value));
                            }}
                            min={5}
                            max={100}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="maxNodes">Max Nodes</Label>
                          <Input
                            id="maxNodes"
                            type="number"
                            value={maxNodes}
                            onChange={(e) => {
                              const value = parseInt(e.target.value, 10) || 60;
                              setMaxNodes(value);
                              localStorage.setItem('maxNodes', String(value));
                            }}
                            min={10}
                            max={200}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <div className="absolute top-4 right-4 z-50 flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex items-center justify-center min-h-screen">
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold text-foreground">Welcome to Dynamic Tree</h1>
            <p className="text-muted-foreground">Start with one of the options below:</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              {isMetMode ? (
                <Button className={pressCls} onClick={handleLoadMet} disabled={!!loadingExample}>
                  {loadingExample === 'met' ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4 mr-2" />
                  )}
                  {loadingExample === 'met' ? 'Loading MET Collection…' : 'MET Collection'}
                </Button>
              ) : isMuseumMode ? (
                <>
                  <Button className={pressCls} onClick={() => setMuseumDialogOpen(true)} disabled={!!loadingExample}>
                    <Landmark className="h-4 w-4 mr-2" />
                    Query British Museum
                  </Button>
                  {([['coins', 'Coins'], ['sculpture', 'Sculpture'], ['pottery', 'Pottery']] as const).map(([slug, label]) => (
                    <Button
                      key={slug}
                      variant="outline"
                      className={pressCls}
                      onClick={() => handleLoadMuseumExample(slug, label)}
                      disabled={!!loadingExample}
                    >
                      {loadingExample === slug ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Eye className="h-4 w-4 mr-2" />
                      )}
                      {loadingExample === slug ? `Loading ${label}…` : `Example: ${label}`}
                    </Button>
                  ))}
                </>
              ) : (
                <>
                  <Button variant="outline" className={pressCls} onClick={handleViewSample}>
                    <Eye className="h-4 w-4 mr-2" />
                    View Sample
                  </Button>
                  <Button className={pressCls} onClick={handleBrowseDataFolder}>
                    <FolderOpen className="h-4 w-4 mr-2" />
                    Select Data Folder
                  </Button>
                  <Button variant="outline" className={pressCls} onClick={handleConvertPpt} disabled={pptConvertProgress > 0}>
                    <Presentation className="h-4 w-4 mr-2" />
                    Convert PPT
                  </Button>
                </>
              )}
            </div>
            <MuseumQueryDialog
              open={museumDialogOpen}
              onOpenChange={setMuseumDialogOpen}
              onLoaded={handleMuseumLoaded}
            />
            {showPptWorkflowProgress && (
              <div className="mt-4 w-full max-w-md mx-auto rounded-xl border border-border bg-card/90 p-4 text-left shadow-lg backdrop-blur-sm space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">PowerPoint import in progress</p>
                    <p className="text-xs text-muted-foreground">{pptWorkflowStage}</p>
                  </div>
                  <span className="text-sm font-semibold text-foreground whitespace-nowrap">{Math.round(pptWorkflowProgress)}%</span>
                </div>
                <Progress value={pptWorkflowProgress} className="h-3" />
                <p className="text-xs text-muted-foreground">
                  {pptConvertProgress > 0 ? "Extracting slides, text, and images…" : "AI generation is running — this can take a few minutes."}
                </p>
                {pptConvertProgress === 0 && (
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Estimated total time: ~5 minutes
                  </p>
                )}
              </div>
            )}
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <SEO
        title={knowledgeData.seo?.title || "Knowledge Tree"}
        description={knowledgeData.seo?.description || ""}
      />
      {SaveKnowledgeDialog}
      <header className="relative">
        <div className="absolute top-4 left-4 z-50 flex items-center gap-1">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Settings className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[400px]">
              <SheetHeader>
                <SheetTitle>Settings</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="anthropicKey2">Anthropic API Key</Label>
                  <Input
                    id="anthropicKey2"
                    type="password"
                    placeholder="sk-ant-..."
                    value={anthropicKey}
                    onChange={(e) => { setAnthropicKey(e.target.value); try { localStorage.setItem('anthropic-api-key', e.target.value); } catch {} }}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Saved only in this browser. Used for topic generation.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pexelsKey2">Pexels API Key</Label>
                  <Input
                    id="pexelsKey2"
                    type="password"
                    placeholder="Pexels API key"
                    value={pexelsKey}
                    onChange={(e) => { setPexelsKey(e.target.value); try { localStorage.setItem('pexels-api-key', e.target.value); } catch {} }}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dataFolder2">Data Folder Location</Label>
                  <div className="flex gap-2">
                    <Input
                      id="dataFolder2"
                      placeholder="Select data folder..."
                      value={dataFolderPath}
                      readOnly
                      className="flex-1"
                    />
                    <Button variant="outline" size="icon" onClick={handleBrowseDataFolder}>
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                
                <div className="border-t pt-4">
                  <h3 className="text-sm font-semibold mb-4">Generation Options</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="sourceFile2">Source File Path</Label>
                      <div className="flex gap-2">
                        <Input
                          id="sourceFile2"
                          placeholder="Path to source file..."
                          value={sourceFilePath}
                          onChange={(e) => {
                            setSourceFilePath(e.target.value);
                            localStorage.setItem('sourceFilePath', e.target.value);
                          }}
                          className="flex-1"
                        />
                        <Button variant="outline" size="icon" onClick={async () => {
                          try {
                            const [fileHandle] = await (window as any).showOpenFilePicker({
                              types: [{ description: 'Text files', accept: { 'text/*': ['.txt', '.md', '.json'] } }]
                            });
                            setSourceFileHandle(fileHandle);
                            const file = await fileHandle.getFile();
                            setSourceFilePath(file.name);
                            localStorage.setItem('sourceFilePath', file.name);
                          } catch (e) {
                            // User cancelled
                          }
                        }}>
                          <FileText className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="sourceOnly2"
                        checked={sourceOnly}
                        onCheckedChange={(checked) => {
                          const value = checked === true;
                          setSourceOnly(value);
                          localStorage.setItem('sourceOnly', String(value));
                        }}
                      />
                      <Label htmlFor="sourceOnly2" className="text-sm font-normal">
                        Use source file only for content generation
                      </Label>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxTokens2">Max Tokens</Label>
                      <Input
                        id="maxTokens2"
                        type="number"
                        value={maxTokens}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10) || 20000;
                          setMaxTokens(value);
                          localStorage.setItem('maxTokens', String(value));
                        }}
                        min={1000}
                        max={100000}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="minNodes2">Min Nodes</Label>
                        <Input
                          id="minNodes2"
                          type="number"
                          value={minNodes}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10) || 30;
                            setMinNodes(value);
                            localStorage.setItem('minNodes', String(value));
                          }}
                          min={5}
                          max={100}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="maxNodes2">Max Nodes</Label>
                        <Input
                          id="maxNodes2"
                          type="number"
                          value={maxNodes}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10) || 60;
                            setMaxNodes(value);
                            localStorage.setItem('maxNodes', String(value));
                          }}
                          min={10}
                          max={200}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
          <Button 
            variant="ghost" 
            size="icon"
            onClick={async () => {
              if (dirHandle) {
                clearImageCache();
                await loadFromDataFolder(dirHandle);
              } else {
                toast.error('No data folder selected');
              }
            }}
            title="Refresh knowledge.json"
          >
            <RefreshCw className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Search nodes & widgets (3D)"
            onClick={() => {
              setIsGraphSearchVisible((v) => {
                if (v) setGraphSearchTerm("");
                return !v;
              });
            }}
          >
            <Search className="h-5 w-5" />
          </Button>
          {isGraphSearchVisible && (
            <div className="relative">
              <Input
                autoFocus
                value={graphSearchTerm}
                onChange={(e) => setGraphSearchTerm(e.target.value)}
                placeholder="Search nodes & widgets..."
                className="w-56 pr-8 bg-card/90 backdrop-blur-sm shadow-lg"
              />
              {graphSearchTerm && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setGraphSearchTerm("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <Button
            variant={filterTerm ? "secondary" : "ghost"}
            size="icon"
            title="Filter nodes"
            aria-label="Filter nodes"
            onClick={() => setIsFilterVisible((v) => !v)}
          >
            <Filter className="h-5 w-5" />
          </Button>
          {isFilterVisible && (
            <div className="relative">
              <Input
                autoFocus
                value={filterTerm}
                onChange={(e) => setFilterTerm(e.target.value)}
                placeholder="Show only nodes matching..."
                className="w-56 pr-8 bg-card/90 backdrop-blur-sm shadow-lg"
              />
              {filterTerm && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => setFilterTerm("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="absolute top-4 right-4 z-50 flex items-center gap-2">
          {!isSampleMode && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleConvertPpt} disabled={isSubmitting || pptConvertProgress > 0}>
                <Presentation className="h-4 w-4 mr-1" />
                Convert PPT
              </Button>
              {showPptWorkflowProgress && (
                <div className="flex items-center gap-2 min-w-[220px] rounded-lg border border-border bg-card/80 px-3 py-2 backdrop-blur-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium text-foreground">{pptWorkflowStage || "Processing…"}</p>
                    <Progress value={pptWorkflowProgress} className="mt-1 h-2 w-full" />
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{Math.round(pptWorkflowProgress)}%</span>
                </div>
              )}
            </div>
          )}
          {!isSampleMode && (
            <>
              <form onSubmit={handleSubmit} className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder="Enter topic..."
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  className="w-48"
                  disabled={isSubmitting}
                />
                <Button 
                  type="submit" 
                  disabled={isSubmitting}
                  className="relative overflow-hidden min-w-[110px]"
                >
                  {isSubmitting && (
                    <div 
                      className="absolute inset-0 bg-green-500/80 transition-all duration-300 ease-out"
                      style={{ width: `${generateProgress}%` }}
                    />
                  )}
                  <span className="relative z-10">
                    {isSubmitting ? `${Math.round(generateProgress)}%` : "Generate"}
                  </span>
                </Button>
              </form>
              {(isSubmitting || genLogs.length > 0) && !pptxSourceText && (
                <div className="w-48">
                  {isSubmitting && <Progress value={generateProgress} className="h-2" />}
                  <button
                    type="button"
                    onClick={() => setGenLogOpen((o) => !o)}
                    className="mt-1 flex w-full items-center justify-center gap-1 text-[10px] text-muted-foreground/80 italic hover:text-foreground"
                    aria-expanded={genLogOpen}
                  >
                    <span className={`inline-block transition-transform ${genLogOpen ? "rotate-90" : ""}`}>▶</span>
                    {isSubmitting ? "Estimated total time: ~5 minutes" : "Last generation log"}
                  </button>
                  {genLogOpen && (
                    <div className="fixed right-4 top-24 z-[600] w-[28rem] max-w-[90vw] rounded-md border border-border bg-background/95 shadow-lg backdrop-blur">
                      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs font-semibold text-foreground">
                        Generation log
                        <button type="button" onClick={() => setGenLogOpen(false)} className="text-muted-foreground hover:text-foreground">✕</button>
                      </div>
                      <div className="h-64 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {genLogs.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
                        <div ref={genLogEndRef} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {!isSampleMode && (
            <Button 
              variant={editMode ? "default" : "outline"} 
              onClick={() => {
                const newMode = !editMode;
                setEditMode(newMode);
                if (!newMode) setSelectedNodeLabels(new Set()); // clear selection on exit
              }}
              className={editMode ? "bg-orange-500 hover:bg-orange-600" : ""}
            >
              <Pencil className="h-4 w-4 mr-2" />
              {editMode ? "Exit Edit" : "Edit"}
            </Button>
          )}
          <ThemeToggle />
        </div>
        {editMode && (
          <div className="absolute top-16 right-4 z-50 bg-orange-500 text-white px-3 py-1 rounded-md text-sm font-medium">
            Edit Mode: Click node to edit • Shift+Click to select for generation
            {selectedNodeLabels.size > 0 && (
              <span className="ml-2 bg-blue-600 px-2 py-0.5 rounded text-xs">
                {selectedNodeLabels.size} selected
                <button 
                  className="ml-1 underline" 
                  onClick={() => setSelectedNodeLabels(new Set())}
                >
                  clear
                </button>
              </span>
            )}
          </div>
        )}
        <div
          onMouseMove={onMove}
          className="relative mx-auto max-w-5xl px-6 pt-8 pb-4"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background: `radial-gradient(600px 300px at ${spot.x}% ${spot.y}%, hsl(var(--ring) / 0.12), transparent 60%)`,
            }}
          />
          {editMode ? (
            <div className="max-w-3xl">
              <div className="flex items-start gap-2">
                <Input
                  value={seoTitleDraft}
                  onChange={(e) => {
                    setSeoTitleDraft(e.target.value);
                    setSeoDirty(true);
                  }}
                  placeholder="Page title..."
                  className="text-2xl md:text-3xl font-semibold"
                />
                <Button
                  type="button"
                  onClick={async () => {
                    if (!dirHandle || !knowledgeData) {
                      toast.error("Start with one of the options below:");
                      return;
                    }

                    try {
                      const updatedData = {
                        ...knowledgeData,
                        seo: {
                          ...(knowledgeData.seo || {}),
                          title: seoTitleDraft,
                          description: seoDescriptionDraft,
                        },
                      };

                      const fileHandle = await dirHandle.getFileHandle('knowledge.json', { create: true });
                      const writable = await fileHandle.createWritable();
                      await writable.write(serializeKnowledgeData(updatedData));
                      await writable.close();

                      setKnowledgeData(updatedData);
                      setSeoDirty(false);
                      toast.success("Saved title & description");
                    } catch (err) {
                      console.error('Error saving knowledge.json:', err);
                      toast.error("Failed to save title & description");
                    }
                  }}
                  disabled={!seoDirty || !dirHandle}
                >
                  Save
                </Button>
              </div>
              <Textarea
                value={seoDescriptionDraft}
                onChange={(e) => {
                  setSeoDescriptionDraft(e.target.value);
                  setSeoDirty(true);
                }}
                placeholder="Page description..."
                className="mt-3 min-h-[96px]"
              />
            </div>
          ) : (
            <>
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground">
                {knowledgeData.seo?.title}
              </h1>
              <p className="mt-3 text-lg text-muted-foreground">
                {knowledgeData.seo?.description}
              </p>
            </>
          )}
        </div>
      </header>
      <div className="relative h-screen overflow-hidden">
        {/* Main content area - full width always */}
        <main className="relative w-full h-full overflow-hidden">
          <ReactFlowProvider>
            <div 
              className="absolute top-4 left-4 bg-background border border-border rounded-lg shadow-lg z-[450] overflow-hidden group"
              style={{ width: treeSize.width, height: treeSize.height, minWidth: 200, minHeight: 150 }}
            >
              <KnowledgeTree 
                data={viewData} 
                editMode={editMode}
                selectedNodes={selectedNodeLabels}
                onToggleSelectNode={handleToggleSelectNode}
                onGestureLongPressNode={handleGestureLongPressNode}
                onGestureCreateChild={handleGestureCreateChildNode}
              />
              {/* Resize handle */}
              <div
                className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-[100] opacity-60 hover:opacity-100 transition-opacity"
                onMouseDown={handleTreeResizeStart}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" className="text-muted-foreground">
                  <path d="M14 14L8 14L14 8Z" fill="currentColor" opacity="0.4"/>
                  <path d="M14 14L11 14L14 11Z" fill="currentColor" opacity="0.7"/>
                </svg>
              </div>
            </div>
          </ReactFlowProvider>
          <div className="w-full h-full">
            <Graph3D 
              data={viewData} 
              editMode={editMode}
              onNodeClickForEdit={handleNodeClickForEdit}
              onWidgetClickForEdit={handleWidgetClickForEdit}
              onGestureLongPressNode={handleGestureLongPressNode}
              onGestureLongPressWidget={handleGestureLongPressWidget}
              onGestureCreateWidget={handleGestureCreateWidget}
              externalSearchTerm={graphSearchTerm}
            />
          </div>
          <NavigationButton />
        </main>
        
        {/* Side panels - fixed overlay, don't affect layout */}
        <NodeEditPanel
          open={editPanelOpen}
          onOpenChange={setEditPanelOpen}
          node={editingNode}
          onSave={handleSaveNode}
          onAddWidget={handleAddWidgetFromNode}
          onAddChildNode={handleAddChildNode}
          onDelete={handleDeleteNode}
          isRootNode={editingNode?.node === particleData?.node}
        />
        
        <WidgetEditPanel
          open={widgetEditPanelOpen}
          onOpenChange={setWidgetEditPanelOpen}
          widget={editingWidget}
          onSave={handleSaveWidget}
          onDelete={handleDeleteWidget}
        />

        {/* Long-press confirmation: triggered by a touch long-press on a node or widget in edit mode. */}
        <AlertDialog
          open={!!pendingDelete}
          onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingDelete?.kind === "widget" ? "Delete widget?" : "Delete node?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete?.kind === "widget"
                  ? <>This will permanently delete the widget <strong>"{pendingDelete.displayLabel}"</strong>. This action cannot be undone.</>
                  : pendingDelete?.kind === "node"
                    ? <>This will permanently delete <strong>"{pendingDelete.label}"</strong> and all of its child nodes and widgets. This action cannot be undone.</>
                    : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmPendingDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Version number */}
        <div className="fixed bottom-2 right-2 text-xs text-muted-foreground/50 pointer-events-none select-none z-10">
          version {typeof __BUILD_TIME__ !== 'undefined'
            ? (() => {
                const d = new Date(__BUILD_TIME__);
                const pad = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
              })()
            : 'dev'}
        </div>
        
        {/* Product attribution */}
        <div className="fixed bottom-2 left-2 text-xs text-muted-foreground/50 z-10">
          an <a href="https://www.ironactionai.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground transition-colors pointer-events-auto">IronActionAI</a> product   © 2026
        </div>
      </div>
    </>
  );
}

const Index = () => {
  return (
    <DataFolderProvider>
      <FocusProvider>
        <IndexContent />
      </FocusProvider>
    </DataFolderProvider>
  );
};

export default Index;
