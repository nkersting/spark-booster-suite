import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_maps";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const GOOGLE_MAPS_API_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY");

const BM_BASE = "https://www.britishmuseum.org/collection/search";

interface GeoHit { lat: number; lon: number; country: string | null }

function searchUrl(keyword: string, page = 1) {
  const p = new URLSearchParams({
    keyword,
    display: "true",
    image: "true",
    view: "grid",
    sort: "object_name__asc",
    page: String(page),
  });
  return `${BM_BASE}?${p.toString()}`;
}

/**
 * The museum's site sits behind a bot challenge, so a server-side export often
 * fails. Try the documented CSV routes; the caller falls back to a manual
 * download when this returns blocked.
 */
async function tryFetchCsv(keyword: string): Promise<{ csv?: string; blocked: true } | { csv: string; blocked: false }> {
  const candidates = [
    `${searchUrl(keyword)}&format=csv`,
    `https://www.britishmuseum.org/api/collection/search/csv?keyword=${encodeURIComponent(keyword)}&display=true&image=true`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/csv,application/csv,*/*",
        },
      });
      if (!res.ok) continue;
      const text = await res.text();
      const head = text.slice(0, 400).toLowerCase();
      if (head.includes("museum number") && text.includes(",")) {
        return { csv: text, blocked: false };
      }
    } catch (_) {
      // try the next candidate
    }
  }
  return { blocked: true };
}

async function geocodeOne(place: string, box?: [[number, number], [number, number]]): Promise<GeoHit | null> {
  const params = new URLSearchParams({ address: place, language: "en" });
  if (box) params.set("bounds", `${box[0][0]},${box[0][1]}|${box[1][0]},${box[1][1]}`);
  const res = await fetch(`${GATEWAY_URL}/maps/api/geocode/json?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": GOOGLE_MAPS_API_KEY ?? "",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[${res.status}]: ${body}`);
  }
  const data = await res.json();
  const hit = data?.results?.[0];
  if (!hit) return null;
  const country =
    (hit.address_components || []).find((c: any) => (c.types || []).includes("country"))?.long_name ?? null;
  return { lat: hit.geometry?.location?.lat, lon: hit.geometry?.location?.lng, country };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === "image") {
      const rawUrl = String(body?.url ?? "").slice(0, 2000);
      let imageUrl: URL;
      try {
        imageUrl = new URL(rawUrl);
      } catch (_) {
        return new Response(JSON.stringify({ error: "invalid image URL" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const ALLOWED_IMAGE_HOSTS = new Set([
        "media.britishmuseum.org",
        "images.metmuseum.org",
        "collectionapi.metmuseum.org",
      ]);
      if (imageUrl.protocol !== "https:" || !ALLOWED_IMAGE_HOSTS.has(imageUrl.hostname)) {
        return new Response(JSON.stringify({ error: "image host is not allowed" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // The British Museum's HTTPS media endpoint currently serves an
      // incomplete certificate chain to server runtimes. Its HTTP endpoint
      // serves the same public image, so fetch that internally and return it
      // over our own HTTPS/CORS response.
      if (imageUrl.hostname === "media.britishmuseum.org") {
        imageUrl.protocol = "http:";
      }

      const imageResponse = await fetch(imageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      const contentType = imageResponse.headers.get("content-type") ?? "";
      if (!imageResponse.ok || !contentType.startsWith("image/")) {
        return new Response(JSON.stringify({ error: "museum image unavailable" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(imageResponse.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400, s-maxage=604800",
        },
      });
    }

    if (action === "csv") {
      const keyword = String(body?.keyword ?? "").trim().slice(0, 200);
      if (!keyword) {
        return new Response(JSON.stringify({ error: "keyword is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await tryFetchCsv(keyword);
      return new Response(JSON.stringify({ ...result, url: searchUrl(keyword) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "geocode") {
      if (!LOVABLE_API_KEY || !GOOGLE_MAPS_API_KEY) {
        return new Response(JSON.stringify({ error: "Google Maps is not connected" }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const items = Array.isArray(body?.places) ? body.places.slice(0, 200) : [];
      const results: Record<string, GeoHit | null> = {};
      const CONCURRENCY = 5;
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        const chunk = items.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(async (it: any) => {
            const place = String(it?.place ?? "").slice(0, 160);
            const key = String(it?.key ?? place);
            if (!place) return;
            try {
              results[key] = await geocodeOne(place, it?.box);
            } catch (err) {
              console.error("geocode failed", place, err instanceof Error ? err.message : err);
              results[key] = null;
            }
          }),
        );
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("bm-museum error", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
