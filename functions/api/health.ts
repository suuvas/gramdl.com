export const onRequestGet: PagesFunction = async () =>
  new Response(
    JSON.stringify({ status: "ok", provider: "saveinsta", cache: "cf-cache-api", ts: new Date().toISOString() }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
