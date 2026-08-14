/**
 * GET /api/proxy-download — Cloudflare Pages Function
 * Streams Instagram CDN files through the CF edge.
 * Modes: ?id=SHORTCODE&quality=hd  OR  ?url=CDN_URL
 */
import { fetchInstagram } from "../_lib/provider";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const ALLOWED = new Set(["dl.snapcdn.app","scontent.cdninstagram.com","instagram.com","cdninstagram.com","fbcdn.net","lookaside.fbsbx.com","video.cdninstagram.com"]);
const allowed = (h: string) => ALLOWED.has(h) || [...ALLOWED].some(a => h.endsWith(`.${a}`));

export const onRequestGet: PagesFunction = async (ctx) => {
  const url      = new URL(ctx.request.url);
  const id       = url.searchParams.get("id");
  const quality  = url.searchParams.get("quality") ?? "hd";
  const rawUrl   = url.searchParams.get("url");
  const filename = (url.searchParams.get("filename") ?? "gramdl-download").replace(/[^a-zA-Z0-9._-]/g, "_");
  const isImage  = /\.(jpg|jpeg|png|webp|gif)$/i.test(filename);

  let cdnUrl: string;
  let stable = false;

  if (id) {
    stable = true;
    const sc = id.replace(/[^A-Za-z0-9_-]/g, "");
    if (sc.length < 5) return err(400, "Invalid id");

    const cache = caches.default;
    const key   = new Request(`https://gramdl-cache.local/result/${sc}`);
    let   hit   = await cache.match(key);
    let   data: any = hit ? await hit.json() : null;

    if (!data?.media?.length) {
      for (const t of ["reel","p","tv"]) {
        try {
          data = await fetchInstagram(`https://www.instagram.com/${t}/${sc}/`, sc, t);
          ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
          })));
          break;
        } catch { /* try next */ }
      }
    }
    if (!data?.media?.length) return err(404, "Session not found. Re-fetch the URL.");
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "_");
    const item: any = data.media.find((m: any) => norm(m.quality) === norm(quality)) || data.media.find((m: any) => m.quality === "HD") || data.media[0];
    if (!item?.url) return err(404, "Quality not available");
    cdnUrl = item.url;
  } else if (rawUrl) {
    let p: URL;
    try { p = new URL(rawUrl); } catch { return err(400, "Invalid URL"); }
    if (p.protocol !== "https:") return err(400, "Only HTTPS");
    if (!allowed(p.hostname)) return err(400, "Host not permitted");
    cdnUrl = rawUrl;
  } else {
    return err(400, "Provide 'id' or 'url' param");
  }

  try {
    const up = await fetch(cdnUrl, {
      headers: {
        "User-Agent":      UA,
        "Accept":          isImage ? "image/webp,image/*,*/*;q=0.8" : "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":         "https://www.instagram.com/",
        "Sec-Fetch-Dest":  isImage ? "image" : "video",
        "Sec-Fetch-Mode":  "no-cors",
        "Sec-Fetch-Site":  "cross-site",
      },
    });
    if (!up.ok) return err(502, `Upstream ${up.status}`);

    const ct  = up.headers.get("content-type") || (isImage ? "image/jpeg" : "application/octet-stream");
    const cl  = up.headers.get("content-length");
    const hdr: Record<string, string> = {
      "Content-Type":        ct,
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename="${filename}"`,
      "Accept-Ranges":       "bytes",
      "Cache-Control":       stable ? "public, max-age=1800, s-maxage=1800, immutable" : "private, no-store",
    };
    if (cl) hdr["Content-Length"] = cl;
    return new Response(up.body, { status: 200, headers: hdr });
  } catch (e) {
    console.error("[proxy]", e);
    return err(500, "Proxy failed");
  }
};

const err = (s: number, m: string) =>
  new Response(JSON.stringify({ error: m }), { status: s, headers: { "Content-Type": "application/json" } });
