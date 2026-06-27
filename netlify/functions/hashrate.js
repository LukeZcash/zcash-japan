// netlify/functions/hashrate.js
// Netlify Function: fetches the live Zcash network hashrate from Blockchair
// (api.blockchair.com/zcash/stats) server-side to avoid browser CORS issues,
// and returns it as JSON. Endpoint (with redirect): /api/hashrate

const HASHRATE_URL = 'https://api.blockchair.com/zcash/stats';

exports.handler = async () => {
  try {
    const res = await fetch(HASHRATE_URL, {
      headers: { 'User-Agent': 'ZcashJapan-Worker/1.0' }
    });
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Upstream returned ${res.status}` })
      };
    }
    const data = await res.json();
    const hashrate =
      data && data.data && data.data.blockchain
        ? data.data.blockchain.hashrate_24h
        : null;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      },
      body: JSON.stringify({ hashrate: hashrate ? Number(hashrate) : null, updated: new Date().toISOString() })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Unknown error' })
    };
  }
};
