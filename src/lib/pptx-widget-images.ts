import type { KnowledgeNode, Widget } from "@/types";
import type { PptxParseResult } from "./pptx-parser";

type SlideImageIndex = {
  slideNumber: number;
  keywords: Set<string>;
  imageNames: string[];
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "using", "with",
]);

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function scoreOverlap(a: Set<string>, b: Set<string>) {
  let score = 0;
  for (const token of a) {
    if (b.has(token)) score += 1;
  }
  return score;
}

function isProtectedWidgetName(name: string, extractedNames: Set<string>) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (extractedNames.has(trimmed)) return true;
  if (/youtube\.com|youtu\.be/i.test(trimmed)) return true;
  return false;
}

function buildSlideIndex(ppt: Pick<PptxParseResult, "slides" | "images">, extractedNames: Set<string>): SlideImageIndex[] {
  return ppt.slides
    .map((slide) => ({
      slideNumber: slide.slideNumber,
      keywords: tokenize([slide.texts.join(" "), slide.links.join(" ")].filter(Boolean).join(" ")),
      imageNames: slide.imageNames.filter((name) => extractedNames.has(name)),
    }))
    .filter((slide) => slide.imageNames.length > 0);
}

function pickBestImage(
  widget: Widget,
  nodeTrail: string[],
  slides: SlideImageIndex[],
  allImageNames: string[],
  usedImages: Set<string>,
) {
  const widgetTokens = tokenize(
    [
      nodeTrail.join(" "),
      widget.title,
      widget.subtitle,
      widget.notes,
      widget.prose,
      widget.url,
    ]
      .filter(Boolean)
      .join(" "),
  );

  let bestImage: string | null = null;
  let bestScore = -1;

  for (const slide of slides) {
    const available = slide.imageNames.filter((name) => !usedImages.has(name));
    if (available.length === 0) continue;

    const score = scoreOverlap(widgetTokens, slide.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestImage = available[0];
    }
  }

  if (bestImage) return bestImage;

  return allImageNames.find((name) => !usedImages.has(name)) ?? null;
}

function assignImagesToNode(
  node: KnowledgeNode,
  nodeTrail: string[],
  slides: SlideImageIndex[],
  allImageNames: string[],
  extractedNames: Set<string>,
  usedImages: Set<string>,
): KnowledgeNode {
  const nextTrail = [...nodeTrail, node.node];

  const widgets = node.widgets?.map((widget, widgetIndex) => {
    const currentName = widget.name || "";
    if (extractedNames.has(currentName)) {
      usedImages.add(currentName);
      return widget;
    }

    if (isProtectedWidgetName(currentName, extractedNames)) {
      return widget;
    }

    const assignedImage = pickBestImage(widget, nextTrail, slides, allImageNames, usedImages);
    if (!assignedImage) return widget;

    usedImages.add(assignedImage);
    console.log(
      `[PPT Widget Images] Assigned ${assignedImage} to widget ${widgetIndex + 1} on node \"${nextTrail.join(" > ")}\" (previous name: ${currentName || "<empty>"})`,
    );
    return {
      ...widget,
      name: assignedImage,
    };
  });

  const nextNode: KnowledgeNode = {
    ...node,
    ...(typeof node.icon === "string" && extractedNames.has(node.icon) ? { icon: undefined } : {}),
    widgets,
    children: node.children?.map((child) =>
      assignImagesToNode(child, nextTrail, slides, allImageNames, extractedNames, usedImages),
    ),
  };

  if (nextNode.icon === undefined) {
    delete nextNode.icon;
  }

  return nextNode;
}

export function applyPptImagesToKnowledgeData(
  data: any,
  ppt: Pick<PptxParseResult, "slides" | "images"> | null,
) {
  if (!data?.knowledgeTree || !ppt || ppt.images.length === 0) return data;

  const allImageNames = ppt.images.map((image) => image.filename);
  const extractedNames = new Set(allImageNames);
  const slides = buildSlideIndex(ppt, extractedNames);
  const usedImages = new Set<string>();

  return {
    ...data,
    knowledgeTree: assignImagesToNode(
      data.knowledgeTree,
      [],
      slides,
      allImageNames,
      extractedNames,
      usedImages,
    ),
  };
}