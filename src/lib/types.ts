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

export type ProviderId = "openrouter" | "bfl" | "comfy" | "runware";
export type FamilyId = "flux" | "gpt" | "qwen";
export type TaskIntent = "create" | "edit";
export type WorkspaceKey = `${FamilyId}:${TaskIntent}`;
export type ReferencePurpose =
  "reference" | "style" | "subject" | "composition" | "custom";
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
}

export interface ProviderStatus {
  openrouter: boolean;
  bfl: boolean;
  comfy: boolean;
  runware: boolean;
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
  batch?: { requests: HistoryBatchRequest[] } | null;
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
  uid?: string;
  dataUrl: string;
  width: number;
  height: number;
  name: string;
  purpose?: ReferencePurpose;
  note?: string;
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
  /** Older drafts infer intent from their inputs until migrated. */
  intent?: TaskIntent;
  showBase?: boolean;
  routeSettings?: Record<string, GenerateParams>;
  colorPool?: string[];
  schema: 3;
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

/** 各家族的生成与编辑任务独立保存草稿；workspaces 记录最近活动的任务。 */
export interface WorkspaceSession {
  schema: 1;
  activeFamily: FamilyId;
  workspaces: Partial<Record<FamilyId, Draft>>;
  taskWorkspaces?: Partial<Record<WorkspaceKey, Draft>>;
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
  saveDirectory: string;
  theme: "system" | "light" | "dark";
  provider: ProviderId;
  params: GenerateParams;
  compressEnabled: boolean;
  maxInputEdge: number;
}
