import JSZip from "jszip";

export interface SlideContent {
  slideNumber: number;
  texts: string[];
  links: string[];
  imageNames: string[];
}

export interface ExtractedImage {
  /** Original path inside the pptx zip, e.g. "media/image1.png" */
  originalPath: string;
  /** Sanitised filename for saving to the destination folder, e.g. "ppt_image1.png" */
  filename: string;
  /** Raw image data */
  blob: Blob;
  /** Which slide(s) this image appeared on */
  slideNumbers: number[];
}

export interface PptxParseResult {
  slides: SlideContent[];
  /** Plain-text summary for the generation engine */
  summary: string;
  /** All images extracted from the pptx */
  images: ExtractedImage[];
}

/**
 * Parse a .pptx file and extract text, links, image references, and actual image blobs.
 */
export async function parsePptx(
  file: File,
  onProgress?: (stage: string, pct: number) => void,
): Promise<PptxParseResult> {
  onProgress?.("Loading file…", 5);
  const zip = await JSZip.loadAsync(file);

  // Gather relationship files for hyperlink extraction
  const relsMap = new Map<number, Map<string, string>>(); // slideNum -> rId -> url
  // Also store rId -> internal target for images
  const internalRelsMap = new Map<number, Map<string, string>>(); // slideNum -> rId -> target path

  // Find all slide files
  const slideFiles: { num: number; path: string }[] = [];
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) {
      slideFiles.push({ num: parseInt(match[1], 10), path: relativePath });
    }
  });
  slideFiles.sort((a, b) => a.num - b.num);

  onProgress?.("Parsing slide relationships…", 15);

  // Parse relationship files for each slide
  for (const sf of slideFiles) {
    const relsPath = `ppt/slides/_rels/slide${sf.num}.xml.rels`;
    const relsFile = zip.file(relsPath);
    if (relsFile) {
      const relsXml = await relsFile.async("text");
      const extRelMap = new Map<string, string>();
      const intRelMap = new Map<string, string>();

      // Parse all Relationship elements
      const relRegex = /<Relationship[^>]*\/>/gi;
      let m: RegExpExecArray | null;
      while ((m = relRegex.exec(relsXml)) !== null) {
        const tag = m[0];
        const idMatch = tag.match(/Id="([^"]*)"/);
        const targetMatch = tag.match(/Target="([^"]*)"/);
        const modeMatch = tag.match(/TargetMode="([^"]*)"/i);

        if (idMatch && targetMatch) {
          const rId = idMatch[1];
          const target = targetMatch[1];
          const isExternal = modeMatch && modeMatch[1].toLowerCase() === "external";

          if (isExternal) {
            extRelMap.set(rId, target);
          } else {
            // Internal relationship (images, etc.)
            intRelMap.set(rId, target);
          }
        }
      }

      relsMap.set(sf.num, extRelMap);
      internalRelsMap.set(sf.num, intRelMap);
    }
  }

  const slides: SlideContent[] = [];
  // Track images: zip-internal path -> ExtractedImage (dedup across slides)
  const imageMap = new Map<string, ExtractedImage>();

  const totalSlides = slideFiles.length;

  for (let si = 0; si < slideFiles.length; si++) {
    const sf = slideFiles[si];
    const progressPct = 20 + Math.round((si / totalSlides) * 40);
    onProgress?.(`Parsing slide ${sf.num}/${totalSlides}…`, progressPct);

    const xmlContent = await zip.file(sf.path)!.async("text");

    // Extract all text content
    const texts: string[] = [];
    const textRegex = /<a:t>([^<]*)<\/a:t>/g;
    let match: RegExpExecArray | null;
    while ((match = textRegex.exec(xmlContent)) !== null) {
      const text = match[1].trim();
      if (text) texts.push(text);
    }

    // Extract hyperlinks from the XML (r:id references)
    const links: string[] = [];
    const hlinkRegex = /a:hlinkClick[^>]*r:id="(rId\d+)"/g;
    const slideRels = relsMap.get(sf.num);
    if (slideRels) {
      while ((match = hlinkRegex.exec(xmlContent)) !== null) {
        const url = slideRels.get(match[1]);
        if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
          if (!links.includes(url)) links.push(url);
        }
      }
    }

    // Extract image references - try multiple patterns
    const imageNames: string[] = [];
    const intRels = internalRelsMap.get(sf.num);
    // Match both a:blip and p:blipFill patterns, and handle r:embed or r:link
    const imgRegex = /r:(?:embed|link)="(rId\d+)"/g;
    const processedRIds = new Set<string>();
    while ((match = imgRegex.exec(xmlContent)) !== null) {
      const rId = match[1];
      if (processedRIds.has(rId)) continue;
      processedRIds.add(rId);
      
      if (intRels) {
        const target = intRels.get(rId);
        if (target && /\.(png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$/i.test(target)) {
          // target is like "../media/image1.png"
          const cleanPath = target.replace(/^\.\.\//, ""); // "media/image1.png"
          const zipPath = `ppt/${cleanPath}`;

          // Create a sanitised output filename
          const baseName = cleanPath.replace(/\//g, "_"); // "media_image1.png"
          const outFilename = `ppt_${baseName}`;

          console.log(`[PPTX] Slide ${sf.num}: found image rId=${rId} -> ${zipPath} -> ${outFilename}`);

          if (!imageMap.has(zipPath)) {
            imageMap.set(zipPath, {
              originalPath: zipPath,
              filename: outFilename,
              blob: new Blob(), // placeholder, filled below
              slideNumbers: [sf.num],
            });
          } else {
            const existing = imageMap.get(zipPath)!;
            if (!existing.slideNumbers.includes(sf.num)) {
              existing.slideNumbers.push(sf.num);
            }
          }

          if (!imageNames.includes(outFilename)) imageNames.push(outFilename);
        }
      }
    }

    slides.push({
      slideNumber: sf.num,
      texts,
      links,
      imageNames,
    });
  }

  // Extract actual image blobs from the zip
  onProgress?.("Extracting images…", 65);
  const imageEntries = Array.from(imageMap.entries());
  console.log(`[PPTX] Total unique images to extract: ${imageEntries.length}`);
  
  // Also scan zip for all media files in case regex missed some
  const allMediaFiles: string[] = [];
  zip.forEach((relativePath) => {
    if (/^ppt\/media\//i.test(relativePath)) {
      allMediaFiles.push(relativePath);
    }
  });
  console.log(`[PPTX] All media files in zip: ${allMediaFiles.join(', ')}`);
  
  // Add any media files that weren't caught by slide relationship parsing
  for (const mediaPath of allMediaFiles) {
    if (!imageMap.has(mediaPath) && /\.(png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$/i.test(mediaPath)) {
      const cleanPath = mediaPath.replace(/^ppt\//, "");
      const baseName = cleanPath.replace(/\//g, "_");
      const outFilename = `ppt_${baseName}`;
      console.log(`[PPTX] Adding unreferenced media file: ${mediaPath} -> ${outFilename}`);
      imageMap.set(mediaPath, {
        originalPath: mediaPath,
        filename: outFilename,
        blob: new Blob(),
        slideNumbers: [],
      });
    }
  }
  
  // Re-gather entries after adding unreferenced media
  const finalImageEntries = Array.from(imageMap.entries());
  
  for (let i = 0; i < finalImageEntries.length; i++) {
    const [zipPath, img] = finalImageEntries[i];
    const progressPct = 65 + Math.round((i / finalImageEntries.length) * 25);
    onProgress?.(`Extracting image ${i + 1}/${finalImageEntries.length}…`, progressPct);

    const zipFile = zip.file(zipPath);
    if (zipFile) {
      const data = await zipFile.async("blob");
      img.blob = data;
      console.log(`[PPTX] Extracted ${zipPath}: ${data.size} bytes`);
    } else {
      console.warn(`[PPTX] Image not found in zip: ${zipPath}`);
    }
  }

  onProgress?.("Building summary…", 92);

  // Build a structured text summary for the generation engine
  const summaryParts = slides.map((s) => {
    let part = `--- Slide ${s.slideNumber} ---\n`;
    if (s.texts.length > 0) part += `Text: ${s.texts.join(" | ")}\n`;
    if (s.links.length > 0) part += `Links: ${s.links.join(", ")}\n`;
    if (s.imageNames.length > 0) part += `Images: ${s.imageNames.join(", ")}\n`;
    return part;
  });

  onProgress?.("Done", 100);

  return {
    slides,
    summary: summaryParts.join("\n"),
    images: Array.from(imageMap.values()),
  };
}
