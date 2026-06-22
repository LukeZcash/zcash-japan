// functions/api/roi.js
// Cloudflare Pages Function: 1y/3y/5y ROI (vs USD) for ZEC, BTC, gold (GC=F)
// and the S&P 500 (^GSPC) from Yahoo Finance's keyless chart API, server-side
// with edge caching. Endpoint: /api/roi

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
  if (pastTs > target + 45 * 86400) return null;
  return Math.round(((latest - past) / past) * 100);
}

export async function onRequestGet() {
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
