/** GET /robots.txt — Cloudflare Pages Function */
export const onRequestGet: PagesFunction = async () => {
  return new Response(
    "User-agent: *\nAllow: /\n\nSitemap: https://gramdl.com/sitemap.xml\n",
    {
      status: 200,
      headers: {
        "Content-Type":  "text/plain",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
};
