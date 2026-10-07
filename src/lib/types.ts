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

export type ProviderId =
  | "openrouter"
  | "bfl"
  | "comfy"
  | "runware"
  | "google"
  | "ark"
  | "byteplus"
  | "xai";
export type FamilyId = "flux" | "gpt" | "qwen" | "gemini" | "seedream" | "grok";
export type TaskIntent = "create" | "edit";
export type WorkspaceKey = TaskIntent;
export type ReferencePurpose =
  | "reference"
  | "style"
  | "subject"
  | "composition"
  | "custom";
export type ParamValue = string | number | boolean | null;

export interface GenerateParams {
  [key: string]: ParamValue | undefined;
  resolution?: string;
  aspectRatio?: string;
  safetyTolerance?: number | null;
  grounding?: boolean;
  version?: "latest";
  quality?: string;
  size?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  count?: number;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  negativePrompt?: string;
  promptExtend?: boolean;
  promptExtendMode?: string;
  watermark?: boolean;
  thinkingLevel?: string;
  includeThoughts?: boolean;
  searchMode?: string;
  responseText?: boolean;
}

export interface ProviderStatus {
  openrouter: boolean;
  bfl: boolean;
  comfy: boolean;
  runware: boolean;
  google: boolean;
  ark: boolean;
  byteplus: boolean;
  xai: boolean;
  sources?: Record<ProviderId, string>;
  settings?: Record<ProviderId, CredentialSettings>;
  storedKeys?: Record<ProviderId, boolean>;
}

export interface CredentialSettings {
  source: "environment" | "manual";
  envName: string;
}

export interface GenerationDetails {
  text: string;
  thoughts: string;
  sources: { title: string; url: string; kind: "web" | "image" }[];
  searchQueries: string[];
  searchHtml: string | null;
}

export interface OutputImage {
  details?: GenerationDetails;
  dataUrl: string;
  mediaType: string;
}

export interface GenerateOutput {
  provider: string;
  model: string;
  finalPrompt: string;
  images: OutputImage[];
  usage: {
    cost?: number;
    credits?: number;
    total_tokens?: number;
    [key: string]: unknown;
  } | null;
  notes: string[];
}
export interface GenerationProgress {
  requestId?: string;
  phase:
    | "preparing"
    | "submitting"
    | "queued"
    | "reasoning"
    | "generating"
    | "waiting"
    | "downloading"
    | "saving";
  taskId?: string | null;
  completed?: number | null;
}
export interface GenerationTask extends GenerationProgress {
  remainingRequests?: number;
  stopRequested?: boolean;
  intent?: TaskIntent;
  family: FamilyId;
  modelId: string;
  provider: ProviderId;
  startedAt: number;
  total: number;
}

export interface HistoryBatchRequest {
  requestId: string;
  seed?: number | null;
  status: "queued" | "running" | "ok" | "failed" | "skipped" | "interrupted";
  taskId?: string | null;
  error?: string | null;
}
export interface HistoryItem {
  resultDetails?: Record<string, GenerationDetails>;
  resultAssetIds?: string[];
  thumbFile?: string | null;
  batch?: { requests: HistoryBatchRequest[]; stopped?: boolean } | null;
  error?: string | null;
  taskId?: string | null;
  phase?: string | null;
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
  maskFile?: string | null;
  thumb: string | null;
  usage: GenerateOutput["usage"];
  cost: number | null;
  status: string;
  recipe?: Omit<Draft, "refs" | "mask"> & {
    refNames: string[];
    refIds: string[];
    refPurposes?: (ReferencePurpose | undefined)[];
    refNotes?: (string | undefined)[];
    maskName?: string;
  };
}

/** 有序参考图，其编辑和引用语义由模型定义。 */
export interface WorkingImage {
  assetId?: string;
  uid?: string;
  dataUrl: string;
  width: number;
  height: number;
  name: string;
  purpose?: ReferencePurpose;
  note?: string;
}

export interface GalleryItem {
  details?: GenerationDetails | null;
  id: string;
  name: string;
  createdAt: number;
  width: number;
  height: number;
  mime: string;
  source: "file" | "clipboard" | "url" | "generated";
  historyId: string | null;
  model: string | null;
  provider: string | null;
  filePath: string;
  thumbPath: string;
  pendingDelete: boolean;
}

export interface GenerateRequestPayload {
  provider: ProviderId;
  model: string;
  finalPrompt: string;
  images: string[];
  params: GenerateParams;
  /** FLUX 区域单独传给需要结构化区域的供应商。 */
  instruction?: string;
  regions?: LayoutRegion[];
  mask?: string;
  requestId?: string;
  historyId?: string;
}

export interface LayoutRegion {
  id: string;
  description: string;
  referenceIndex: number | null;
  sourceBox: [number, number, number, number] | null;
  targetBox: [number, number, number, number] | null;
}

export interface Draft {
  layoutEnabled?: boolean;
  repeatCount?: number;
  intent: TaskIntent;
  familyRoutes?: Partial<
    Record<FamilyId, { modelId: string; provider: ProviderId }>
  >;
  showBase?: boolean;
  routeSettings?: Record<string, GenerateParams>;
  colorPool?: string[];
  schema: 4;
  family: FamilyId;
  modelId: string;
  refs: WorkingImage[];
  boxes: Box[];
  prompt: string;
  params: GenerateParams;
  provider: ProviderId;
  baseId: string | null;
  canvas: { w: number; h: number };
  compressEnabled: boolean;
  maxInputEdge: number;
  mask: WorkingImage | null;
  maskRects?: Rect[];
}

/** 创作内容按任务保存；模型路由只改变参数和可用能力。 */
export interface WorkspaceSession {
  schema: 2;
  activeIntent: TaskIntent;
  tasks: Partial<Record<TaskIntent, Draft>>;
}

export interface Preferences {
  familyDefaults?: Partial<
    Record<
      FamilyId,
      { modelId: string; provider: ProviderId; params: GenerateParams }
    >
  >;
  defaultFamily?: FamilyId;
  sidebarWidthPercent: number;
  referenceSidebarWidth?: number;
  saveDirectory: string;
  theme: "system" | "light" | "dark";
  provider: ProviderId;
  params: GenerateParams;
  compressEnabled: boolean;
  maxInputEdge: number;
}
