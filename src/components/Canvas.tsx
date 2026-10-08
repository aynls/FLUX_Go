import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minus, Plus } from "@phosphor-icons/react";
import {
  fitView,
  fitMinimumScale,
  MIN_SCALE,
  handlePoint,
  hitTest,
  moveRect,
  pickHandle,
  rectFromDrag,
  resizeRect,
  screenToImg,
  zoomCanvasAt,
  clampCanvasView,
  HANDLES,
  type Handle,
  type Rect,
  type View,
} from "../lib/coords";
import type { Box, WorkingImage } from "../lib/types";
import { rectToWire } from "../lib/protocol";
import { BOX_COLORS } from "../lib/boxColors";
import { m } from "../i18n";

interface CanvasProps {
  /** 画布展示图片；发送顺序由工作区管理。 */
  image: WorkingImage | null;
  imageFit?: "fill" | "contain";
  dimensionLabel?: string;
  /** 文生图模式的幻影画布尺寸 */
  phantom: { w: number; h: number } | null;
  boxes: Box[];
  selectedId: string | null;
  tool: "box" | "pan" | "brush" | "eraser" | "mask-box";
  mask?: WorkingImage | null;
  brushRadius?: number;
  onMaskChange?: (mask: WorkingImage) => void;
  onSelect: (id: string | null) => void;
  onChange: (boxes: Box[]) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onCreateRect?: (rect: Rect) => void;
  readOnly?: boolean;
  editMode?: boolean;
  coordinateMode?: "normalized" | "pixels";
  fitWholeImage?: boolean;
}

interface DragState {
  kind: "pan" | "create" | "move" | "resize" | "paint";
  lastPoint?: { x: number; y: number };
  pointerId: number;
  // pan
  startClient?: { x: number; y: number };
  startView?: View;
  // create
  startImg?: { x: number; y: number };
  // move / resize
  boxId?: string;
  origRect?: Rect;
  origSrcRect?: Rect | null;
  grab?: { x: number; y: number };
  handle?: Handle;
}

