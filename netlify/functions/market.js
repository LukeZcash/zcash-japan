// netlify/functions/market.js
// Netlify Function: fetches ZEC price / market cap / rank, BTC market cap and a
// year of ZEC price history from CoinGecko, and returns them as one JSON
// payload. Endpoint (with redirect): /api/market
//
// The browser used to call CoinGecko directly, three times per page load, so a
// visitor behind a busy NAT could burn through the free tier's per-IP limit and
// land on the stale hardcoded fallbacks. Proxying collapses that into one
// cached upstream call shared by every visitor.

const CG = 'https://api.coingecko.com/api/v3';

exports.handler = async () => {
  const get = async (path) => {
    const res = await fetch(CG + path, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    return res.json();
  };

  const [coin, btc, chart] = await Promise.allSettled([
    get('/coins/zcash?localization=false&tickers=false&community_data=false&developer_data=false'),
    get('/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true'),
    get('/coins/zcash/market_chart?vs_currency=usd&days=365')
  ]);

  // One upstream failing should not blank the whole card — report each part on
  // its own and let the page fall back only for what is actually missing.
  const md = coin.status === 'fulfilled' ? coin.value.market_data : null;
  const body = {
    price_usd: md ? md.current_price.usd : null,
    price_jpy: md ? md.current_price.jpy : null,
    change_24h: md ? md.price_change_percentage_24h : null,
    zec_mcap_usd: md ? md.market_cap.usd : null,
    rank: coin.status === 'fulfilled' ? coin.value.market_cap_rank : null,
    btc_mcap_usd: btc.status === 'fulfilled' ? (btc.value.bitcoin || {}).usd_market_cap : null,
    history: chart.status === 'fulfilled' && Array.isArray(chart.value.prices)
      ? chart.value.prices.map(p => p[1]) : null,
    updated: new Date().toISOString()
  };
  // 欠けたレスポンスを10分キャッシュすると、その間ずっと全訪問者に欠けたまま配られる
  const complete = body.price_usd != null && body.btc_mcap_usd != null && body.history != null;
  const cache = complete ? 'public, max-age=600, s-maxage=600' : 'no-store';
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cache
    },
    body: JSON.stringify(body)
  };
};
