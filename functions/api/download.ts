/**
 * POST /api/download — Cloudflare Pages Function
 * Uses CF Cache API to cache results 30 min at every PoP.
 */
import { fetchInstagram } from "../_lib/provider";

export const onRequestPost: PagesFunction = async (ctx) => {
  const req = ctx.request;
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
    const p = new URL(rawUrl);
    cleanUrl = `https://www.instagram.com${p.pathname.replace(/\/$/, "")}`;
  } catch { return jsonError(400, "invalid_url", "Could not parse URL."); }

  const cache    = caches.default;
  const cacheKey = new Request(`https://gramdl-cache.local/result/${postId}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return jsonOk(await cached.json(), req, true);

  try {
    const result = await fetchInstagram(cleanUrl, postId, postType);
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
    })));
    return jsonOk(result, req, false);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[download] ${postId}:`, msg);
    if (msg.toLowerCase().includes("private") || msg.toLowerCase().includes("not found"))
      return jsonError(404, "not_found", "This post could not be found. It may be private or deleted.");
    return jsonError(500, "provider_failed", "Could not fetch the Instagram content. Please try again.");
  }
};

function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  req.headers.get("origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}
function jsonOk(data: unknown, req: Request, cached: boolean): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Cache": cached ? "HIT" : "MISS", ...corsHeaders(req) },
  });
}
function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error, message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}
