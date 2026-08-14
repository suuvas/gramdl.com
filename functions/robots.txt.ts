export const onRequestGet: PagesFunction = async () =>
  new Response("User-agent: *\nAllow: /\n\nSitemap: https://gramdl.com/sitemap.xml\n", {
    status: 200,
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" },
  });
