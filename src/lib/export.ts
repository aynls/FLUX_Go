/** Native save dialogs accept absolute Windows or POSIX paths. */
export function exportDefaultPath(directory: string, filename: string): string {
  if (!directory) return filename;
  const separator = directory.includes("\\") || /^[A-Za-z]:/.test(directory) ? "\\" : "/";
  return directory.replace(/[\\/]+$/, "") + separator + filename;
}
