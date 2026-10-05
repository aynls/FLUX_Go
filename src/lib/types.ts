export type BoxRole = "new" | "modify" | "anchor" | "move" | "remove" | "place";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  color?: string;
  uid?: string;
  id: string;
  role: BoxRole;
  /** 目标区域（画布/输出图像素坐标） */
  rect: Rect;
  /** move 角色：源区域（输入图像素坐标） */
  srcRect?: Rect;
  sourceId?: string;
  /** 区域描述（协议中的 desc 字段） */
  desc: string;
}

export type ProviderId = "openrouter" | "bfl";

export interface GenerateParams {
  resolution: string;
  aspectRatio: string;
  safetyTolerance: number | null;
  grounding?: boolean;
  version?: "latest";
}

export interface ProviderStatus {
  openrouter: boolean;
  bfl: boolean;
  sources?: Record<ProviderId, string>;
  settings?: Record<ProviderId, CredentialSettings>;
  storedKeys?: Record<ProviderId, boolean>;
}

export interface CredentialSettings {
  source: "environment" | "manual";
  envName: string;
}

export interface OutputImage {
  dataUrl: string;
  mediaType: string;
}

export interface GenerateOutput {
  provider: string;
  model: string;
  finalPrompt: string;
  images: OutputImage[];
  usage: { cost?: number; total_tokens?: number } | null;
  notes: string[];
}

export interface HistoryItem {
  id: string;
  createdAt: number;
  provider: string;
  model: string;
  mode: string;
  prompt: string;
  finalPrompt: string;
  params: Partial<GenerateParams> & Record<string, unknown>;
  boxes: Box[];
  canvasWidth: number | null;
  canvasHeight: number | null;
  inputFiles: string[];
  resultFiles: string[];
  thumb: string | null;
  usage: { cost?: number; total_tokens?: number } | null;
  cost: number | null;
  status: string;
  recipe?: Omit<Draft, "refs"> & { refNames: string[]; refIds: string[] };
}

/** 参考图（第一张为画布主图 ref_image_0） */
export interface WorkingImage {
  uid?: string;
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

export interface GenerateRequestPayload {
  provider: ProviderId;
  model: string;
  finalPrompt: string;
  images: string[];
  params: {
    resolution?: string;
    aspectRatio?: string;
    safetyTolerance?: number;
    grounding?: boolean;
    version?: "latest";
  };
}

export interface Draft {
  colorPool?: string[];
  schema: 2;
  refs: WorkingImage[];
  boxes: Box[];
  prompt: string;
  params: GenerateParams;
  provider: ProviderId;
  baseId: string | null;
  canvas: { w: number; h: number };
  compressEnabled: boolean;
  maxInputEdge: number;
}

export interface Preferences {
  sidebarWidthPercent: number;
  saveDirectory: string;
  theme: "system" | "light" | "dark";
  provider: ProviderId;
  params: GenerateParams;
  compressEnabled: boolean;
  maxInputEdge: number;
}
