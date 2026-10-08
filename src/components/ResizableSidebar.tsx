import { useRef, useState, type ReactNode } from "react";
import { m } from "../i18n";

export const MIN_SIDEBAR_WIDTH = 20;
export const MAX_SIDEBAR_WIDTH = 40;
const clampWidth = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));

export default function ResizableSidebar({ widthPercent, onWidthChange, children }: {
  widthPercent: number; onWidthChange: (width: number) => void; children: ReactNode;
}) {
  const width = clampWidth(Number.isFinite(widthPercent) ? widthPercent : 25);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; workspaceWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const finish = () => { drag.current = null; setResizing(false); };
  return <aside className={"sidebar" + (resizing ? " resizing" : "")} style={{ width: width + "%" }}>
    {children}
    <div className="sidebar-resizer" role="separator" aria-label={m.sidebar_resize()} aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={Math.round(width)} aria-valuetext={Math.round(width) + "%"} tabIndex={0}
      onPointerDown={e => {
        if (e.button !== 0 || !e.isPrimary) return;
        const workspaceWidth = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 0;
        if (!workspaceWidth) return;
        e.preventDefault(); e.currentTarget.focus();
        drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width, workspaceWidth };
        e.currentTarget.setPointerCapture(e.pointerId); setResizing(true);
      }}
      onPointerMove={e => {
        const start = drag.current;
        if (start?.pointerId === e.pointerId) onWidthChange(clampWidth(start.startWidth + (e.clientX - start.startX) / start.workspaceWidth * 100));
      }}
      onPointerUp={e => { if (drag.current?.pointerId !== e.pointerId) return; finish(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={e => {
        const next = e.key === "ArrowLeft" ? width - 1 : e.key === "ArrowRight" ? width + 1 : e.key === "Home" ? MIN_SIDEBAR_WIDTH : e.key === "End" ? MAX_SIDEBAR_WIDTH : null;
        if (next !== null) { e.preventDefault(); onWidthChange(clampWidth(next)); }
      }} />
  </aside>;
}
