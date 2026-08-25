// _worker.js
// Cloudflare Workers entry for Zcash Japan (Workers + Static Assets mode)
// - Handles /api/note-feed by fetching note.com RSS
// - Falls through to static assets (index.html, etc.) for everything else

const RSS_URL = 'https://note.com/zcashjapan/rss';
const SHIELDED_URL = 'https://mainnet.zcashexplorer.app/api/v1/blockchain-info';
const HASHRATE_URL = 'https://api.blockchair.com/zcash/stats';
const CG = 'https://api.coingecko.com/api/v3';

// Keyless fallbacks for /api/market. CoinGecko's free tier throttles
// Cloudflare's egress IPs intermittently — often enough that a real share of
// visitors were landing on 「取得不可」 and a price chart still ending in 2025.
// None of these need an API key, and they are only called for the fields
// CoinGecko actually left null on this request.
const COINBASE_SPOT = 'https://api.coinbase.com/v2/prices';
const KRAKEN_OHLC = 'https://api.kraken.com/0/public/OHLC';
const BTC_SUPPLY_URL = 'https://blockchain.info/q/totalbc';

// Shielded-pool history. The page used to draw this from a hand-typed array
// that was out by as much as 126% (2025-01 claimed 4.2M against a real 1.86M)
// and stopped at 2026-05. Blockchair publishes the per-block shielded delta,
// so summing it by day and walking backwards from the live pool total
// reconstructs the real curve, and keeps reconstructing it.
const SHIELDED_DELTA_URL = 'https://api.blockchair.com/zcash/blocks'
  + '?a=date,sum(shielded_value_delta_total)&s=date(desc)&limit=1000';
const HISTORY_START = '2024-01';

async function handleShieldedHistory() {
  try {
    const [deltaRes, poolRes] = await Promise.all([
      fetchJson(SHIELDED_DELTA_URL, 3600),
      fetchJson(SHIELDED_URL, 600)
    ]);
    const rows = deltaRes && deltaRes.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('no delta rows');

    const pools = {};
    for (const p of (poolRes.valuePools || [])) pools[p.id] = p.chainValue;
    const current = ['ironwood', 'orchard', 'sapling', 'sprout']
      .reduce((sum, id) => sum + (pools[id] || 0), 0);
    if (!(current > 0)) throw new Error('no live pool total');

    // Blockchair returns newest first and reports zatoshi. Today's balance is
    // the live total; subtracting each day's delta steps back one day.
    const daily = rows
      .map(r => [r.date, Number(r['sum(shielded_value_delta_total)']) / 1e8])
      .filter(([d, v]) => d && Number.isFinite(v))
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));

    const monthly = new Map();
    let balance = current;
    for (const [date, delta] of daily) {
      // Last write per month wins, and dates descend, so this keeps month-end.
      const month = date.slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, Math.round(balance));
      balance -= delta;
    }

    const series = [...monthly.entries()]
      .filter(([m]) => m >= HISTORY_START)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (series.length < 2) throw new Error('series too short');

    return new Response(JSON.stringify({ series, updated: new Date().toISOString() }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600'
      }
    });
  } catch (err) {
    // The page keeps a real-but-frozen copy of this series, so failing loudly
    // here is better than serving a half-built curve.
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function fetchJson(url, ttl) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' },
    cf: { cacheTtlByStatus: { '200-299': ttl, '400-599': 0 }, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// Kraken keys its OHLC result by the venue's own pair name (XZECZUSD), so take
// whichever key is not the `last` cursor instead of hardcoding that spelling.
function krakenCloses(json) {
  const result = json && json.result;
  if (!result) return null;
  const key = Object.keys(result).find(k => k !== 'last');
  const rows = key ? result[key] : null;
  if (!Array.isArray(rows)) return null;
  const closes = rows.map(r => Number(r[4])).filter(n => Number.isFinite(n));
  return closes.length ? closes : null;
}

// `sources` maps each filled field to the upstreams behind it, so the page can
// say where a number actually came from instead of always crediting CoinGecko.
async function fillMarketGaps(body, sources) {
  const spot = async (pair) => {
    const j = await fetchJson(`${COINBASE_SPOT}/${pair}/spot`, 300);
    const n = Number(j && j.data && j.data.amount);
    return Number.isFinite(n) ? n : null;
  };

  const jobs = [];
  const assign = (field, names, fn) => { if (body[field] == null) jobs.push([field, names, fn]); };

  assign('price_usd', ['Coinbase'], () => spot('ZEC-USD'));
  assign('price_jpy', ['Coinbase'], () => spot('ZEC-JPY'));
  assign('btc_mcap_usd', ['Coinbase', 'blockchain.info'], async () => {
    const [price, satoshis] = await Promise.all([
      spot('BTC-USD'),
      fetch(BTC_SUPPLY_URL, { cf: { cacheTtl: 3600, cacheEverything: true } }).then(r => r.text())
    ]);
    const coins = Number(satoshis) / 1e8;
    return price && Number.isFinite(coins) ? price * coins : null;
  });
  assign('history', ['Kraken'], async () => {
    const closes = krakenCloses(await fetchJson(`${KRAKEN_OHLC}?pair=ZECUSD&interval=1440`, 3600));
    return closes ? closes.slice(-365) : null;
  });
  assign('change_24h', ['Kraken'], async () => {
    // Hourly candles give a true rolling 24h move. Daily closes would only give
    // the change since yesterday's close, which is a different number to label
    // "(24h)" with.
    const closes = krakenCloses(await fetchJson(`${KRAKEN_OHLC}?pair=ZECUSD&interval=60`, 300));
    if (!closes || closes.length < 25) return null;
    const now = closes[closes.length - 1];
    const dayAgo = closes[closes.length - 25];
    return dayAgo > 0 ? ((now - dayAgo) / dayAgo) * 100 : null;
  });

  const settled = await Promise.allSettled(jobs.map(([, , fn]) => fn()));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value != null) {
      const [field, names] = jobs[i];
      body[field] = r.value;
      sources[field] = names;
    }
  });

  // Market cap is derived last because it needs a price that may itself have
  // only just been filled in above. Circulating supply comes from the same
  // explorer /api/shielded already reads, so it costs no new upstream.
  if (body.zec_mcap_usd == null && body.price_usd != null) {
    try {
      const info = await fetchJson(SHIELDED_URL, 600);
      const supply = info && info.chainSupply ? Number(info.chainSupply.chainValue) : null;
      if (Number.isFinite(supply) && supply > 0) {
        body.zec_mcap_usd = body.price_usd * supply;
        // Credit whatever supplied the price, plus the explorer behind the supply.
        sources.zec_mcap_usd = [...(sources.price_usd || []), 'zcashexplorer'];
      }
    } catch (e) { /* leave null — the page carries its own last-resort value */ }
  }
  // `rank` has no keyless source; the page simply omits it when null.
  return body;
}

