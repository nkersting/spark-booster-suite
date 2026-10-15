import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { FunctionsHttpError } from "@supabase/supabase-js";
import {
  parseCsv,
  convertBmRows,
  placesToGeocode,
  geoKey,
  DEPT_BOX,
  type GeoHit,
} from "@/lib/bm-to-objects";
import { ingestObjects } from "@/lib/ingest-objects";
import scaffoldAsset from "@/assets/knowledge-described-connections.json.asset.json";

interface MuseumQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoaded: (doc: any) => void;
}

function bmSearchUrl(keyword: string) {
  const p = new URLSearchParams({
    keyword,
    display: "true",
    image: "true",
    view: "grid",
    sort: "object_name__asc",
    page: "1",
  });
  return `https://www.britishmuseum.org/collection/search?${p.toString()}`;
}

export function MuseumQueryDialog({ open, onOpenChange, onLoaded }: MuseumQueryDialogProps) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [needsUpload, setNeedsUpload] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setBusy(false);
    setStage("");
    setProgress(0);
    setNeedsUpload(false);
  };

  const buildFromCsv = async (csvText: string) => {
    setBusy(true);
    try {
      setStage("Reading the museum records…");
      setProgress(10);
      const rows = parseCsv(csvText);
      if (!rows.length) throw new Error("That file has no records in it.");

      setStage("Looking up where each object comes from…");
      setProgress(25);
      const places = placesToGeocode(rows);
      const geo: Record<string, GeoHit | null> = {};
      const BATCH = 100;
      for (let i = 0; i < places.length; i += BATCH) {
        const chunk = places.slice(i, i + BATCH).map(({ place, dept }) => ({
          place,
          key: geoKey(place, dept),
          box: DEPT_BOX[(dept || "").trim()],
        }));
        const { data, error } = await supabase.functions.invoke("bm-museum", {
          body: { action: "geocode", places: chunk },
        });
        if (error) {
          const details = error instanceof FunctionsHttpError ? await error.context.text() : error.message;
          console.error("geocode failed:", details);
          toast.warning("Place lookup is unavailable, so objects will be placed without coordinates.");
          break;
        }
        Object.assign(geo, data?.results ?? {});
        setProgress(25 + Math.min(40, ((i + BATCH) / Math.max(1, places.length)) * 40));
      }

      setStage("Matching objects to periods…");
      setProgress(70);
      const { records } = convertBmRows(rows, geo);
      if (!records.length) throw new Error("None of those records had a usable date and place.");

      setStage("Building the knowledge tree…");
      setProgress(82);
      const res = await fetch(scaffoldAsset.url);
      if (!res.ok) throw new Error("Could not load the world history scaffold.");
      const scaffold = await res.json();
      const { doc, matched, unmatched } = ingestObjects(scaffold, records);
      const keyword = query.trim();
      if (keyword) {
        const baseTitle = (doc as any).pageTitle || "British Museum Collection";
        (doc as any).pageTitle = `${baseTitle} — "${keyword}"`;
      }

      setProgress(100);
      toast.success(`Placed ${matched} objects (${unmatched} could not be matched).`);
      onLoaded(doc);
      onOpenChange(false);
      reset();
      setQuery("");
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Something went wrong building the collection.");
      setBusy(false);
      setStage("");
      setProgress(0);
    }
  };

  const handleSearch = async () => {
    const keyword = query.trim();
    if (!keyword) return;
    setBusy(true);
    setNeedsUpload(false);
    setStage("Asking the British Museum for matching objects…");
    setProgress(5);
    try {
      const { data, error } = await supabase.functions.invoke("bm-museum", {
        body: { action: "csv", keyword },
      });
      if (error) {
        const details = error instanceof FunctionsHttpError ? await error.context.text() : error.message;
        console.error("bm csv failed:", details);
      }
      if (data?.csv) {
        await buildFromCsv(data.csv);
        return;
      }
      window.open(bmSearchUrl(keyword), "_blank", "noopener");
      setNeedsUpload(true);
      setBusy(false);
      setStage("");
      setProgress(0);
      toast.info("The museum site blocks automatic downloads — download the results there, then upload the file here.");
    } catch (err: any) {
      console.error(err);
      window.open(bmSearchUrl(keyword), "_blank", "noopener");
      setNeedsUpload(true);
      setBusy(false);
    }
  };

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    const text = await file.text();
    await buildFromCsv(text);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          onOpenChange(next);
          if (!next) reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Query the British Museum</DialogTitle>
          <DialogDescription>
            Search the collection for objects on display with images, then place them on the world history map.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bm-query">Search term</Label>
            <Input
              id="bm-query"
              value={query}
              placeholder="e.g. yellow"
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) handleSearch();
              }}
            />
          </div>

          {needsUpload && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2 text-sm">
              <p>
                The museum results opened in a new tab. Use the download button there to save the list of
                objects, then upload that file below.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
                Upload downloaded file
              </Button>
            </div>
          )}

          {busy && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{stage}</p>
              <Progress value={progress} className="h-2" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSearch} disabled={busy || !query.trim()}>
            Search
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
