import * as THREE from "three";

let colorMap: THREE.Texture | null = null;
let bumpMap: THREE.Texture | null = null;

function buildCanvas(size: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  draw(ctx);
  return canvas;
}

/** Procedural grainy sand color texture (warm speckled grains). */
export function getSandColorMap(): THREE.Texture {
  if (colorMap) return colorMap;
  const size = 256;
  const canvas = buildCanvas(size, (ctx) => {
    ctx.fillStyle = "#F0EFCC";
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // per-pixel grain
      const n = (Math.random() - 0.5) * 30;
      const warm = (Math.random() - 0.5) * 14;
      d[i] = Math.max(0, Math.min(255, d[i] + n + warm));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n - warm));
    }
    ctx.putImageData(img, 0, 0);
    // sparse darker/lighter coarse grains
    for (let k = 0; k < 1400; k++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() * 1.4 + 0.3;
      const light = Math.random() > 0.5;
      ctx.fillStyle = light ? "rgba(255,253,225,0.6)" : "rgba(240,225,170,0.28)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  colorMap = tex;
  return tex;
}

/** Matching grayscale bump map so the surface reads as granular. */
export function getSandBumpMap(): THREE.Texture {
  if (bumpMap) return bumpMap;
  const size = 256;
  const canvas = buildCanvas(size, (ctx) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 110 + Math.random() * 145;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  bumpMap = tex;
  return tex;
}
