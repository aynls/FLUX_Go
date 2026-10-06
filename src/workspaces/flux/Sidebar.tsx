import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  DotsSixVertical,
  Trash,
} from "@phosphor-icons/react";
import {
  RouteControls,
  PromptEditor,
  ParameterFields,
  InputOptions,
  GenerateFooter,
  Validation,
} from "../shared/Controls";
import { changeRole, taskIntent } from "../../lib/workspace";
import { regionsEnabled, requiresLayout } from "../../models/flux/layout";
import { rectToWire } from "../../lib/protocol";
import { ROLE_LABELS } from "../../models/flux/roles";
import type { Box, Draft, ProviderStatus, Rect } from "../../lib/types";
import type { GenerationTask } from "../../lib/types";

export interface SidebarProps {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onReorder: (boxes: Box[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (uid: string, id: string) => void;
  providerStatus: ProviderStatus | null;
  busy: boolean;
  finalPreview: string;
  errors: string[];
  onGenerate: (count: number) => void;
  onSettings: () => void;
  generationTask?: GenerationTask | null;
  queueCount?: number;
  sentRequestId?: string;
  onShowTask?: () => void;
}

export default function Sidebar(p: SidebarProps) {
  const d = p.draft;

  const [renameError, setRenameError] = useState("");
  const [collapsedUid, setCollapsedUid] = useState<string | null>(null);
  useEffect(() => {
    setCollapsedUid(null);
    const element = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-box-uid]") ?? [],
    ).find(
      (el) =>
        el.dataset.boxUid ===
        p.draft.boxes.find((b) => b.id === p.selectedId)?.uid,
    );
    element?.scrollIntoView?.({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [p.selectedId]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ uid: string; pointerId: number; y: number } | null>(
    null,
  );
  const [draggingUid, setDraggingUid] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState(0);
  const updateDrop = (y: number) => {
    const cards = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-box-uid]") ?? [],
    ).filter((el) => el.dataset.boxUid !== drag.current?.uid);
    const index = cards.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    const destination = index < 0 ? cards.length : index;
    setDropIndex(destination);
    return destination;
  };
  const finishDrag = () => {
    drag.current = null;
    setDraggingUid(null);
  };
  useEffect(() => {
    if (!draggingUid) return;
    let frame: number;
    const tick = () => {
      const body = bodyRef.current;
      const current = drag.current;
      if (!body || !current) return;
      const rect = body.getBoundingClientRect();
      const edge = 48;
      const speed =
        current.y < rect.top + edge
          ? -Math.min(12, (rect.top + edge - current.y) / 4)
          : current.y > rect.bottom - edge
            ? Math.min(12, (current.y - rect.bottom + edge) / 4)
            : 0;
      if (speed) {
        body.scrollTop += speed;
        updateDrop(current.y);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.addEventListener("blur", finishDrag);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("blur", finishDrag);
    };
  }, [draggingUid]);
  const remaining = d.boxes.filter((b) => b.uid !== draggingUid);
  const beforeUid = draggingUid ? remaining[dropIndex]?.uid : undefined;
  const afterUid =
    draggingUid && dropIndex >= remaining.length
      ? remaining.at(-1)?.uid
      : undefined;

  const updateBox = (box: Box) =>
    p.onChange({
      ...d,
      boxes: d.boxes.map((b) => (b.uid === box.uid ? box : b)),
    });
  const toggleBox = (box: Box) => {
    if (box.id === p.selectedId && box.uid !== collapsedUid)
      setCollapsedUid(box.uid!);
    else {
      setCollapsedUid(null);
      p.onSelect(box.id);
    }
  };
  return (
    <>
      <div ref={bodyRef} className="sidebar-body">
        <RouteControls {...p} />
        <PromptEditor {...p} />
        <section>
          <h2>输出</h2>
          <ParameterFields {...p} keys={["resolution", "aspectRatio"]} />
        </section>
        <section>
          <label className="check">
            <input
              type="checkbox"
              checked={regionsEnabled(d)}
              disabled={requiresLayout(d)}
              onChange={(e) =>
                p.onChange({ ...d, layoutEnabled: e.target.checked })
              }
            />
            {taskIntent(d) === "create" ? "区域构图" : "区域编辑"}
          </label>
          {requiresLayout(d) ? (
            <p className="help">此路由需要至少一个放置区域。</p>
          ) : !regionsEnabled(d) && d.boxes.length > 0 ? (
            <p className="help">保留 {d.boxes.length} 个区域，当前不会发送。</p>
          ) : null}
        </section>
        {regionsEnabled(d) && (
          <section>
            <div className="section-heading">
              <h2>区域 · {d.boxes.length}</h2>
              <span className="muted">在画布上右键拖拽画框</span>
            </div>
            {renameError && (
              <p role="alert" className="error-text">
                {renameError}
              </p>
            )}
            <div
              ref={listRef}
              className={"box-list" + (draggingUid ? " sorting" : "")}
            >
              {d.boxes.map((b, index) => (
                <div
                  data-box-uid={b.uid}
                  className={
                    "box-card " +
                    (b.uid === draggingUid ? "sorting-source " : "") +
                    (b.uid === beforeUid ? "drop-before " : "") +
                    (b.uid === afterUid ? "drop-after" : "")
                  }
                  key={b.uid}
                >
                  <div className="box-heading">
                    <button
                      className="box-sort-handle"
                      aria-label={"排序 " + b.id}
                      title="拖动排序，或用 ↑ / ↓ 键调整"
                      disabled={d.boxes.length < 2}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !e.isPrimary || !b.uid) return;
                        e.preventDefault();
                        e.currentTarget.focus();
                        drag.current = {
                          uid: b.uid,
                          pointerId: e.pointerId,
                          y: e.clientY,
                        };
                        setDropIndex(index);
                        setDraggingUid(b.uid);
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        if (drag.current?.pointerId === e.pointerId) {
                          drag.current.y = e.clientY;
                          updateDrop(e.clientY);
                        }
                      }}
                      onPointerUp={(e) => {
                        if (drag.current?.pointerId !== e.pointerId) return;
                        const uid = drag.current.uid;
                        const target = updateDrop(e.clientY);
                        const moving = d.boxes.find((box) => box.uid === uid);
                        finishDrag();
                        if (e.currentTarget.hasPointerCapture(e.pointerId))
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        if (
                          moving &&
                          d.boxes.findIndex((box) => box.uid === uid) !== target
                        ) {
                          const boxes = d.boxes.filter(
                            (box) => box.uid !== uid,
                          );
                          boxes.splice(target, 0, moving);
                          p.onReorder(boxes);
                        }
                      }}
                      onPointerCancel={finishDrag}
                      onLostPointerCapture={finishDrag}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          finishDrag();
                          return;
                        }
                        const target =
                          e.key === "ArrowUp"
                            ? index - 1
                            : e.key === "ArrowDown"
                              ? index + 1
                              : null;
                        if (target === null) return;
                        e.preventDefault();
                        if (target < 0 || target >= d.boxes.length) return;
                        const boxes = [...d.boxes];
                        boxes.splice(index, 1);
                        boxes.splice(target, 0, b);
                        p.onReorder(boxes);
                      }}
                    >
                      <DotsSixVertical size={16} />
                    </button>
                    <button
                      className="box-title"
                      aria-expanded={
                        b.id === p.selectedId && b.uid !== collapsedUid
                      }
                      onClick={() => toggleBox(b)}
                    >
                      <span className="row">
                        <span
                          className="box-color-dot"
                          style={{ background: b.color }}
                        />
                        {b.id}
                      </span>
                    </button>
                    <button
                      className="box-header-action"
                      aria-expanded={
                        b.id === p.selectedId && b.uid !== collapsedUid
                      }
                      aria-label={
                        (b.id === p.selectedId && b.uid !== collapsedUid
                          ? "收起 "
                          : "展开 ") + b.id
                      }
                      title={
                        b.id === p.selectedId && b.uid !== collapsedUid
                          ? "收起"
                          : "展开"
                      }
                      onClick={() => toggleBox(b)}
                    >
                      {b.id === p.selectedId && b.uid !== collapsedUid ? (
                        <CaretUp size={16} />
                      ) : (
                        <CaretDown size={16} />
                      )}
                    </button>
                    <button
                      className="box-header-action danger"
                      aria-label={"删除 " + b.id}
                      title="删除包围盒"
                      onClick={() => {
                        if (drag.current?.uid === b.uid) finishDrag();
                        p.onChange({
                          ...d,
                          boxes: d.boxes.filter((x) => x.uid !== b.uid),
                        });
                        if (b.id === p.selectedId) p.onSelect(null);
                      }}
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                  {b.id === p.selectedId && b.uid !== collapsedUid && (
                    <>
                      <div className="field-grid">
                        <label>
                          引用名称
                          <NameField
                            value={b.id}
                            onCommit={(id) => {
                              if (
                                !/^[A-Za-z0-9_]+$/.test(id) ||
                                d.boxes.some(
                                  (x) => x.uid !== b.uid && x.id === id,
                                )
                              ) {
                                setRenameError(
                                  "名称须唯一，只含字母、数字、下划线",
                                );
                                return false;
                              }
                              setRenameError("");
                              p.onRename(b.uid!, id);
                              return true;
                            }}
                          />
                        </label>
                        <label>
                          操作
                          <select
                            aria-label="区域操作"
                            value={
                              d.refs.length && b.role === "place"
                                ? "new"
                                : b.role
                            }
                            onChange={(e) =>
                              updateBox(
                                changeRole(b, e.target.value as Box["role"], d),
                              )
                            }
                          >
                            {(d.refs.length
                              ? ["new", "modify", "move", "anchor", "remove"]
                              : ["place"]
                            ).map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABELS[role as Box["role"]]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label>
                        区域描述
                        <textarea
                          rows={2}
                          value={b.desc}
                          placeholder={
                            b.role === "remove"
                              ? "描述要移除的物体"
                              : "描述该区域中的内容或期望外观"
                          }
                          onChange={(e) =>
                            updateBox({ ...b, desc: e.target.value })
                          }
                        />
                      </label>
                      {b.role !== "remove" && b.role !== "anchor" && (
                        <RectFields
                          label="目标区域 · 0–1000"
                          showLabel={false}
                          rect={b.rect}
                          width={d.canvas.w}
                          height={d.canvas.h}
                          onChange={(rect) => updateBox({ ...b, rect })}
                        />
                      )}
                      {["move", "anchor", "remove"].includes(b.role) && (
                        <>
                          <label>
                            来源参考图
                            <select
                              value={b.sourceId ?? ""}
                              onChange={(e) => {
                                const r = d.refs.find(
                                  (r) => r.uid === e.target.value,
                                )!;
                                updateBox({
                                  ...b,
                                  sourceId: r.uid,
                                  srcRect: {
                                    x: 0,
                                    y: 0,
                                    w: r.width / 2,
                                    h: r.height / 2,
                                  },
                                });
                              }}
                            >
                              <option value="" disabled>
                                请选择来源
                              </option>
                              {d.refs.map((r, i) => (
                                <option key={r.uid} value={r.uid}>
                                  图片 {i + 1} · {r.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
        <details>
          <summary>高级参数</summary>
          <ParameterFields
            {...p}
            keys={["safetyTolerance", "grounding", "version"]}
          />
        </details>
        <InputOptions {...p} />
        {d.provider === "runware" && (
          <details>
            <summary>输出文件</summary>
            <ParameterFields
              {...p}
              keys={["outputFormat", "outputCompression"]}
            />
          </details>
        )}
        <Validation errors={p.errors} />
      </div>
      <GenerateFooter {...p} />
    </>
  );
}

function NameField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <input
      aria-label="区域名称"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== value && !onCommit(text.trim())) setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export function RectFields({
  label,
  showLabel = true,
  rect,
  width,
  height,
  onChange,
}: {
  label: string;
  showLabel?: boolean;
  rect: Rect;
  width: number;
  height: number;
  onChange: (r: Rect) => void;
}) {
  const wire = rectToWire(rect, width, height);
  const wireKey = wire.join(",");
  const [values, setValues] = useState(() => wire.map(String));
  const [error, setError] = useState("");
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setValues(wireKey.split(","));
      setError("");
    }
  }, [wireKey, width, height]);
  const commit = () => {
    const next = values.map((value) =>
      value.trim() === "" ? NaN : Number(value),
    );
    if (
      next.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 1000,
      )
    ) {
      setError("请填完整四个坐标，使用 0–1000 的整数。");
      return;
    }
    const [top, left, bottom, right] = next;
    if (top >= bottom || left >= right) {
      setError("上须小于下，左须小于右。");
      return;
    }
    setError("");
    setValues(next.map(String));
    if (next.join(",") !== wireKey)
      onChange({
        x: (left / 1000) * width,
        y: (top / 1000) * height,
        w: ((right - left) / 1000) * width,
        h: ((bottom - top) / 1000) * height,
      });
  };
  return (
    <div>
      {showLabel && <p className="muted">{label}</p>}
      <div
        className="coords"
        onFocusCapture={() => {
          editing.current = true;
        }}
        onBlur={(e) => {
          if (
            e.relatedTarget instanceof Node &&
            e.currentTarget.contains(e.relatedTarget)
          )
            return;
          editing.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setValues(wire.map(String));
            setError("");
          }
        }}
      >
        {(["上", "左", "下", "右"] as const).map((name, index) => (
          <label key={name}>
            {name}
            <input
              aria-label={label + " " + name}
              type="number"
              min={0}
              max={1000}
              step={1}
              value={values[index]}
              aria-invalid={!!error}
              onChange={(e) => {
                const value = e.target.value;
                setValues((previous) =>
                  previous.map((text, i) => (i === index ? value : text)),
                );
                setError("");
              }}
            />
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
