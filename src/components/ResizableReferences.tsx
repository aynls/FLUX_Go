import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { m } from "../i18n";

export const MIN_REFERENCE_WIDTH = 180;
export const MAX_REFERENCE_WIDTH = 420;
export const DEFAULT_REFERENCE_WIDTH = 238;
export const referenceWidth = (width: number | undefined) =>
  Math.min(
    MAX_REFERENCE_WIDTH,
    Math.max(
      MIN_REFERENCE_WIDTH,
      Number.isFinite(width) ? width! : DEFAULT_REFERENCE_WIDTH,
    ),
  );

export default function ResizableReferences({
  width,
  onWidthChange,
  children,
}: {
  width: number | undefined;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);
  const [resizing, setResizing] = useState(false);
  const value = referenceWidth(width);
  const maximum = () =>
    Math.max(
      MIN_REFERENCE_WIDTH,
      Math.min(
        MAX_REFERENCE_WIDTH,
        (panel.current?.parentElement?.getBoundingClientRect().width ||
          MAX_REFERENCE_WIDTH + 320) -
          (panel.current?.previousElementSibling?.getBoundingClientRect().width || 0) -
          320,
      ),
    );
  const update = (next: number, max = maximum()) =>
    onWidthChange(Math.round(Math.min(max, referenceWidth(next))));
  const finish = () => {
    drag.current = null;
    setResizing(false);
  };
  return (
    <div
      ref={panel}
      role="region"
      aria-label={m.references_panel()}
      style={{ "--reference-sidebar-width": `${value}px` } as CSSProperties}
      className={"reference-sidebar" + (resizing ? " resizing" : "")}
    >
      {children}
      <div
        className="reference-resizer"
        role="separator"
        aria-label={m.references_resize()}
        aria-orientation="vertical"
        aria-valuemin={MIN_REFERENCE_WIDTH}
        aria-valuemax={MAX_REFERENCE_WIDTH}
        aria-valuenow={value}
        aria-valuetext={`${value}px`}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return;
          const actualWidth = panel.current?.getBoundingClientRect().width ?? 0;
          if (!actualWidth) return;
          e.preventDefault();
          e.currentTarget.focus();
          drag.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startWidth: actualWidth,
            maxWidth: maximum(),
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          setResizing(true);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start?.pointerId === e.pointerId)
            update(start.startWidth + e.clientX - start.startX, start.maxWidth);
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointerId !== e.pointerId) return;
          finish();
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onKeyDown={(e) => {
          const actualWidth =
            panel.current?.getBoundingClientRect().width || value;
          const next =
            e.key === "ArrowRight"
              ? actualWidth + 10
              : e.key === "ArrowLeft"
                ? actualWidth - 10
                : e.key === "Home"
                  ? MIN_REFERENCE_WIDTH
                  : e.key === "End"
                    ? maximum()
                    : null;
          if (next != null) {
            e.preventDefault();
            update(next);
          }
        }}
      />
    </div>
  );
}
