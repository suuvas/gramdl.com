/**
 * GramDL — Cloudflare Worker entry point
 * Handles all API routes; static assets served via ASSETS binding.
 *
 * Routes:
 *   POST /api/download        → Instagram media fetch (SaveInsta provider)
 *   GET  /api/proxy-download  → CDN file proxy with streaming
 *   GET  /api/health          → uptime check
 *   *                         → ASSETS (SPA, handled by not_found_handling = "single-page-application")
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  ASSETS: Fetcher;
}

interface MediaItem {
  quality: string;
  type: "video" | "image";
  url: string;
  filename: string;
}

interface InstagramResult {
  success: true;
  type: "reel" | "post" | "carousel" | "video";
  title: string;
  thumbnail: string;
  media: MediaItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE = "https://saveinsta.to";

const COMMON_H: Record<string, string> = {
  "User-Agent":      UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection":      "keep-alive",
};

function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  req.headers.get("origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonOk(data: unknown, req: Request, cached = false): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store",
      "X-Cache":       cached ? "HIT" : "MISS",
      ...corsHeaders(req),
    },
  });
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchT(url: string, opts: RequestInit, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── Caption via Googlebot UA ─────────────────────────────────────────────────

async function fetchCaption(postId: string): Promise<string> {
  try {
    const res = await fetchT(
      `https://www.instagram.com/p/${postId}/`,
      {
        headers: {
          "User-Agent":      "Googlebot/2.1 (+http://www.google.com/bot.html)",
          "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      10000,
    );
    if (!res.ok) return "";
    const html = await res.text();
    const ogMatch = html.match(/property="og:description"\s+content="([^"]+)"/);
    if (!ogMatch) return "";
    const decoded = ogMatch[1]
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
      .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d)); } catch { return ""; } });
    const cap = decoded.match(/:\s*"(.+)/s);
    if (cap) {
      const text = cap[1].replace(/"$/, "").trim();
      if (text.length > 3) return text;
    }
    return decoded.trim().length > 10 ? decoded.trim() : "";
  } catch {
    return "";
  }
}

// ─── SaveInsta media HTML parser ──────────────────────────────────────────────

function parseMediaHtml(html: string, postId: string, postType: string): InstagramResult {
  const media: MediaItem[] = [];
  let displayThumbnail = "";

  const liBlocks = html.split(/<\/?li>/i).filter((b) => b.includes("download-items"));

  for (let idx = 0; idx < liBlocks.length; idx++) {
    const block = liBlocks[idx];
    const isVideoItem = block.includes("icon-dlvideo");

    if (idx === 0 && !displayThumbnail) {
      const m = block.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
      if (m) displayThumbnail = m[1];
    }

    const aRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*title="([^"]*)"[^>]*>/gi;
    let aMatch: RegExpExecArray | null;

    while ((aMatch = aRe.exec(block)) !== null) {
      const href = aMatch[1];
      const tl   = aMatch[2].toLowerCase();

      if (href.includes("play.google.com") || href.includes("apps.apple.com") || href.includes("facebook.com")) continue;

      if (tl.includes("thumbnail")) {
        if (!media.find((m) => m.quality === "Thumbnail" && m.url === href))
          media.push({ quality: "Thumbnail", type: "image", url: href, filename: `gramdl-${postId}-thumbnail.jpg` });
      } else if (tl.includes("hd") || tl.includes("high")) {
        media.push({ quality: "HD", type: "video", url: href, filename: `gramdl-${postId}-hd.mp4` });
      } else if (tl.includes("sd") || tl.includes("low")) {
        media.push({ quality: "SD", type: "video", url: href, filename: `gramdl-${postId}-sd.mp4` });
      } else if (tl.includes("video")) {
        const q  = liBlocks.length > 1 ? `Video ${idx + 1}` : "HD";
        const fn = liBlocks.length > 1 ? `gramdl-${postId}-v${idx}.mp4` : `gramdl-${postId}-hd.mp4`;
        media.push({ quality: q, type: "video", url: href, filename: fn });
      } else if (tl.includes("photo") || tl.includes("image")) {
        const q = liBlocks.length > 1 ? `Image ${idx + 1}` : "Image";
        media.push({ quality: q, type: "image", url: href, filename: `gramdl-${postId}-img${idx}.jpg` });
      } else if (isVideoItem) {
        const q = liBlocks.length > 1 ? `Video ${idx + 1}` : "HD";
        media.push({ quality: q, type: "video", url: href, filename: `gramdl-${postId}-v${idx}.mp4` });
      }
    }
  }

  if (media.length === 0) throw new Error("No downloadable media found in response HTML");

  const thumbnail  = displayThumbnail || media.find((m) => m.type === "image")?.url || media[0]?.url || "";
  const videoCount = media.filter((m) => m.type === "video" && m.quality !== "Thumbnail").length;
  const imageCount = media.filter((m) => m.type === "image" && m.quality !== "Thumbnail").length;
  const isCarousel = videoCount + imageCount > 1;
  const hasVideo   = videoCount > 0;
  const type = isCarousel ? "carousel" : postType === "reel" ? "reel" : hasVideo ? "video" : "post";

  return { success: true, type: type as InstagramResult["type"], title: `Instagram ${type}`, thumbnail, media };
}

// ─── SaveInsta 3-step fetch ───────────────────────────────────────────────────

async function fetchInstagram(url: string, postId: string, postType: string): Promise<InstagramResult> {
  // Step 1: page tokens
  const pageRes = await fetchT(`${BASE}/en/video`, {
    headers: {
      ...COMMON_H,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });
  if (!pageRes.ok) throw new Error(`Page fetch failed: ${pageRes.status}`);
  const pageHtml = await pageRes.text();

  const scriptBlock = pageHtml.match(/var\s+k_url_search\s*=\s*"[^"]*"([\s\S]*?)<\/script>/)?.[1] ?? "";
  const k_exp   = scriptBlock.match(/k_exp\s*=\s*"([^"]+)"/)?.[1];
  const k_token = scriptBlock.match(/k_token\s*=\s*"([^"]+)"/)?.[1];
  if (!k_exp || !k_token) throw new Error("k_exp / k_token not found");

  // Step 2: verify token
  const verifyRes = await fetchT(`${BASE}/api/userverify`, {
    method: "POST",
    headers: {
      ...COMMON_H,
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE,
      Referer: `${BASE}/en/video`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({ url }).toString(),
  }, 10000);
  if (!verifyRes.ok) throw new Error(`Verify failed: ${verifyRes.status}`);
  const verifyData: any = await verifyRes.json();
  const cftoken: string = verifyData?.token;
  if (!cftoken) throw new Error("No cftoken from userverify");

  // Steps 3a + 3b in parallel: media search + caption
  const searchBody = new URLSearchParams({ k_exp, k_token, q: url, t: "media", lang: "en", v: "v2", cftoken }).toString();
  const [searchRes, captionText] = await Promise.all([
    fetchT(`${BASE}/api/ajaxSearch`, {
      method: "POST",
      headers: {
        ...COMMON_H,
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: BASE,
        Referer: `${BASE}/en/video`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: searchBody,
    }),
    fetchCaption(postId),
  ]);

  if (!searchRes.ok) throw new Error(`ajaxSearch failed: ${searchRes.status}`);
  const searchData: any = await searchRes.json();
  if (searchData?.status !== "ok" || !searchData?.data)
    throw new Error(`API returned: ${searchData?.mess || searchData?.status || "unknown"}`);

  const result = parseMediaHtml(searchData.data as string, postId, postType);
  if (captionText) result.title = captionText;
  return result;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleDownload(req: Request, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders(req) });

  let body: any;
  try { body = await req.json(); } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON.");
  }

  const rawUrl: string = body?.url || "";
  if (!rawUrl) return jsonError(400, "invalid_url", "Please provide an Instagram URL.");

  const igMatch = rawUrl.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  if (!igMatch) return jsonError(400, "invalid_url", "Could not find a post, reel, or video in this URL.");
  const [, postType, postId] = igMatch;

  let cleanUrl: string;
  try {
    const parsed = new URL(rawUrl);
    cleanUrl = `https://www.instagram.com${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return jsonError(400, "invalid_url", "Could not parse URL.");
  }

  // CF Cache check
  const cache    = caches.default;
  const cacheKey = new Request(`https://gramdl-cache.local/result/${postId}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return jsonOk(await cached.json(), req, true);

  try {
    const result = await fetchInstagram(cleanUrl, postId, postType);
    ctx.waitUntil(
      cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
      }))
    );
    return jsonOk(result, req, false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[download] ${postId}:`, msg);
    if (msg.toLowerCase().includes("private") || msg.toLowerCase().includes("not found"))
      return jsonError(404, "not_found", "This post could not be found. It may be private or deleted.");
    return jsonError(500, "provider_failed", "Could not fetch the Instagram content. Please check the URL and try again.");
  }
}

const ALLOWED_HOSTS = new Set([
  "dl.snapcdn.app", "scontent.cdninstagram.com", "instagram.com",
  "cdninstagram.com", "fbcdn.net", "lookaside.fbsbx.com", "video.cdninstagram.com",
]);
function isAllowedHost(h: string): boolean {
  if (ALLOWED_HOSTS.has(h)) return true;
  for (const a of ALLOWED_HOSTS) if (h.endsWith(`.${a}`)) return true;
  return false;
}

async function handleProxy(req: Request, ctx: ExecutionContext): Promise<Response> {
  const url      = new URL(req.url);
  const id       = url.searchParams.get("id");
  const quality  = url.searchParams.get("quality") ?? "hd";
  const rawUrl   = url.searchParams.get("url");
  const filename = (url.searchParams.get("filename") ?? "gramdl-download").replace(/[^a-zA-Z0-9._-]/g, "_");
  const isImage  = /\.(jpg|jpeg|png|webp|gif)$/i.test(filename);

  let cdnUrl: string;
  let stable = false;

  if (id) {
    stable = true;
    const shortcode = id.replace(/[^A-Za-z0-9_-]/g, "");
    if (shortcode.length < 5) return new Response("Invalid id", { status: 400 });

    const cache     = caches.default;
    const resultKey = new Request(`https://gramdl-cache.local/result/${shortcode}`);
    let   cached    = await cache.match(resultKey);
    let   data: any = cached ? await cached.json() : null;

    if (!data?.media?.length) {
      for (const t of ["reel", "p", "tv"]) {
        try {
          data = await fetchInstagram(`https://www.instagram.com/${t}/${shortcode}/`, shortcode, t);
          ctx.waitUntil(cache.put(resultKey, new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
          })));
          break;
        } catch { /* try next */ }
      }
    }
    if (!data?.media?.length) return new Response("Session not found", { status: 404 });

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "_");
    const item: any =
      data.media.find((m: any) => norm(m.quality) === norm(quality)) ||
      data.media.find((m: any) => m.quality === "HD") ||
      data.media[0];
    if (!item?.url) return new Response("Quality not available", { status: 404 });
    cdnUrl = item.url;

  } else if (rawUrl) {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return new Response("Invalid URL", { status: 400 }); }
    if (parsed.protocol !== "https:") return new Response("Only HTTPS URLs", { status: 400 });
    if (!isAllowedHost(parsed.hostname)) return new Response("Host not permitted", { status: 400 });
    cdnUrl = rawUrl;
  } else {
    return new Response("Provide 'id' or 'url' parameter", { status: 400 });
  }

  try {
    const upstream = await fetch(cdnUrl, {
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
    if (!upstream.ok) return new Response(`Upstream error ${upstream.status}`, { status: 502 });

    const ct  = upstream.headers.get("content-type") || (isImage ? "image/jpeg" : "application/octet-stream");
    const cl  = upstream.headers.get("content-length");
    const hdr: Record<string, string> = {
      "Content-Type":        ct,
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename="${filename}"`,
      "Accept-Ranges":       "bytes",
    };
    if (cl) hdr["Content-Length"] = cl;
    hdr["Cache-Control"] = stable
      ? "public, max-age=1800, s-maxage=1800, immutable"
      : "private, no-store";

    return new Response(upstream.body, { status: 200, headers: hdr });
  } catch (e) {
    console.error("[proxy]", e);
    return new Response("Proxy failed", { status: 500 });
  }
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/download")       return handleDownload(request, ctx);
    if (pathname === "/api/proxy-download") return handleProxy(request, ctx);
    if (pathname === "/api/health") {
      return new Response(
        JSON.stringify({ status: "ok", provider: "saveinsta", cache: "cf-cache-api", ts: new Date().toISOString() }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
      );
    }

    // All other requests → static assets (SPA fallback via not_found_handling)
    return env.ASSETS.fetch(request);
  },
};