const HANDLE_CURSORS: Record<Handle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export default function Canvas(props: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursorScreen, setCursorScreen] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const draftRef = useRef<Rect | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const [interaction, setInteraction] = useState<DragState | null>(null);
  const maskRaster = useRef<HTMLCanvasElement | null>(null);
  const maskOverlay = useRef<HTMLCanvasElement>(null);
  const [maskReady, setMaskReady] = useState(false);

  const iw = props.phantom?.w ?? props.image?.width ?? 0;
  const ih = props.phantom?.h ?? props.image?.height ?? 0;
  useEffect(() => {
    if (!props.onMaskChange || iw <= 0 || ih <= 0) return;
    let alive = true;
    setMaskReady(false);
    const raster = document.createElement("canvas");
    raster.width = iw;
    raster.height = ih;
    const ctx = raster.getContext("2d");
    const overlay = maskOverlay.current;
    const display = overlay?.getContext("2d");
    if (!ctx || !overlay || !display) return;
    const ready = () => {
      if (!alive) return;
      overlay.width = iw;
      overlay.height = ih;
      display.globalCompositeOperation = "source-over";
      display.fillStyle = "#000";
      display.fillRect(0, 0, iw, ih);
      display.globalCompositeOperation = "destination-out";
      display.drawImage(raster, 0, 0);
      maskRaster.current = raster;
      setMaskReady(true);
    };
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, iw, ih);
    if (props.mask) {
      const image = document.createElement("img");
      image.onload = () => {
        if (!alive) return;
        ctx.clearRect(0, 0, iw, ih);
        ctx.drawImage(image, 0, 0, iw, ih);
        ready();
      };
      image.src = props.mask.dataUrl;
    } else ready();
    return () => {
      alive = false;
    };
  }, [props.mask?.dataUrl, props.image?.uid, iw, ih, !!props.onMaskChange]);
  const paint = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    const ctx = maskRaster.current?.getContext("2d");
    const display = maskOverlay.current?.getContext("2d");
    if (!ctx || !display) return;
    const erase = props.tool === "eraser";
    for (const [target, operation, color] of [
      [ctx, erase ? "source-over" : "destination-out", "#000"],
      [display, erase ? "destination-out" : "source-over", "#000"],
    ] as const) {
      target.globalCompositeOperation = operation;
      target.strokeStyle = color;
      target.fillStyle = color;
      target.lineWidth = (props.brushRadius ?? 32) * 2;
      target.lineCap = "round";
      target.beginPath();
      target.moveTo(from.x, from.y);
      target.lineTo(to.x, to.y);
      target.stroke();
      target.beginPath();
      target.arc(to.x, to.y, props.brushRadius ?? 32, 0, Math.PI * 2);
      target.fill();
    }
  };
  const saveMask = () => {
    if (!maskRaster.current || !props.onMaskChange) return;
    props.onMaskChange({
      uid: crypto.randomUUID(),
      name: m.name_mask(),
      width: iw,
      height: ih,
      dataUrl: maskRaster.current.toDataURL("image/png"),
    });
  };
  const minScale = props.fitWholeImage
    ? fitMinimumScale(iw, ih, size.w, size.h)
    : MIN_SCALE;
  const contentKey = props.image
    ? `img:${props.image.dataUrl.length}:${iw}x${ih}`
    : props.phantom
      ? `ph:${iw}x${ih}`
      : "none";

  // 视口尺寸跟踪
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 内容变化时重新适配视图
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (iw <= 0 || size.w <= 0 || size.h <= 0) return;
    const viewKey = `${contentKey}:${size.w}x${size.h}`;
    if (lastKeyRef.current !== viewKey) {
      lastKeyRef.current = viewKey;
      setView(
        clampCanvasView(
          fitView(iw, ih, size.w, size.h, 24, minScale),
          iw,
          ih,
          size.w,
          size.h,
          minScale,
        ),
      );
    }
  }, [contentKey, iw, ih, size.w, size.h, minScale]);

  // 滚轮缩放（需要非 passive 监听才能 preventDefault）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (
        dragRef.current?.kind === "paint" ||
        (props.tool === "mask-box" && dragRef.current)
      )
        return;
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((v) =>
        zoomCanvasAt(
          v,
          e.clientX - rect.left,
          e.clientY - rect.top,
          factor,
          iw,
          ih,
          size.w,
          size.h,
          minScale,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [iw, ih, size.w, size.h, minScale, props.tool]);

  // 空格键临时平移
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement;
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        setSpaceDown(true);
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  const toImg = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return screenToImg(view, clientX - rect.left, clientY - rect.top);
  };

  const trackCursor = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    setCursorScreen({ x: clientX - rect.left, y: clientY - rect.top });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (iw <= 0) return;
    trackCursor(e.clientX, e.clientY);
    const el = containerRef.current!;
    const wantPan =
      (e.button === 0 && spaceDown) ||
      (e.button === 1 && props.tool !== "box") ||
      props.tool === "pan";
    if (wantPan && e.button !== 2) {
      dragRef.current = {
        kind: "pan",
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        startView: view,
      };
      setInteraction(dragRef.current);
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (props.readOnly) return;
    const drawBox = e.button === 2 && props.tool === "box";
    if (e.button !== 0 && !drawBox) return;
    if (props.onMaskChange && !maskReady) return;
    const p = toImg(e.clientX, e.clientY);
    if (props.onMaskChange && (p.x < 0 || p.y < 0 || p.x > iw || p.y > ih))
      return;
    props.onGestureStart?.();
    // 右键画包围盒，优先于已有框体和缩放手柄；矩形蒙版仍使用左键。
    if (drawBox || props.tool === "mask-box") {
      e.preventDefault();
      props.onSelect(null);
      draftRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      setDraft(draftRef.current);
      dragRef.current = {
        kind: "create",
        pointerId: e.pointerId,
        startImg: p,
      };
      setInteraction(dragRef.current);
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (props.tool === "brush" || props.tool === "eraser") {
      dragRef.current = { kind: "paint", pointerId: e.pointerId, lastPoint: p };
      setInteraction(dragRef.current);
      el.setPointerCapture(e.pointerId);
      paint(p, p);
      return;
    }

    // 1. 选中框的手柄
    const selected = props.boxes.find((b) => b.id === props.selectedId);
    if (selected) {
      const h = pickHandle(selected.rect, p.x, p.y, view.scale);
      if (h) {
        dragRef.current = {
          kind: "resize",
          pointerId: e.pointerId,
          boxId: selected.id,
          origRect: selected.rect,
          origSrcRect: selected.srcRect ?? null,
          handle: h,
        };
        setInteraction(dragRef.current);
        el.setPointerCapture(e.pointerId);
        return;
      }
    }
    // 2. 命中框体（后绘制者优先）
    for (let i = props.boxes.length - 1; i >= 0; i--) {
      const b = props.boxes[i];
      if (hitTest(b.rect, p.x, p.y)) {
        props.onSelect(b.id);
        dragRef.current = {
          kind: "move",
          pointerId: e.pointerId,
          boxId: b.id,
          origRect: b.rect,
          origSrcRect: b.srcRect ?? null,
          grab: p,
        };
        setInteraction(dragRef.current);
        el.setPointerCapture(e.pointerId);
        return;
      }
    }
    // 左键点击空白处取消选择，不创建包围盒。
    props.onSelect(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (iw > 0) trackCursor(e.clientX, e.clientY);
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan" && d.startClient && d.startView) {
      setView(
        clampCanvasView(
          {
            ...d.startView,
            tx: d.startView.tx + (e.clientX - d.startClient.x),
            ty: d.startView.ty + (e.clientY - d.startClient.y),
          },
          iw,
          ih,
          size.w,
          size.h,
          minScale,
        ),
      );
      return;
    }
    const p = toImg(e.clientX, e.clientY);
    if (d.kind === "paint" && d.lastPoint) {
      paint(d.lastPoint, p);
      d.lastPoint = p;
      return;
    }
    if (d.kind === "create" && d.startImg) {
      const r = rectFromDrag(d.startImg.x, d.startImg.y, p.x, p.y, iw, ih);
      draftRef.current = r;
      setDraft(r);
      return;
    }
    if (d.kind === "move" && d.origRect && d.grab) {
      const next = moveRect(d.origRect, p.x - d.grab.x, p.y - d.grab.y, iw, ih);
      props.onChange(
        props.boxes.map((b) =>
          b.id === d.boxId
            ? {
                ...b,
                rect: next,
              }
            : b,
        ),
      );
      return;
    }
    if (d.kind === "resize" && d.origRect && d.handle) {
      const hp = handlePoint(d.origRect, d.handle);
      const next = resizeRect(
        d.origRect,
        d.handle,
        p.x - hp.x,
        p.y - hp.y,
        8,
        iw,
        ih,
      );
      props.onChange(
        props.boxes.map((b) => (b.id === d.boxId ? { ...b, rect: next } : b)),
      );
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setInteraction(null);
    if (d?.kind === "paint") saveMask();
    if (d?.kind === "create" && draftRef.current) {
      const cur = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (cur.w >= 4 && cur.h >= 4) {
        if (props.tool === "mask-box") {
          maskRaster.current
            ?.getContext("2d")
            ?.clearRect(cur.x, cur.y, cur.w, cur.h);
          const display = maskOverlay.current?.getContext("2d");
          if (display) {
            display.globalCompositeOperation = "source-over";
            display.fillStyle = "#000";
            display.fillRect(cur.x, cur.y, cur.w, cur.h);
          }
          saveMask();
          props.onGestureEnd?.();
          return;
        }
        if (props.onCreateRect) {
          props.onCreateRect(cur);
          props.onGestureEnd?.();
          return;
        }
        let n = props.boxes.length + 1;
        let id = `obj_${n}`;
        while (props.boxes.some((b) => b.id === id)) id = `obj_${++n}`;
        props.onChange([
          ...props.boxes,
          {
            uid: crypto.randomUUID(),
            id,
            role: props.editMode ? "new" : "place",
            rect: cur,
            desc: "",
          },
        ]);
        props.onSelect(id);
      }
    }
    props.onGestureEnd?.();
  };

  const zoomBy = (factor: number) => {
    if (size.w <= 0) return;
    setView((v) =>
      zoomCanvasAt(
        v,
        size.w / 2,
        size.h / 2,
        factor,
        iw,
        ih,
        size.w,
        size.h,
        minScale,
      ),
    );
  };

  const fit = () =>
    setView(
      clampCanvasView(
        fitView(iw, ih, size.w, size.h, 24, minScale),
        iw,
        ih,
        size.w,
        size.h,
        minScale,
      ),
    );
  const oneToOne = () =>
    setView(
      clampCanvasView(
        { scale: 1, tx: (size.w - iw) / 2, ty: (size.h - ih) / 2 },
        iw,
        ih,
        size.w,
        size.h,
        minScale,
      ),
    );

  const s = view.scale;
  const cursorImg = cursorScreen
    ? screenToImg(view, cursorScreen.x, cursorScreen.y)
    : null;
  const selectedBox = props.boxes.find((b) => b.id === props.selectedId);
  const editing =
    !props.readOnly &&
    props.tool !== "pan" &&
    !spaceDown &&
    interaction?.kind !== "pan";
  const hoveredHandle =
    editing && selectedBox && cursorImg
      ? pickHandle(selectedBox.rect, cursorImg.x, cursorImg.y, s)
      : null;
  const activeHandle =
    interaction?.kind === "resize"
      ? (interaction.handle ?? null)
      : hoveredHandle;
  const insideBox =
    editing &&
    cursorImg &&
    props.boxes.some((b) => hitTest(b.rect, cursorImg.x, cursorImg.y));
  const cursor =
    interaction?.kind === "pan"
      ? "grabbing"
      : props.tool === "pan" || spaceDown
        ? "grab"
        : props.readOnly
          ? "default"
          : interaction?.kind === "resize" && interaction.handle
            ? HANDLE_CURSORS[interaction.handle]
            : interaction?.kind === "move"
              ? "move"
              : interaction?.kind === "create"
                ? "crosshair"
                : hoveredHandle
                  ? HANDLE_CURSORS[hoveredHandle]
                  : insideBox
                    ? "move"
                    : "crosshair";

  return (
    <div
      ref={containerRef}
      className="canvas-surface relative h-full w-full overflow-hidden dotgrid select-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setCursorScreen(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${s})`,
        }}
      >
        <div className="relative" style={{ width: iw, height: ih }}>
          {props.image && (
            <img
              src={props.image.dataUrl}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-fill"
              style={{
                imageRendering: s >= 3 ? "pixelated" : "auto",
                objectFit: props.imageFit ?? "fill",
              }}
            />
          )}
          {props.phantom && !props.image && (
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 border border-dashed border-zinc-700 bg-zinc-900/30"
              style={{ borderWidth: 1 / s }}
            >
              <span className="text-zinc-500" style={{ fontSize: 13 / s }}>
                {m.canvas_output()}
              </span>
              <span className="text-zinc-600" style={{ fontSize: 11 / s }}>
                {props.dimensionLabel ?? `${iw}×${ih}`}
                {!props.readOnly && props.coordinateMode !== "pixels"
                  ? m.canvas_draw_hint()
                  : ""}
              </span>
            </div>
          )}
          {props.onMaskChange && (
            <canvas
              ref={maskOverlay}
              className="absolute inset-0 pointer-events-none"
              style={{ width: iw, height: ih }}
            />
          )}

          {props.boxes.map((b) => (
            <BoxView
              key={b.uid ?? b.id}
              box={b}
              scale={s}
              selected={b.id === props.selectedId}
              highlightedHandle={
                b.id === props.selectedId &&
                editing &&
                interaction?.kind !== "create" &&
                interaction?.kind !== "move"
                  ? activeHandle
                  : null
              }
              iw={iw}
              ih={ih}
              coordinateMode={props.coordinateMode}
            />
          ))}
          {draft && (
            <BoxView
              box={{
                id: "",
                role: props.image ? "new" : "place",
                rect: draft,
                desc: "",
              }}
              scale={s}
              draft
              iw={iw}
              ih={ih}
              coordinateMode={props.coordinateMode}
            />
          )}
        </div>
      </div>
      {editing &&
        (props.tool === "brush" || props.tool === "eraser") &&
        cursorScreen && (
          <div
            className="brush-cursor"
            style={{
              left: cursorScreen.x,
              top: cursorScreen.y,
              width: (props.brushRadius ?? 32) * s * 2,
              height: (props.brushRadius ?? 32) * s * 2,
            }}
          />
        )}

      {/* 底部工具条 */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerEnter={() => setCursorScreen(null)}
        className="overlay-glass absolute bottom-3 left-3 flex items-center gap-0.5 rounded-md px-1 py-1 text-xs"
      >
        <button
          className="rounded p-1 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(1 / 1.25)}
          title={m.canvas_zoom_out()}
        >
          <Minus size={13} />
        </button>
        <span className="w-14 text-center tabular-nums text-zinc-400">
          {Math.round(s * 100)}%
        </span>
        <button
          className="rounded p-1 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(1.25)}
          title={m.canvas_zoom_in()}
        >
          <Plus size={13} />
        </button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button
          className="rounded px-1.5 py-0.5 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={fit}
        >
          {m.canvas_fit()}
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          onClick={oneToOne}
        >
          1:1
        </button>
      </div>

      {/* 坐标读数 */}
      <div className="overlay-glass absolute bottom-3 right-3 rounded-md px-2.5 py-1 text-xs tabular-nums text-zinc-400">
        {props.dimensionLabel ??
          (cursorImg && iw > 0
            ? `${Math.round(clampCoord(cursorImg.x, iw, 0))}, ${Math.round(clampCoord(cursorImg.y, ih, 0))} px`
            : `${iw}×${ih}`)}
      </div>
    </div>
  );
}

