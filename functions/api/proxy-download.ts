/**
 * GET /api/proxy-download
 * Cloudflare Pages Function — proxies Instagram CDN files through our edge.
 *
 * Modes:
 *   STABLE: ?id=SHORTCODE&quality=hd&filename=...  (CF-cacheable, preferred)
 *   LEGACY: ?url=CDN_URL&filename=...               (not cacheable, for direct URLs)
 *
 * In STABLE mode the response carries Cache-Control: public, max-age=1800
 * so Cloudflare caches the file at the edge — subsequent downloads within 30min
 * are served free from the nearest PoP with zero origin egress.
 */

import { fetchInstagram } from "../_lib/provider";

// Allowed CDN hostnames (SSRF allowlist)
const ALLOWED_HOSTS = new Set([
  "dl.snapcdn.app",
  "scontent.cdninstagram.com",
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
  "lookaside.fbsbx.com",
  "video.cdninstagram.com",
]);

function isAllowedHost(hostname: string): boolean {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  for (const h of ALLOWED_HOSTS) {
    if (hostname.endsWith(`.${h}`)) return true;
  }
  return false;
}

export const onRequestGet: PagesFunction = async (ctx) => {
  const url   = new URL(ctx.request.url);
  const id       = url.searchParams.get("id");
  const quality  = url.searchParams.get("quality") ?? "hd";
  const rawUrl   = url.searchParams.get("url");
  const filename = url.searchParams.get("filename") ?? "gramdl-download";

  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const isImage      = /\.(jpg|jpeg|png|webp|gif)$/i.test(safeFilename);

  let cdnUrl: string;
  let stableMode = false;

  if (id) {
    // ── Stable ID mode ────────────────────────────────────────────────────
    stableMode = true;
    const shortcode = id.replace(/[^A-Za-z0-9_-]/g, "");
    if (!shortcode || shortcode.length < 5) {
      return err400("Invalid id parameter");
    }

    // Look up in CF Cache
    const cache      = caches.default;
    const resultKey  = new Request(`https://gramdl-cache.local/result/${shortcode}`);
    let   cached     = await cache.match(resultKey);
    let   resultData: any = cached ? await cached.json() : null;

    // Cache miss — re-fetch
    if (!resultData?.media?.length) {
      for (const type of ["reel", "p", "tv"]) {
        try {
          const igUrl = `https://www.instagram.com/${type}/${shortcode}/`;
          resultData  = await fetchInstagram(igUrl, shortcode, type);
          const toCache = new Response(JSON.stringify(resultData), {
            headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
          });
          ctx.waitUntil(cache.put(resultKey, toCache));
          break;
        } catch { /* try next type */ }
      }
    }

    if (!resultData?.media?.length) {
      return err404("Download session not found. Please re-fetch the Instagram URL.");
    }

    const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, "_");
    const item: any =
      resultData.media.find((m: any) => normalise(m.quality) === normalise(quality)) ||
      resultData.media.find((m: any) => m.quality === "HD") ||
      resultData.media[0];

    if (!item?.url) return err404("Requested quality not available.");
    cdnUrl = item.url;

  } else if (rawUrl) {
    // ── Legacy URL mode ───────────────────────────────────────────────────
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return err400("Invalid URL"); }
    if (parsed.protocol !== "https:") return err400("Only HTTPS URLs allowed");
    if (!isAllowedHost(parsed.hostname)) return err400("URL host not permitted");
    cdnUrl = rawUrl;

  } else {
    return err400("Provide 'id' + 'quality', or 'url' parameter");
  }

  // ── Fetch from CDN and stream ─────────────────────────────────────────────
  try {
    const upstream = await fetch(cdnUrl, {
      headers: isImage
        ? {
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept":          "image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.instagram.com/",
            "Sec-Fetch-Dest":  "image",
            "Sec-Fetch-Mode":  "no-cors",
            "Sec-Fetch-Site":  "cross-site",
          }
        : {
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept":          "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.instagram.com/",
            "Sec-Fetch-Dest":  "video",
            "Sec-Fetch-Mode":  "no-cors",
            "Sec-Fetch-Site":  "cross-site",
          },
    });

    if (!upstream.ok) return err500(`Upstream returned ${upstream.status}`);

    const contentType   = upstream.headers.get("content-type")   || (isImage ? "image/jpeg" : "application/octet-stream");
    const contentLength = upstream.headers.get("content-length");
    const disposition   = isImage ? "inline" : "attachment";

    const headers: Record<string, string> = {
      "Content-Type":        contentType,
      "Content-Disposition": `${disposition}; filename="${safeFilename}"`,
      "Accept-Ranges":       "bytes",
    };
    if (contentLength) headers["Content-Length"] = contentLength;
    if (stableMode) {
      headers["Cache-Control"]                = "public, max-age=1800, s-maxage=1800, immutable";
      headers["Cloudflare-CDN-Cache-Control"] = "max-age=1800";
    } else {
      headers["Cache-Control"] = "private, no-store";
    }

    // CF Workers supports Response body passthrough — stream directly from CDN to client
    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    console.error("Proxy error:", e);
    return err500("Failed to proxy the download");
  }
};

const err400 = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });
const err404 = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 404, headers: { "Content-Type": "application/json" } });
const err500 = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
