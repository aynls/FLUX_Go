// 前端图像处理：尺寸读取、按上限缩放、缩略图生成。

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}

export async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const img = await loadImage(dataUrl);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

function drawToDataUrl(
  img: HTMLImageElement,
  w: number,
  h: number,
  mime: "image/png" | "image/jpeg",
): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(mime, mime === "image/jpeg" ? 0.85 : undefined);
}

/** 长边超过 maxEdge 时等比缩小（PNG 透明度保留），否则原样返回 */
export async function downscaleDataUrl(dataUrl: string, maxEdge: number): Promise<string> {
  const img = await loadImage(dataUrl);
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (long <= maxEdge) return dataUrl;
  const k = maxEdge / long;
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  return drawToDataUrl(img, w, h, "image/png");
}

/** 生成列表缩略图（JPEG，短边贴边） */
export async function makeThumb(dataUrl: string, edge = 320): Promise<string> {
  const img = await loadImage(dataUrl);
  const k = edge / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  return drawToDataUrl(img, w, h, "image/jpeg");
}
