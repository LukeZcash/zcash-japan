// netlify/functions/shielded.js
// Netlify Function: fetches live Zcash shielded-pool balances from
// mainnet.zcashexplorer.app (the same upstream zecstats.com uses)
// and returns them as JSON. Endpoint (with redirect): /api/shielded

const SHIELDED_URL = 'https://mainnet.zcashexplorer.app/api/v1/blockchain-info';

exports.handler = async () => {
  try {
    const res = await fetch(SHIELDED_URL, {
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
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600'
      },
      body: JSON.stringify(body)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Unknown error' })
    };
  }
};
