// _worker.js
// Cloudflare Workers entry for Zcash Japan (Workers + Static Assets mode)
// - Handles /api/note-feed by fetching note.com RSS
// - Falls through to static assets (index.html, etc.) for everything else

const RSS_URL = 'https://note.com/zcashjapan/rss';
const SHIELDED_URL = 'https://mainnet.zcashexplorer.app/api/v1/blockchain-info';

// Live shielded-pool data, proxied server-side to avoid browser CORS issues.
// Same upstream source that zecstats.com uses.
async function handleShielded() {
  try {
    const res = await fetch(SHIELDED_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' },
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const data = await res.json();
    const pools = {};
    for (const p of (data.valuePools || [])) pools[p.id] = p.chainValue;
    const body = {
      circulating: data.chainSupply ? data.chainSupply.chainValue : null,
      orchard: pools.orchard || 0,
      sapling: pools.sapling || 0,
      sprout: pools.sprout || 0,
      transparent: pools.transparent || 0,
      lockbox: pools.lockbox || 0,
      blocks: data.blocks || null,
      updated: new Date().toISOString()
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

function pick(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function pickAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
  }
  return out;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleNoteFeed() {
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const xml = await res.text();
    const itemBlocks = pickAll(xml, 'item');

    const items = itemBlocks.map(block => {
      const title = stripHtml(pick(block, 'title'));
      const link = pick(block, 'link');
      const pubDate = pick(block, 'pubDate');
      const description = stripHtml(pick(block, 'description'));
      const categories = pickAll(block, 'category').map(stripHtml);
      const thumbnail =
        pick(block, 'media:thumbnail') ||
        (block.match(/<media:content[^>]*url="([^"]+)"/i) || [])[1] ||
        (block.match(/<enclosure[^>]*url="([^"]+)"/i) || [])[1] ||
        '';

      return {
        title,
        url: link,
        pubDate,
        excerpt: description.length > 160 ? description.slice(0, 160) + '…' : description,
        category: categories[0] || '',
        thumbnail
      };
    }).filter(item => item.title && item.url);

    return new Response(
      JSON.stringify({ items }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600, s-maxage=600'
        }
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ROI comparison (1y/3y/5y vs USD) computed server-side from Yahoo Finance's
// keyless chart API. Done in the Worker so it's one cached upstream call shared
// by all visitors (avoids per-visitor CORS + rate-limit failures), and Yahoo
// gives real gold (GC=F) and the S&P 500 (^GSPC), not just a token proxy.
const ROI_SYMS = [
  ['zec', 'ZEC-USD'],
  ['btc', 'BTC-USD'],
  ['gold', 'GC=F'],
  ['sp500', '^GSPC']
];
const ROI_DAYS = [365, 1095, 1825];

function roiFromYahoo(result, daysAgo) {
  if (!result) return null;
  const ts = result.timestamp;
  const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = q && q.close;
  if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length < 2) return null;
  let latest = null;
  for (let i = closes.length - 1; i >= 0; i--) { if (closes[i] != null) { latest = closes[i]; break; } }
  if (latest == null) return null;
  const target = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  let past = null, pastTs = null, bestDiff = Infinity;
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    const diff = Math.abs(ts[i] - target);
    if (diff < bestDiff) { bestDiff = diff; past = closes[i]; pastTs = ts[i]; }
  }
  if (past == null || past <= 0) return null;
  // require the matched point to be near the target (data goes back far enough)
  if (pastTs > target + 45 * 86400) return null;
  return Math.round(((latest - past) / past) * 100);
}

async function handleRoi() {
  try {
    const out = {};
    for (const [key, sym] of ROI_SYMS) {
      out[key] = {};
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6y&interval=1wk`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZcashJapan/1.0)' },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
        const j = await r.json();
        const result = j && j.chart && j.chart.result && j.chart.result[0];
        for (const d of ROI_DAYS) out[key][d] = roiFromYahoo(result, d);
      } catch (e) {
        for (const d of ROI_DAYS) out[key][d] = null;
      }
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/note-feed' && request.method === 'GET') {
        return handleNoteFeed();
      }
      if (url.pathname === '/api/shielded' && request.method === 'GET') {
        return handleShielded();
      }
      if (url.pathname === '/api/roi' && request.method === 'GET') {
        return handleRoi();
      }
      // Unknown API endpoint
      return new Response(
        JSON.stringify({ error: 'Not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Try to serve a static asset (index.html, CSS, images, etc.)
    const assetResponse = await env.ASSETS.fetch(request);

    // SPA fallback: if a "page-like" URL (e.g. /buy, /about) returned 404,
    // serve index.html instead so the client-side router can handle it.
    if (assetResponse.status === 404) {
      const hasFileExtension = /\.[a-z0-9]+$/i.test(url.pathname);
      if (!hasFileExtension) {
        const indexUrl = new URL('/', request.url);
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }
    }

    return assetResponse;
  }
};
