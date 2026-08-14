/**
 * SaveInsta provider — Cloudflare Pages Functions edition.
 * Pure Web Fetch API — no Node.js, no ioredis.
 * Caption extraction via Googlebot UA on the Instagram post page.
 */

export interface MediaItem {
  quality: string;
  type: "video" | "image";
  url: string;
  filename: string;
}

export interface InstagramResult {
  success: true;
  type: "reel" | "post" | "carousel" | "video";
  title: string;
  thumbnail: string;
  media: MediaItem[];
}

const BASE = "https://saveinsta.to";
const UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H: Record<string, string> = {
  "User-Agent":      UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection":      "keep-alive",
};

async function fetchT(url: string, opts: RequestInit, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── Caption via Googlebot UA ───────────────────────────────────────────────────
export async function fetchCaption(postId: string): Promise<string> {
  try {
    const res = await fetchT(`https://www.instagram.com/p/${postId}/`, {
      headers: {
        "User-Agent":      "Googlebot/2.1 (+http://www.google.com/bot.html)",
        "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, 10000);
    if (!res.ok) return "";
    const html = await res.text();
    const og = html.match(/property="og:description"\s+content="([^"]+)"/);
    if (!og) return "";
    const decoded = og[1]
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
      .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d)); } catch { return ""; } });
    const cap = decoded.match(/:\s*"(.+)/s);
    if (cap) { const t = cap[1].replace(/"$/, "").trim(); if (t.length > 3) return t; }
    return decoded.trim().length > 10 ? decoded.trim() : "";
  } catch { return ""; }
}

// ── Media HTML parser ─────────────────────────────────────────────────────────
function parseMediaHtml(html: string, postId: string, postType: string): InstagramResult {
  const media: MediaItem[] = [];
  let displayThumbnail = "";
  const liBlocks = html.split(/<\/?li>/i).filter(b => b.includes("download-items"));

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
        if (!media.find(m => m.quality === "Thumbnail" && m.url === href))
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
  const thumbnail  = displayThumbnail || media.find(m => m.type === "image")?.url || media[0]?.url || "";
  const videoCount = media.filter(m => m.type === "video" && m.quality !== "Thumbnail").length;
  const imageCount = media.filter(m => m.type === "image" && m.quality !== "Thumbnail").length;
  const isCarousel = videoCount + imageCount > 1;
  const type = isCarousel ? "carousel" : postType === "reel" ? "reel" : videoCount > 0 ? "video" : "post";
  return { success: true, type: type as InstagramResult["type"], title: `Instagram ${type}`, thumbnail, media };
}

// ── 3-step SaveInsta fetch ────────────────────────────────────────────────────
export async function fetchInstagram(url: string, postId: string, postType: string): Promise<InstagramResult> {
  // Step 1: get page tokens
  const pageRes = await fetchT(`${BASE}/en/video`, {
    headers: { ...H, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Upgrade-Insecure-Requests": "1", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
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
    headers: { ...H, Accept: "*/*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Origin: BASE, Referer: `${BASE}/en/video`, "X-Requested-With": "XMLHttpRequest" },
    body: new URLSearchParams({ url }).toString(),
  }, 10000);
  if (!verifyRes.ok) throw new Error(`Verify failed: ${verifyRes.status}`);
  const verifyData: any = await verifyRes.json();
  const cftoken: string = verifyData?.token;
  if (!cftoken) throw new Error("No cftoken from userverify");

  // Steps 3a + 3b in parallel: media + caption
  const [searchRes, captionText] = await Promise.all([
    fetchT(`${BASE}/api/ajaxSearch`, {
      method: "POST",
      headers: { ...H, Accept: "*/*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Origin: BASE, Referer: `${BASE}/en/video`, "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ k_exp, k_token, q: url, t: "media", lang: "en", v: "v2", cftoken }).toString(),
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
