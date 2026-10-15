export type Widget = {
  name: string;
  title?: string;
  subtitle?: string;
  prose?: string;
  notes?: string;
  url?: string;
  /** Higher-detail image shown when the widget image is clicked or scrolled */
  detailed_url?: string;
  [key: string]: any;
};

export type GraphSpace = "Default" | "Euclidean" | "Earth";

export type KnowledgeNode = {
  node: string;
  /** Explicit [x, y, z] coordinates, used when the graph space is "Euclidean" */
  position?: [number, number, number];
  /** Graph-level space, only meaningful on the root node */
  space?: GraphSpace;
  /** Optional image path/URL used as the node icon */
  icon?: string;
  /** Optional prose/description shown in panels */
  prose?: string;
  weight?: number;
  children?: KnowledgeNode[];
  widgets?: Widget[];
};
