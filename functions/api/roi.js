// functions/api/roi.js
// Cloudflare Pages Function: computes 1y/3y/5y ROI (vs USD) for ZEC, BTC and
// gold (PAXG) from CryptoCompare daily history, server-side with edge caching.
// Endpoint: /api/roi

const ROI_SYMS = [['zec', 'ZEC'], ['btc', 'BTC'], ['gold', 'PAXG']];
const ROI_DAYS = [365, 1095, 1825];

function calcRoi(daily, daysAgo) {
  if (!daily || daily.length < daysAgo + 1) return null;
  const end = daily.length - 1;
  const start = end - daysAgo;
  const s = daily[start] && daily[start].close;
  const e = daily[end] && daily[end].close;
  if (!s || s <= 0 || !e) return null;
  return Math.round(((e - s) / s) * 100);
}

export async function onRequestGet() {
  try {
    const out = {};
    for (const [key, fsym] of ROI_SYMS) {
      out[key] = {};
      try {
        const r = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${fsym}&tsym=USD&limit=1826`,
          { headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } }
        );
        const j = await r.json();
        const daily = (j && j.Data && j.Data.Data) ? j.Data.Data : null;
        for (const d of ROI_DAYS) out[key][d] = calcRoi(daily, d);
      } catch (e) {
        for (const d of ROI_DAYS) out[key][d] = null;
      }
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600'
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
