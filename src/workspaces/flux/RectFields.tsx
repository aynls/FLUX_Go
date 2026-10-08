import { useEffect, useRef, useState } from "react";
import { m } from "../../i18n";
import type { Rect } from "../../lib/types";
import { rectToWire } from "../../models/flux/protocol";

export function RectFields({
  label,
  showLabel = true,
  rect,
  width,
  height,
  onChange,
  onValidityChange,
}: {
  label: string;
  showLabel?: boolean;
  rect: Rect;
  width: number;
  height: number;
  onChange: (r: Rect) => void;
  onValidityChange?: (valid: boolean) => void;
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
      onValidityChange?.(true);
    }
  }, [wireKey, width, height, onValidityChange]);
  const commit = () => {
    const next = values.map((value) =>
      value.trim() === "" ? NaN : Number(value),
    );
    if (
      next.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 1000,
      )
    ) {
      setError(m.error_coords_incomplete());
      onValidityChange?.(false);
      return;
    }
    const [top, left, bottom, right] = next;
    if (top >= bottom || left >= right) {
      setError(m.error_coords_order());
      onValidityChange?.(false);
      return;
    }
    setError("");
    onValidityChange?.(true);
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
            onValidityChange?.(true);
          }
        }}
      >
        {(
          [
            ["top", m.coord_top],
            ["left", m.coord_left],
            ["bottom", m.coord_bottom],
            ["right", m.coord_right],
          ] as const
        ).map(([key, name], index) => (
          <label key={key}>
            {name()}
            <input
              aria-label={m.coord_label({ label, name: name() })}
              type="number"
              min={0}
              max={1000}
              step={1}
              value={values[index]}
              aria-invalid={!!error}
              onChange={(e) => {
                const value = e.target.value;
                const next = values.map((text, i) =>
                  i === index ? value : text,
                );
                setValues(next);
                const numbers = next.map((v) =>
                  v.trim() === "" ? NaN : Number(v),
                );
                onValidityChange?.(
                  numbers.every(
                    (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
                  ) &&
                    numbers[0] < numbers[2] &&
                    numbers[1] < numbers[3],
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
