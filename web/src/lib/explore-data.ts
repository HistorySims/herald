export interface ExplorePoints {
  count: number;
  x: Float32Array;
  y: Float32Array;
  clusterT0: Uint16Array;
  clusterT1: Uint16Array;
  clusterT2: Uint16Array;
  clusterT3: Uint16Array;
  contentType: Uint8Array;
}

export function parsePointsBinary(buffer: ArrayBuffer): ExplorePoints {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);

  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const clusterT0 = new Uint16Array(count);
  const clusterT1 = new Uint16Array(count);
  const clusterT2 = new Uint16Array(count);
  const clusterT3 = new Uint16Array(count);
  const contentType = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 17;
    x[i] = view.getFloat32(offset, true);
    y[i] = view.getFloat32(offset + 4, true);
    clusterT0[i] = view.getUint16(offset + 8, true);
    clusterT1[i] = view.getUint16(offset + 10, true);
    clusterT2[i] = view.getUint16(offset + 12, true);
    clusterT3[i] = view.getUint16(offset + 14, true);
    contentType[i] = view.getUint8(offset + 16);
  }

  return { count, x, y, clusterT0, clusterT1, clusterT2, clusterT3, contentType };
}

export function parseDatesBinary(buffer: ArrayBuffer): { count: number; offsets: Uint16Array } {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  const offsets = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = view.getUint16(4 + i * 2, true);
  }
  return { count, offsets };
}

export interface ClusterInfo {
  label: number;
  size: number;
  date_min: string | null;
  date_max: string | null;
  parent_id: string | null;
}

export interface ChunkDetail {
  chunk_id: string;
  content: string;
  paper_title: string;
  paper_lccn: string;
  date_issued: string;
  edition: number;
  page_sequence: number;
  image_url: string;
  cluster_labels: number[];
  content_type: number;
}

const CONTENT_TYPE_LABELS = ["Content", "Ad", "Legal", "Bad OCR"] as const;
export function contentTypeLabel(t: number): string {
  return CONTENT_TYPE_LABELS[t] ?? `Unknown (${t})`;
}

const TIER_COLORS = [
  [31, 119, 180],  // blue
  [255, 127, 14],  // orange
  [44, 160, 44],   // green
  [214, 39, 40],   // red
  [148, 103, 189], // purple
  [140, 86, 75],   // brown
  [227, 119, 194], // pink
  [127, 127, 127], // gray
  [188, 189, 34],  // olive
  [23, 190, 207],  // cyan
];

export function clusterColor(label: number): [number, number, number] {
  return (TIER_COLORS[label % TIER_COLORS.length] ?? [127, 127, 127]) as [number, number, number];
}