function clampCoord(v: number, max: number, span: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max - span));
}

function BoxView({
  box,
  scale,
  selected,
  highlightedHandle,
  draft,
  iw,
  ih,
  coordinateMode,
}: {
  box: Box;
  scale: number;
  selected?: boolean;
  highlightedHandle?: Handle | null;
  draft?: boolean;
  iw: number;
  ih: number;
  coordinateMode?: "normalized" | "pixels";
}) {
  const color = box.color ?? BOX_COLORS[0];
  const bw = (selected ? 2 : 1.5) / scale;
  const wire =
    coordinateMode === "pixels"
      ? [
          box.rect.y,
          box.rect.x,
          box.rect.y + box.rect.h,
          box.rect.x + box.rect.w,
        ].map(Math.round)
      : rectToWire(box.rect, iw, ih);
  return (
    <>
      {box.srcRect && (
        <div
          className="absolute"
          style={{
            left: box.srcRect.x,
            top: box.srcRect.y,
            width: box.srcRect.w,
            height: box.srcRect.h,
            border: `${bw}px dashed ${color}`,
            opacity: 0.8,
          }}
        >
          <span
            className="absolute whitespace-nowrap"
            style={{
              left: 0,
              bottom: "100%",
              background: color,
              color: "#141414",
              fontSize: 13 / scale,
              fontWeight: 650,
              lineHeight: 1.3,
              padding: `${3 / scale}px ${7 / scale}px`,
              borderRadius: `${3 / scale}px ${3 / scale}px 0 0`,
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {m.canvas_source()}
          </span>
        </div>
      )}
      <div
        className="absolute"
        style={{
          left: box.rect.x,
          top: box.rect.y,
          width: box.rect.w,
          height: box.rect.h,
          border: `${bw}px ${box.role === "remove" ? "dashed" : "solid"} ${color}`,
          opacity: draft ? 0.9 : 1,
          boxShadow: selected
            ? `0 0 0 ${1 / scale}px rgba(255,255,255,0.35)`
            : undefined,
          background: selected ? `${color}40` : `${color}08`,
        }}
      >
        {/* 标签条：ID + 协议坐标（随拖拽实时更新） */}
        <span
          className="absolute whitespace-nowrap"
          style={{
            left: -bw,
            bottom: "100%",
            background: color,
            color: "#141414",
            fontSize: 13 / scale,
            fontWeight: 650,
            lineHeight: 1.3,
            padding: `${4 / scale}px ${8 / scale}px`,
            borderRadius: `${3 / scale}px ${3 / scale}px 0 0`,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {box.role === "remove"
            ? m.canvas_remove()
            : box.role === "move"
              ? m.canvas_target()
              : ""}
          {box.id || "…"}{" "}
          {selected && (
            <span>
              [{wire[0]}, {wire[1]}, {wire[2]}, {wire[3]}]
            </span>
          )}
        </span>
        {/* 区域描述：直接显示在盒内 */}
        {box.desc && (
          <div
            className="absolute inset-0"
            style={{
              padding: `${5 / scale}px ${6 / scale}px`,
              fontSize: 16 / scale,
              lineHeight: 1.4,
              color: "#f2f2f4",
              overflow: "hidden",
              pointerEvents: "none",
              textShadow: `0 0 ${3 / scale}px rgba(0,0,0,0.85), 0 0 ${1 / scale}px rgba(0,0,0,0.9)`,
            }}
          >
            {box.desc}
          </div>
        )}
        {selected &&
          !draft &&
          HANDLES.map((h) => {
            const p = handlePoint(box.rect, h);
            const highlighted = h === highlightedHandle;
            const handleSize = (highlighted ? 12 : 9) / scale;
            return (
              <div
                key={h}
                className="absolute"
                style={{
                  left: p.x - handleSize / 2 - box.rect.x,
                  top: p.y - handleSize / 2 - box.rect.y,
                  width: handleSize,
                  height: handleSize,
                  background: highlighted ? color : "#fff",
                  border: `${1 / scale}px solid ${color}`,
                  borderRadius: 2 / scale,
                  boxShadow: highlighted
                    ? `0 0 0 ${2 / scale}px rgba(255,255,255,0.55), 0 0 ${6 / scale}px ${color}`
                    : undefined,
                  pointerEvents: "none",
                  transition: "background-color 100ms, box-shadow 100ms",
                }}
              />
            );
          })}
      </div>
    </>
  );
}
