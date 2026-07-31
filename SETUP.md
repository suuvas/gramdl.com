# GramDL — Cloudflare Pages Deployment Guide

## What's in this package

| Path | Purpose |
|---|---|
| `index.html` | React SPA entry point (Vite build) |
| `assets/` | All JS/CSS bundles (hashed filenames, immutable cache) |
| `og-image.png` | Social sharing preview image |
| `functions/api/download.ts` | POST /api/download — Instagram media fetch |
| `functions/api/proxy-download.ts` | GET /api/proxy-download — CDN file proxy with streaming |
| `functions/api/health.ts` | GET /api/health — uptime check |
| `functions/sitemap.xml.ts` | GET /sitemap.xml — dynamic SEO sitemap |
| `functions/robots.txt.ts` | GET /robots.txt — crawler directives |
| `functions/_lib/provider.ts` | SaveInsta provider + Googlebot caption extraction |
| `_headers` | Security headers (CSP, HSTS, caching) |
| `_redirects` | SPA fallback routing |
| `_routes.json` | CF Pages routing config (which paths go to Functions vs static) |
| `wrangler.toml` | Cloudflare configuration |

---

## Before You Deploy

### 1. Replace AdSense Publisher ID

Search for `ca-pub-YOUR_ADSENSE_ID` in **two places** and replace with your real publisher ID:

```
index.html  (line 11 and 16)
```

Your publisher ID looks like: `ca-pub-1234567890123456`

You also need to replace the AdSense slot IDs inside your React components. Open
`functions/_lib/` — the **frontend components** (already built into `assets/`) use
placeholder slot IDs. To use real ad units, rebuild from source after updating
`client/src/components/adsense-banner.tsx`.

### 2. Update Your Domain

If your domain is NOT `gramdl.com`, update these files:
- `wrangler.toml` → `name` field
- `functions/sitemap.xml.ts` → `SITE_URL` constant
- `functions/robots.txt.ts` → sitemap URL

### 3. Add Google Verification (optional but recommended for SEO)

Add your Google Search Console verification meta tag to `index.html`:
```html
<meta name="google-site-verification" content="YOUR_CODE_HERE" />
```

---

## Deployment Steps

### Option A: Cloudflare Pages Dashboard (Recommended)

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to **Workers & Pages** → **Create application** → **Pages**
3. Choose **Direct Upload**
4. **Compress this entire folder as a ZIP** and upload it
5. Set **Build output directory** to `/` (root — we're uploading the built files directly)
6. Click **Deploy**

### Option B: Wrangler CLI

```bash
# Install Wrangler
npm install -g wrangler

# Login
wrangler login

# Deploy (from this directory)
wrangler pages deploy . --project-name=gramdl
```

---

## AdSense Guidelines — Compliance Checklist

Every ad placement in this build satisfies Google AdSense policies:

| Rule | Status |
|---|---|
| Every ad unit labeled "Advertisement" | ✅ |
| Min-height reserved on every ad container (CLS = 0) | ✅ |
| No ad placed within 150px of a download button | ✅ |
| No ad placed within interactive form elements | ✅ |
| Mobile anchor ad is dismissible with close button | ✅ |
| Mobile anchor ad ≤ 100px tall | ✅ (84px) |
| Page content is substantially more than ads | ✅ |
| Auto-ads script present in `<head>` | ✅ (replace publisher ID) |
| CSP headers allow all required AdSense domains | ✅ |
| No `maximum-scale` viewport restriction (accessibility) | ✅ |
| No popups or auto-redirect ads | ✅ |

**Ad unit locations (8 placements):**
1. Top Leaderboard (728×90 desktop / responsive mobile) — above the fold
2. After download form — in-content rectangle
3. After download results — highest-intent placement
4. After tools grid — qualified audience
5. Between Features and FAQ — deep scroll / high dwell time
6. After FAQ — engaged readers
7. Before footer — final impression
8. Fixed sidebar 300×600 Half-Page + 300×250 Rectangle (desktop only)
9. Mobile sticky anchor 320×50 (mobile only, dismissible)

---

## SEO — What's Included

- **Title + Meta description** on every page (unique per tool page)
- **Canonical URLs** set to `https://gramdl.com`
- **Open Graph** tags for Facebook/WhatsApp sharing
- **Twitter Card** tags for Twitter/X sharing
- **3 JSON-LD schemas**: SoftwareApplication, WebSite (with SearchAction), Organization
- **Dynamic sitemap.xml** with all 30 URLs, priorities, and change frequencies
- **robots.txt** pointing to sitemap
- **`og-image.png`** (1200×630) for social previews
- Structured data with `aggregateRating` (boosts rich snippets in search)
- `max-image-preview:large` robots meta (full-size previews in Google)
- All assets use hashed filenames → immutable caching → fast repeat visits

---

## Architecture Notes

### Caption Extraction (Googlebot trick)
The server fetches `https://www.instagram.com/p/{postId}/` using the
`Googlebot/2.1` user-agent. Instagram allows Googlebot through its bot-detection
wall (it has to for SEO). The `og:description` meta tag contains the full caption
in the format `"X likes, Y comments - username on DATE: "CAPTION TEXT"`.

### Caching Strategy
- **CF Cache API** (`caches.default`) caches Instagram media results for 30 minutes at every Cloudflare PoP
- **Static assets** have `max-age=31536000, immutable` (browsers cache forever until hash changes)
- **Proxy downloads** in stable ID mode are cached at CF edge for 30 minutes — only the first download per video within 30 minutes hits the origin

### Download Strategy (iOS Fix)
Downloads use `fetch() → ReadableStream → Blob → URL.createObjectURL → a.download`.
iOS Safari supports `a.download` on `blob:` URLs (iOS 13.4+) but NOT on `https://` URLs.
This means no new tab opens, no page navigation — the file saves directly to Camera Roll.

---

## Environment Variables

Set in Cloudflare Pages dashboard → Settings → Environment variables:

| Variable | Required | Description |
|---|---|---|
| `INSTAGRAM_PROVIDER` | No | Set to `"rapidapi"` to use RapidAPI as fallback |
| `INSTAGRAM_PROVIDER_API_KEY` | Only if provider=rapidapi | Your RapidAPI key |

The default provider (SaveInsta) requires **no API key**.

---

## Troubleshooting

**"Caption not available" on all posts**  
Instagram may be temporarily blocking the Googlebot caption fetch from Cloudflare's IP ranges. This is intermittent. Downloads still work normally.

**Downloads fail with 403**  
Instagram CDN tokens expire after ~24 hours. Re-fetch the post URL to get fresh tokens.

**API returns 500 errors**  
Check Cloudflare Pages Function logs: Dashboard → Workers & Pages → gramdl → Functions → View logs.

**AdSense not showing**  
1. Verify you replaced `ca-pub-YOUR_ADSENSE_ID` with your real publisher ID
2. Verify your site is approved in AdSense dashboard
3. Allow 24–48 hours for ads to appear on a newly approved site
