// 包围盒候选颜色；可在这里调整色池。使用六位十六进制颜色。
export const BOX_COLORS = [
  "#a3e635", "#60a5fa", "#f472b6", "#fb923c",
  "#a78bfa", "#2dd4bf", "#facc15", "#f87171",
] as const;

/** 随机打乱一整池，抽完前不补充；调用方保存剩余色池。 */
export function drawBoxColor(remaining: readonly string[]): { color: string; remaining: string[] } {
  const pool = remaining.length ? [...remaining] : [...BOX_COLORS];
  if (!remaining.length) for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const color = pool.pop()!;
  return { color, remaining: pool };
}
