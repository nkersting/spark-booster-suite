import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Save, Plus, FolderPlus, Trash2, X } from "lucide-react";
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
import type { KnowledgeNode, Widget } from "@/types";

interface NodeEditPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: KnowledgeNode | null;
  onSave: (updatedNode: KnowledgeNode) => void;
  onAddWidget: (nodeLabel: string, widget: Widget) => void;
  onAddChildNode: (parentLabel: string, childNode: KnowledgeNode) => void;
  onDelete: (node: KnowledgeNode) => void;
  isRootNode?: boolean;
}

export function NodeEditPanel({ open, onOpenChange, node, onSave, onAddWidget, onAddChildNode, onDelete, isRootNode }: NodeEditPanelProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [prose, setProse] = useState("");
  const [weight, setWeight] = useState(50);
  const [posX, setPosX] = useState("");
  const [posY, setPosY] = useState("");
  const [posZ, setPosZ] = useState("");
  const [space, setSpace] = useState<"Default" | "Euclidean" | "Earth">("Default");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Sync local state when node changes
  useEffect(() => {
    if (node) {
      setName(node.node || "");
      setIcon((node as any).icon || "");
      setProse((node as any).prose || "");
      setWeight(node.weight ?? 50);
      const pos = Array.isArray((node as any).position) ? (node as any).position : [];
      setPosX(pos[0] !== undefined ? String(pos[0]) : "");
      setPosY(pos[1] !== undefined ? String(pos[1]) : "");
      setPosZ(pos[2] !== undefined ? String(pos[2]) : "");
      const s = (node as any).space;
      setSpace(s === "Euclidean" || s === "Earth" ? s : "Default");
    }
  }, [node]);

  const handleSave = () => {
    if (!node) return;
    
    const nums = [posX, posY, posZ].map((v) => Number(v));
    const hasPosition =
      [posX, posY, posZ].every((v) => v.trim() !== "") && nums.every((n) => Number.isFinite(n));

    const updatedNode: KnowledgeNode = {
      ...node,
      node: name,
      weight,
      icon: icon || undefined,
      prose: prose || undefined,
      position: hasPosition ? ([nums[0], nums[1], nums[2]] as [number, number, number]) : undefined,
    };
    
    // Remove undefined fields to keep JSON clean
    if (!updatedNode.icon) delete updatedNode.icon;
    if (!updatedNode.prose) delete updatedNode.prose;
    if (!updatedNode.position) delete updatedNode.position;
    if (isRootNode) (updatedNode as any).space = space;
    else delete (updatedNode as any).space;
    
    onSave(updatedNode);
    onOpenChange(false);
  };

  const handleAddWidget = () => {
    if (!node) return;
    const newWidget: Widget = {
      name: "",
      title: "",
      subtitle: "",
      prose: "",
      notes: "",
      url: "",
    };
    onAddWidget(node.node, newWidget);
  };

  const handleAddChildNode = () => {
    if (!node) return;
    const newChild: KnowledgeNode = {
      node: "<node>",
      weight: 50,
    };
    onAddChildNode(node.node, newChild);
  };

  if (!node || !open) return null;

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[199]"
        onClick={() => onOpenChange(false)}
      />
      {/* Side panel on the right */}
      <div
        className="fixed top-0 right-0 w-[400px] h-full bg-background border-l border-border flex flex-col z-[200] shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Edit Node</h2>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div className="space-y-2">
            <Label htmlFor="nodeName">
              Name<span className="text-red-500 ml-1">*</span>
            </Label>
            <Input
              id="nodeName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Node name..."
              className={!name.trim() ? "border-red-500" : ""}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nodeIcon">Icon (image path or URL)</Label>
            <Input
              id="nodeIcon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="e.g., atoms.png or https://..."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nodeProse">Prose</Label>
            <Textarea
              id="nodeProse"
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              placeholder="Description or notes about this node..."
              className="min-h-[120px]"
            />
          </div>

          <div className="space-y-2">
            <Label>Position (x, y, z)</Label>
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" step="any" value={posX} onChange={(e) => setPosX(e.target.value)} placeholder="x" />
              <Input type="number" step="any" value={posY} onChange={(e) => setPosY(e.target.value)} placeholder="y" />
              <Input type="number" step="any" value={posZ} onChange={(e) => setPosZ(e.target.value)} placeholder="z" />
            </div>
            <p className="text-xs text-muted-foreground">
              "Euclidean" space: raw x, y, z. "Earth" space: latitude, longitude, radius from the
              center (Earth sphere radius is 100). Leave blank for automatic placement.
            </p>

          </div>

          {isRootNode && (
            <div className="space-y-2">
              <Label htmlFor="graphSpace">Graph space</Label>
              <select
                id="graphSpace"
                value={space}
                onChange={(e) => setSpace(e.target.value as any)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="Default">Default</option>
                <option value="Euclidean">Euclidean</option>
                <option value="Earth">Earth</option>
              </select>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Weight</Label>
              <span className="text-sm text-muted-foreground">{weight}</span>
            </div>
            <Slider
              value={[weight]}
              onValueChange={(values) => setWeight(values[0])}
              min={1}
              max={100}
              step={1}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} className="flex-1" disabled={!name.trim()}>
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </Button>
            {!isRootNode && (
              <Button 
                variant="destructive" 
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-muted-foreground">Add to this node</Label>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleAddWidget} className="flex-1">
                <Plus className="h-4 w-4 mr-2" />
                Add Widget
              </Button>
              <Button variant="outline" onClick={handleAddChildNode} className="flex-1">
                <FolderPlus className="h-4 w-4 mr-2" />
                Add Child Node
              </Button>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="bg-orange-500 border-2 border-orange-600 max-w-[350px] top-24 left-1/2 -translate-x-1/2 translate-y-0 z-[600]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-black text-base">Are you sure you want to delete this node?</AlertDialogTitle>
            <AlertDialogDescription className="text-black/70 text-sm">
              This will delete the node along with all its widgets and children. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-white text-black hover:bg-gray-100">No</AlertDialogCancel>
            <AlertDialogAction onClick={() => node && onDelete(node)} className="bg-black text-white hover:bg-gray-800">
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
