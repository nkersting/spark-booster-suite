import * as THREE from "three";

/**
 * Builds a geographically accurate equirectangular Earth texture
 * (blue ocean, green land) from Natural Earth land polygons.
 */
let cached: THREE.Texture | null = null;
let pending: Promise<THREE.Texture> | null = null;

const WIDTH = 4096;
const HEIGHT = 2048;

const OCEAN = "#007380";
const LAND = "#0A542A";
const COAST = "#0A542A";

export function getEarthTexture(): Promise<THREE.Texture> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;

  pending = (async () => {
    const [{ feature }, land] = await Promise.all([
      import("topojson-client"),
      import("world-atlas/land-50m.json"),
    ]);
    const { geoEquirectangular, geoPath, geoGraticule } = await import("d3-geo");

    const topo: any = (land as any).default ?? land;
    const geo = feature(topo, topo.objects.land) as any;

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = OCEAN;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Equirectangular: x spans -180..180, y spans 90..-90 over the full canvas.
    const projection = geoEquirectangular()
      .scale(WIDTH / (2 * Math.PI))
      .translate([WIDTH / 2, HEIGHT / 2]);
    const path = geoPath(projection, ctx as any);

    // graticule (subtle lat/lon grid)
    ctx.beginPath();
    path(geoGraticule().step([15, 15])() as any);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    path(geo);
    ctx.fillStyle = LAND;
    ctx.fill();
    ctx.strokeStyle = COAST;
    ctx.lineWidth = 2;
    ctx.stroke();

    // equator
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT / 2);
    ctx.lineTo(WIDTH, HEIGHT / 2);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    cached = texture;
    return texture;
  })();

  return pending;
}