// CoinGecko, proxied server-side. The browser used to call CoinGecko directly,
// three times per page load, so a visitor behind a busy NAT could burn through
// the free tier's per-IP limit and land on the stale hardcoded fallbacks.
// Going through the Worker collapses that into one cached upstream call
// shared by every visitor, the same way shielded and hashrate already work.
async function handleMarket() {
  const get = async (path) => {
    const res = await fetch(CG + path, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' },
      // 429 をキャッシュすると、絞られた瞬間から10分間ずっと絞られたままになる
      cf: { cacheTtlByStatus: { '200-299': 600, '400-599': 0 }, cacheEverything: true }
    });
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    return res.json();
  };

  const [coin, btc, chart] = await Promise.allSettled([
    get('/coins/zcash?localization=false&tickers=false&community_data=false&developer_data=false'),
    get('/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true'),
    get('/coins/zcash/market_chart?vs_currency=usd&days=365')
  ]);

  // One upstream failing should not blank the whole card — report each part
  // on its own and let the page fall back only for what is actually missing.
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
  const sources = {};
  for (const f of Object.keys(body)) {
    if (f !== 'updated' && body[f] != null) sources[f] = ['CoinGecko'];
  }
  await fillMarketGaps(body, sources);

  // Collapse per-field origins into one list per card, in first-seen order.
  const providers = (fields) => {
    const out = [];
    for (const f of fields) for (const n of (sources[f] || [])) if (!out.includes(n)) out.push(n);
    return out;
  };
  body.sources = {
    price: providers(['price_usd', 'price_jpy', 'change_24h']),
    mcap: providers(['zec_mcap_usd', 'btc_mcap_usd', 'rank'])
  };

  // 欠けたレスポンスを10分キャッシュすると、その間ずっと全訪問者に欠けたまま配られる
  const complete = body.price_usd != null && body.btc_mcap_usd != null && body.history != null;
  const cache = complete ? 'public, max-age=600, s-maxage=600' : 'no-store';
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cache
    }
  });
}

// Network hashrate, proxied server-side to avoid browser CORS issues.
// One cached upstream call (Blockchair) shared by all visitors.
async function handleHashrate() {
  try {
    const res = await fetch(HASHRATE_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' },
      // 429 をキャッシュすると、絞られた瞬間から10分間ずっと絞られたままになる
      cf: { cacheTtlByStatus: { '200-299': 600, '400-599': 0 }, cacheEverything: true }
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const data = await res.json();
    // Blockchair returns the stats flat under `data` — there is no `blockchain` level.
    const hashrate = data && data.data ? data.data.hashrate_24h : null;
    return new Response(
      JSON.stringify({ hashrate: hashrate ? Number(hashrate) : null, updated: new Date().toISOString() }),
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

// Live shielded-pool data, proxied server-side to avoid browser CORS issues.
// Same upstream source that zecstats.com uses.
async function handleShielded() {
  try {
    const res = await fetch(SHIELDED_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' },
      // 429 をキャッシュすると、絞られた瞬間から10分間ずっと絞られたままになる
      cf: { cacheTtlByStatus: { '200-299': 600, '400-599': 0 }, cacheEverything: true }
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
      ironwood: pools.ironwood || 0,
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
      if (url.pathname === '/api/hashrate' && request.method === 'GET') {
        return handleHashrate();
      }
      if (url.pathname === '/api/market' && request.method === 'GET') {
        return handleMarket();
      }
      if (url.pathname === '/api/shielded-history' && request.method === 'GET') {
        return handleShieldedHistory();
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
