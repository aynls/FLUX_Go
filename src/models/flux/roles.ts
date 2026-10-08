import type { Box } from "../../lib/types";
import { m } from "../../i18n";

export const ROLE_LABELS: Record<Box["role"], string> = {
  get new() {
    return m.role_new();
  },
  get modify() {
    return m.role_modify();
  },
  get remove() {
    return m.role_remove();
  },
  get move() {
    return m.role_move();
  },
  get anchor() {
    return m.role_anchor();
  },
  get place() {
    return m.role_place();
  },
};
