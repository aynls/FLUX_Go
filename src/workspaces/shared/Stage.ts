import type { ReactNode } from "react";
import type { Box, Draft } from "../../lib/types";
export interface StageProps {
  draft: Draft;
  references: ReactNode;
  tool: "box" | "pan";
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (d: Draft) => void;
  onBoxesChange: (boxes: Box[]) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onImportMask: () => void;
  onSource?: (box: Box) => void;
}
