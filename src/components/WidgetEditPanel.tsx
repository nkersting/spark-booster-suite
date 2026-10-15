import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Save, Trash2, X } from "lucide-react";
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
import type { Widget } from "@/types";
import { useDataFolder } from "@/contexts/DataFolderContext";

interface WidgetEditPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widget: Widget | null;
  onSave: (updatedWidget: Widget) => void;
  onDelete: (widget: Widget) => void;
}

export function WidgetEditPanel({ open, onOpenChange, widget, onSave, onDelete }: WidgetEditPanelProps) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [prose, setProse] = useState("");
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  
  const { getImageUrl } = useDataFolder();

  // Sync local state when widget changes
  useEffect(() => {
    if (widget) {
      setName(widget.name || "");
      setTitle(widget.title || "");
      setSubtitle(widget.subtitle || "");
      setProse(widget.prose || "");
      setNotes(widget.notes || "");
      setUrl(widget.url || "");
    }
  }, [widget]);

  // Load image URL for preview
  useEffect(() => {
    const loadImage = async () => {
      if (widget?.name && !widget.name.includes("youtube.com") && !widget.name.includes("youtu.be")) {
        const resolvedUrl = await getImageUrl(widget.name);
        setImageUrl(resolvedUrl);
      } else {
        setImageUrl(null);
      }
    };
    loadImage();
  }, [widget?.name, getImageUrl]);

  const handleSave = () => {
    if (!widget) return;
    
    const updatedWidget: Widget = {
      ...widget,
      name,
      title: title || undefined,
      subtitle: subtitle || undefined,
      prose: prose || undefined,
      notes: notes || undefined,
      url: url || undefined,
    };
    
    // Remove undefined fields to keep JSON clean
    if (!updatedWidget.title) delete updatedWidget.title;
    if (!updatedWidget.subtitle) delete updatedWidget.subtitle;
    if (!updatedWidget.prose) delete updatedWidget.prose;
    if (!updatedWidget.notes) delete updatedWidget.notes;
    if (!updatedWidget.url) delete updatedWidget.url;
    
    onSave(updatedWidget);
    onOpenChange(false);
  };

  if (!widget || !open) return null;

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[499]"
        onClick={() => onOpenChange(false)}
      />
      {/* Side panel on the right */}
      <div
        className="fixed top-0 right-0 w-[400px] h-full bg-background border-l border-border flex flex-col z-[500] shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Edit Widget</h2>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Image Preview - no hover enlarge in edit mode */}
          {imageUrl && (
            <div className="space-y-2">
              <Label>Image Preview</Label>
              <div className="relative">
                <img 
                  src={imageUrl} 
                  alt={widget?.title || widget?.name || "Widget image"} 
                  className="w-full h-auto rounded-md border border-border object-contain max-h-[200px]"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="widgetName">
              Name (image/video path)<span className="text-red-500 ml-1">*</span>
            </Label>
            <Input
              id="widgetName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., image.png or https://youtube.com/..."
              className={!name.trim() ? "border-red-500" : ""}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="widgetTitle">Title</Label>
            <Input
              id="widgetTitle"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Widget title..."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="widgetSubtitle">Subtitle</Label>
            <Input
              id="widgetSubtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Widget subtitle..."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="widgetProse">Prose</Label>
            <Textarea
              id="widgetProse"
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              placeholder="Detailed description..."
              className="min-h-[100px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="widgetNotes">Notes</Label>
            <Textarea
              id="widgetNotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes..."
              className="min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="widgetUrl">URL</Label>
            <Input
              id="widgetUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="flex gap-2">
            <Button 
              onClick={handleSave} 
              className="flex-1"
              disabled={!name.trim()}
            >
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="bg-orange-500 border-2 border-orange-600 max-w-[350px] top-24 left-1/2 -translate-x-1/2 translate-y-0 z-[600]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-black text-base">Are you sure you want to delete this widget?</AlertDialogTitle>
            <AlertDialogDescription className="text-black/70 text-sm">
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-white text-black hover:bg-gray-100">No</AlertDialogCancel>
            <AlertDialogAction onClick={() => widget && onDelete(widget)} className="bg-black text-white hover:bg-gray-800">
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
