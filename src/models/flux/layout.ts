import type { Draft } from "../../lib/types";

export const requiresLayout = (d: Draft) =>
  d.family === "flux" && d.provider === "runware" && !d.refs.length;

/** Disabled construction stays in the draft but never reaches a request. */
export const regionsEnabled = (d: Draft) =>
  d.family === "flux" &&
  (requiresLayout(d) ||
    (d.layoutEnabled ?? (d.intent === "edit" || d.boxes.length > 0)));
