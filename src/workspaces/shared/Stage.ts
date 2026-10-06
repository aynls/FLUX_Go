import type { ReactNode } from "react";
import type { Box, Draft } from "../../lib/types";
export interface StageProps {
  draft: Draft;
  references: ReactNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (d: Draft) => void;
  onBoxesChange: (boxes: Box[]) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onImportMask: () => void;
}
