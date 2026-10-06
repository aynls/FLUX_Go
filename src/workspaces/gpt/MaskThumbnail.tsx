import { useEffect, useRef } from "react";
import type { WorkingImage } from "../../lib/types";

export default function MaskThumbnail({
  image,
  mask,
}: {
  image: WorkingImage;
  mask: WorkingImage;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let alive = true;
    const scale = Math.min(96 / image.width, 84 / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const source = document.createElement("img");
    const stencil = document.createElement("img");
    const draw = () => {
      if (!alive || !source.naturalWidth || !stencil.naturalWidth) return;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      // 请求蒙版的透明区域是编辑区域，预览中显示为黑色。
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(stencil, 0, 0, width, height);
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(source, 0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    };
    source.onload = draw;
    stencil.onload = draw;
    source.src = image.dataUrl;
    stencil.src = mask.dataUrl;
    return () => {
      alive = false;
    };
  }, [image.dataUrl, image.width, image.height, mask.dataUrl]);

  return (
    <canvas ref={canvasRef} role="img" aria-label="主图与黑色编辑蒙版" />
  );
}
