import type { HistoryItem } from "./types";

function isWindowsRoot(root: string) {
  return /^[a-zA-Z]:[\\/]/.test(root) || /^[\\/]{2}/.test(root);
}

function stripTrailing(path: string) {
  return path.replace(/[\\/]+$/, "");
}

function relativeTo(path: string, root: string) {
  if (isWindowsRoot(root)) {
    const base = stripTrailing(root.replace(/\\/g, "/")).toLowerCase();
    const normalized = path.replace(/\\/g, "/");
    const lower = normalized.toLowerCase();
    if (lower === base) return "";
    if (lower.startsWith(base + "/")) return normalized.slice(base.length + 1);
    return null;
  }
  const base = root.replace(/\/+$/, "");
  if (path === base) return "";
  if (path.startsWith(base + "/")) return path.slice(base.length + 1);
  return null;
}

function rebase(path: string | null | undefined, from: string, to: string) {
  if (path == null) return path;
  const relative = relativeTo(path, from);
  if (relative == null) return path;
  if (isWindowsRoot(from)) {
    const separator = to.includes("\\") ? "\\" : "/";
    const root = stripTrailing(to.replace(/\\/g, "/")).replace(/\//g, separator);
    return relative
      ? root + separator + relative.replace(/\//g, separator)
      : root;
  }
  const root = to.replace(/\/+$/, "");
  return relative ? root + "/" + relative : root;
}

export function rebaseHistoryPaths(
  item: HistoryItem,
  previousRoot: string,
  newRoot: string,
): HistoryItem {
  return {
    ...item,
    inputFiles: item.inputFiles.map(
      (path) => rebase(path, previousRoot, newRoot) ?? path,
    ),
    resultFiles: item.resultFiles.map(
      (path) => rebase(path, previousRoot, newRoot) ?? path,
    ),
    thumbFile: rebase(item.thumbFile, previousRoot, newRoot),
    maskFile: rebase(item.maskFile, previousRoot, newRoot),
  };
}
