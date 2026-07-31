/**
 * POST /api/download
 * Cloudflare Pages Function — handles Instagram URL fetching.
 * Uses CF Cache API to cache results at the edge for 30 minutes.
 */

import { fetchInstagram } from "../_lib/provider";

export const onRequestPost: PagesFunction = async (ctx) => {
  const req = ctx.request;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON.");
  }

  const rawUrl: string = body?.url || "";
  if (!rawUrl || typeof rawUrl !== "string") {
    return jsonError(400, "invalid_url", "Please provide an Instagram URL.");
  }

  // Validate Instagram URL
  const igPattern = /instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/i;
  const match = rawUrl.match(igPattern);
  if (!match) {
    return jsonError(400, "invalid_url", "Could not find a post, reel, or video in this URL.");
  }
  const [, postType, postId] = match;

  // Sanitise URL
  let cleanUrl: string;
  try {
    const parsed = new URL(rawUrl);
    cleanUrl = `https://www.instagram.com${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return jsonError(400, "invalid_url", "Could not parse URL.");
  }

  // ── CF Cache API lookup ──────────────────────────────────────────────────
  const cache       = caches.default;
  const cacheKey    = new Request(`https://gramdl-cache.local/result/${postId}`);
  const cachedResp  = await cache.match(cacheKey);
  if (cachedResp) {
    const data = await cachedResp.json();
    return jsonOk(data, req, true);
  }

  // ── Fetch from provider ──────────────────────────────────────────────────
  try {
    const result = await fetchInstagram(cleanUrl, postId, postType);

    // Store in CF cache for 30 minutes
    const toCache = new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));

    return jsonOk(result, req, false);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Provider error [${postId}]:`, message);

    if (message.startsWith("RATE_LIMIT:")) {
      return jsonError(503, "provider_rate_limit", "Service temporarily busy. Please try again in a few minutes.");
    }
    if (message.toLowerCase().includes("blocking automated") || message.toLowerCase().includes("session cookie")) {
      return jsonError(503, "api_key_required", "Instagram is blocking direct requests.");
    }
    if (message.toLowerCase().includes("private") || message.toLowerCase().includes("not found")) {
      return jsonError(404, "not_found", "This post could not be found. It may be private or deleted.");
    }
    return jsonError(500, "provider_failed", "Could not fetch the Instagram content. Please check the URL and try again.");
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonOk(data: unknown, req: Request, cached: boolean): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type":  "application/json",
      "X-Cache":       cached ? "HIT" : "MISS",
      "Cache-Control": "no-store",
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
