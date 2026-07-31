/** GET /api/health — Cloudflare Pages Function */
export const onRequestGet: PagesFunction = async () => {
  return new Response(
    JSON.stringify({
      status:    "ok",
      provider:  "saveinsta",
      cache:     "cloudflare-cache-api",
      timestamp: new Date().toISOString(),
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
};
